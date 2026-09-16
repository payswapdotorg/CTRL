/**
 * The alert engine (v1.1 — operator 2026-10-14): "make sure it rings an
 * alarm on my laptop (running ubuntu) and/or sends me an email at
 * team@payswap.org when a session returns or when it failed to recover
 * a session."
 *
 * Channels, in escalation order:
 *   - OS notification (chrome.notifications; on Ubuntu via the desktop
 *     notification stack) — with a "Silence alarm" button on Chrome
 *   - AUDIO ALARM: a looping siren (failure kinds) or a short chime
 *     (the watchdog acted) — played through a chrome.offscreen document
 *     (Chrome/Opera); Firefox degrades to a visible alarm TAB with the
 *     same sound + a STOP button
 *   - EMAIL via the Brevo API (free tier; the operator's API key is
 *     stored locally and REDACTED in every diagnostic export)
 *   - optional generic webhook + optional ntfy.sh topic (zero-setup push)
 *
 * Laws (DESIGN §7):
 *   - never throw into the ladder: every channel is fire-and-forget with
 *     its outcome logged into the global event ring;
 *   - the siren LOOPS until a human acknowledges (notification button,
 *     popup, or the alarm tab) and re-rings on a repeat alarm; it
 *     hard-stops after ALARM_HARD_STOP_MS even if nobody answers;
 *   - the chime is bounded (three beeps) — it says "handled", not "help";
 *   - secrets never leave the machine except to their own service.
 */

import { ALARMS, ALARM_SIREN_KINDS, ALARM_CHIME_KINDS, ALARM_HARD_STOP_MS } from "../protocol.js";

/**
 * Build the alert engine over a browser namespace.
 * @param {object} ns                chrome | browser | test fake
 * @param {() => object} getSettings live settings getter
 * @param {(kind:string, detail:string, sessionId?:string) => void} log
 *        the global event ring writer (background's globalEvent)
 */
export function makeNotify(ns, getSettings, log) {
  const notifications = ns && ns.notifications;
  const alarms = ns && ns.alarms;
  const runtime = ns && ns.runtime;
  const tabs = ns && ns.tabs;
  const offscreen = ns && ns.offscreen;
  // Chrome/Opera have no runtime.getBrowserInfo; Firefox does.
  const isChrome = !!(runtime && typeof runtime.getBrowserInfo !== "function");

  /** null | {level:'siren'|'chime', label, kind, startedAt, nid} */
  let active = null;
  let offscreenReady = false;
  let alarmTabId = null;

  const OFFSCREEN_URL =
    runtime && typeof runtime.getURL === "function"
      ? runtime.getURL("offscreen/alarm.html")
      : null;

  /* ─────────────── the OS notification ─────────────── */

  function osNotification(id, title, message, withButton) {
    if (!notifications || !notifications.create) return null;
    try {
      const opts = {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: title || "Session Watchdog",
        message: String(message || "").slice(0, 280),
      };
      if (isChrome) {
        // requireInteraction keeps failure alerts on screen until dismissed
        opts.requireInteraction = true;
        if (withButton) opts.buttons = [{ title: "Silence alarm" }];
      }
      notifications.create(id, opts);
      return id;
    } catch {
      return null;
    }
  }

  if (notifications && notifications.onButtonClicked && notifications.onButtonClicked.addListener) {
    notifications.onButtonClicked.addListener((nid) => {
      if (active && String(nid).indexOf("sw-alarm-") === 0) acknowledge("notification-button");
    });
  }

  /* ─────────────── the audio alarm ─────────────── */

  async function ensureOffscreen() {
    if (!offscreen || !offscreen.createDocument || !OFFSCREEN_URL) return false;
    try {
      const has = await new Promise((resolve) => {
        try {
          offscreen.hasDocument().then(resolve, () => resolve(false));
        } catch {
          resolve(false);
        }
      });
      if (!has) {
        await offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Play the session-watchdog alarm until a human acknowledges it",
        });
        await new Promise((r) => setTimeout(r, 350)); // let its listener arm
      }
      return true;
    } catch {
      return false;
    }
  }

  async function openAlarmTab(level, label) {
    if (!tabs || !tabs.create || !OFFSCREEN_URL) return false;
    try {
      const t = await new Promise((resolve) => {
        tabs.create({ url: `${OFFSCREEN_URL}?level=${level}&label=${encodeURIComponent(label || "")}`, active: true }, resolve);
      });
      alarmTabId = t && typeof t.id === "number" ? t.id : null;
      return true;
    } catch {
      return false;
    }
  }

  async function sound(level, label) {
    // Chrome/Opera: the invisible offscreen document owns the sound.
    if (await ensureOffscreen()) {
      try {
        runtime.sendMessage({ cmd: "sw-alarm-start", level, label }, () => {
          void runtime.lastError;
        });
        return;
      } catch {
        /* fall through to the tab */
      }
    }
    // Firefox / offscreen failure: a visible, flashing alarm tab.
    await openAlarmTab(level, label);
  }

  function stopSound() {
    if (runtime && typeof runtime.sendMessage === "function") {
      try {
        runtime.sendMessage({ cmd: "sw-alarm-stop" }, () => {
          try { void runtime.lastError; } catch { /* not readable here */ }
        });
      } catch {
        /* the doc may already be gone */
      }
    }
    if (alarmTabId !== null && tabs && tabs.remove) {
      try {
        tabs.remove(alarmTabId, () => {
          try { if (runtime) void runtime.lastError; } catch { /* ignore */ }
        });
      } catch {
        /* best effort */
      }
      alarmTabId = null;
    }
  }

  // NOTE: no runtime.onMessage listener is registered here — the alarm
  // page's sw-alarm-ready / sw-alarm-ack events are routed by the
  // background's single listener (one bus, one responder, no ordering
  // surprises for the smoke harness).

  /* ─────────────── the repeat ring ─────────────── */

  function armRepeat() {
    if (!alarms || !alarms.create || !active) return;
    const minutes = getSettings().alarmRepeatMinutes;
    if (!minutes) return;
    try {
      alarms.create(ALARMS.REPEAT, { periodInMinutes: Math.max(1, minutes), delayInMinutes: Math.max(1, minutes) });
    } catch {
      /* repeat is best-effort */
    }
  }

  function clearRepeat() {
    if (!alarms || !alarms.clear) return;
    try {
      alarms.clear(ALARMS.REPEAT, () => void runtime.lastError);
    } catch {
      /* best effort */
    }
  }

  /* ─────────────── the async channels (email/webhook/ntfy) ─────────────── */

  async function sendEmail(subject, text) {
    const s = getSettings();
    if (!s.emailEnabled || !s.emailApiKey) return { sent: false, reason: "email-not-configured" };
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": s.emailApiKey, "content-type": "application/json" },
        body: JSON.stringify({
          sender: { name: "Session Watchdog", email: s.emailFrom },
          to: [{ email: s.emailTo }],
          subject: String(subject).slice(0, 200),
          textContent: String(text).slice(0, 5000),
        }),
      });
      if (res.ok) return { sent: true };
      const body = await res.text().catch(() => "");
      return { sent: false, reason: `brevo-http-${res.status} ${String(body).slice(0, 120)}` };
    } catch (e) {
      return { sent: false, reason: String((e && e.message) || e) };
    }
  }

  async function postWebhook(payload) {
    const s = getSettings();
    if (!s.webhookUrl) return { sent: false, reason: "webhook-not-configured" };
    try {
      const res = await fetch(s.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok ? { sent: true } : { sent: false, reason: `webhook-http-${res.status}` };
    } catch (e) {
      return { sent: false, reason: String((e && e.message) || e) };
    }
  }

  async function postNtfy(title, message, priority) {
    const s = getSettings();
    if (!s.ntfyTopic) return { sent: false, reason: "ntfy-not-configured" };
    try {
      const res = await fetch(`https://ntfy.sh/${s.ntfyTopic}`, {
        method: "POST",
        headers: { Title: String(title).slice(0, 100), Priority: priority },
        body: String(message).slice(0, 3000),
      });
      return res.ok ? { sent: true } : { sent: false, reason: `ntfy-http-${res.status}` };
    } catch (e) {
      return { sent: false, reason: String((e && e.message) || e) };
    }
  }

  function asyncChannels(kind, label, message, session) {
    const subject = `[watchdog] ${kind}: ${label}`;
    const text = [
      `Session Watchdog alert (${kind})`,
      ``,
      `Session: ${label}`,
      message,
      ``,
      `Session URL: ${(session && session.sessionUrl) || "?"}`,
      `Time: ${new Date().toISOString()}`,
      ``,
      `-- Session Watchdog (sent automatically; acknowledge in the popup or the notification)`,
    ].join("\n");
    const payload = {
      source: "session-watchdog",
      kind,
      label,
      message,
      sessionUrl: (session && session.sessionUrl) || null,
      ts: Date.now(),
    };
    sendEmail(subject, text).then((r) => {
      log("email", r.sent ? `email sent to ${getSettings().emailTo} (${kind})` : `email failed: ${r.reason}`, session && session.sessionId);
    });
    postWebhook(payload).then((r) => {
      if (r.sent) log("webhook", `webhook delivered (${kind})`, session && session.sessionId);
      else if (r.reason !== "webhook-not-configured") log("webhook", `webhook failed: ${r.reason}`, session && session.sessionId);
    });
    const urgent = ALARM_SIREN_KINDS.indexOf(kind) !== -1;
    postNtfy(subject, text, urgent ? "urgent" : "default").then((r) => {
      if (r.sent) log("ntfy", `ntfy pushed (${kind})`, session && session.sessionId);
      else if (r.reason !== "ntfy-not-configured") log("ntfy", `ntfy failed: ${r.reason}`, session && session.sessionId);
    });
  }

  /* ─────────────── the public surface ─────────────── */

  return {
    /** Fire every channel for one (already throttled) notification. */
    dispatch(kind, label, message, session) {
      const s = getSettings();
      if (!s.notify) return;
      const nid = `sw-alarm-${kind}-${Date.now()}`;
      osNotification(nid, "Session Watchdog — " + label, message, true);
      const siren = ALARM_SIREN_KINDS.indexOf(kind) !== -1;
      const chime = ALARM_CHIME_KINDS.indexOf(kind) !== -1 && s.alarmOnRelaunch;
      if (s.alarmEnabled && (siren || chime)) {
        const level = siren ? "siren" : "chime";
        // LAST-SIREN-WINS: a new failure replaces whatever is ringing —
        // the most recent incident is the one the operator needs to see.
        // A chime never interrupts a siren.
        const take = siren || !active;
        if (take) {
          active = { level, label, kind, startedAt: Date.now(), nid };
          sound(level, label);
          if (siren) armRepeat();
        }
      }
      asyncChannels(kind, label, message, session);
    },

    /** The repeat alarm re-rings an unacknowledged siren. */
    repeat() {
      if (!active) {
        clearRepeat();
        return;
      }
      if (Date.now() - active.startedAt > ALARM_HARD_STOP_MS) {
        acknowledge("hard-stop");
        return;
      }
      osNotification(`sw-alarm-repeat-${Date.now()}`, `ALARM still on: ${active.label}`, `${active.kind} is unacknowledged — the watchdog needs you.`, true);
      sound(active.level, active.label);
    },

    /** The offscreen/alarm document announced itself (routed by background). */
    offscreenReady() {
      offscreenReady = true;
    },

    /** A human acknowledged the alarm (button / popup / alarm tab). */
    acknowledge(via) {
      if (!active) return false;
      const was = active;
      active = null;
      offscreenReady = false;
      stopSound();
      clearRepeat();
      log("alarm-ack", `alarm acknowledged via ${via || "manual"} (${was.kind}: ${was.label})`);
      return true;
    },

    alarmInfo() {
      return active
        ? { active: true, level: active.level, kind: active.kind, label: active.label, startedAt: active.startedAt }
        : { active: false };
    },

    /** Settings "test alarm" — ring a 6s test siren. */
    async testAlarm() {
      active = { level: "siren", label: "TEST ALARM", kind: "test", startedAt: Date.now(), nid: "sw-alarm-test" };
      await sound("siren", "TEST ALARM");
      osNotification("sw-alarm-test", "Session Watchdog — test", "This is what the alarm sounds like. It will auto-stop in a few seconds.", false);
      const t = setTimeout(() => {
        if (active && active.kind === "test") acknowledge("test-timeout");
      }, 6000);
      try {
        if (t && typeof t.unref === "function") t.unref();
      } catch {
        /* unref is a nicety for node-style runtimes */
      }
      return { ok: true };
    },

    /** Settings "test email" — returns the provider's verdict. */
    async testEmail() {
      const r = await sendEmail(
        "[watchdog] test alert",
        "This is a test email from the Session Watchdog. If you can read this, the email channel works.\n\n-- Session Watchdog"
      );
      log("email", r.sent ? "test email sent" : `test email failed: ${r.reason}`);
      return r;
    },

    /** Boot hygiene: a service-worker restart invalidates sound state. */
    onBoot() {
      active = null;
      offscreenReady = false;
      clearRepeat();
    },
  };
}
