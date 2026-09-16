/**
 * The Session Watchdog content sensor — the only script injected into
 * provider pages (`https://chat.z.ai/*` in shipped builds; the test
 * variant also matches the harness origin).
 *
 * It is a FACTS-ONLY surface with three bounded commands (background ->
 * content) and one announcement (content -> background on every load):
 *
 *   {cmd: "sw-snapshot"}          -> structural liveness + dialog + auth facts
 *   {cmd: "sw-server-probe", sessionId}
 *                                 -> same-origin chats-LIST probe (lesson 97:
 *                                    the LIST is the existence truth) + the
 *                                    chat detail for the placeholder fact
 *   {cmd: "sw-dismiss-dialog"}    -> clicks ONLY a cancel-vocabulary control
 *                                    inside the topmost visible dialog
 *
 *   announce "sw-content-ready" + snapshot on every page load.
 *
 * Laws encoded here (see DESIGN.md §2/§5):
 * - locators are the CTRL-014 LIVE-OBSERVED family; every fact degrades
 *   to an explicit null/absence (a rotted selector loses sensitivity, it
 *   can never manufacture a verdict);
 * - the auth read is the raw localStorage JWT payload (lesson 46: never
 *   JSON.parse the token; lesson 114: guest-*@guest.com = signed out);
 * - liveness is a MutationObserver, not innerText length (lesson 5:
 *   virtualized transcripts lie; lesson 84: mid-generation DOM collapse
 *   is normal);
 * - dialogs are dismissed ONLY via the cancel vocabulary (operator rules
 *   2026-09-12: never the popup's own instructions, never model switches,
 *   never captcha sliders — the captcha popup is reported, not touched);
 * - the server probe uses the page's own credentials (Bearer token,
 *   same-origin) and NEVER transmits them anywhere else.
 */

(function () {
  "use strict";

  /* global chrome, document, window, MutationObserver, MutationRecord,
            fetch, localStorage, setTimeout, requestAnimationFrame */

  const CMD = {
    SNAPSHOT: "sw-snapshot",
    SERVER_PROBE: "sw-server-probe",
    DISMISS_DIALOG: "sw-dismiss-dialog",
  };

  // CTRL-014 ZAI_LOCATORS — LIVE-OBSERVED on the real provider surface
  // (verified live again on 2026-09-16: composer/send/modelTrigger/sidebar
  // all matched; the Stop family matches while a turn is open).
  const LOC = {
    composer: "#chat-input",
    send: "#send-message-button",
    stopControl: [
      '[data-tooltip-trigger][aria-label="Stop"] button',
      '[data-tooltip-trigger][aria-label^="The current task is in progress"] button',
      'button[aria-label="Stop"]',
      'button[title="Stop"]',
    ],
    regenerate: '[data-tooltip-trigger][aria-label="Regenerate"] button',
    dialog: '[role="dialog"], dialog',
    assistantRow: ".chat-assistant",
    userMessage: [
      '[class*="user"][class*="message"]',
      '[data-role="user"]',
      '[class*="user-message"]',
    ],
    humanVerificationPopup: "#aliyunCaptcha-window-popup",
  };

  // The cancel vocabulary (operator rule: Cancel only). The dismissible
  // check ALSO refuses "switch"-labelled controls (never GLM-5.3-Flash).
  const CANCEL_WORDS = ["cancel", "dismiss", "close", "取消", "关闭"];
  const FORBIDDEN_WORDS = ["switch", "切换", "continue", "ok", "确认", "accept"];

  let lastMutationAt = Date.now();
  let observer = null;
  let announceTimer = null;

  function startMutationObserver() {
    try {
      if (observer) observer.disconnect();
      lastMutationAt = Date.now();
      let pending = false;
      observer = new MutationObserver((records) => {
        if (!records || records.length === 0) return;
        if (pending) return;
        pending = true;
        // throttle: coalesce bursts into one mutation timestamp
        setTimeout(() => {
          pending = false;
          lastMutationAt = Date.now();
        }, 250);
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    } catch {
      observer = null; // sensor degrades: lastMutationAt simply stops moving
    }
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    } catch {
      return false;
    }
  }

  function queryAll(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector), 0, 50);
    } catch {
      return [];
    }
  }

  function firstVisible(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      const hit = queryAll(sel).filter(visible);
      if (hit.length > 0) return hit[0];
    }
    return null;
  }

  /** The open-turn signal: the Stop control family (CTRL-014 cont. 11). */
  function readTurnOpen() {
    for (const sel of LOC.stopControl) {
      const hits = queryAll(sel).filter(visible);
      if (hits.length > 0) return true;
    }
    // Corroboration (cheaper, never sole verdict): composer present but
    // disabled + the send control absent. Absence of everything = null.
    const composer = firstVisible(LOC.composer);
    const send = firstVisible(LOC.send);
    if (composer && send) {
      const disabled =
        composer.disabled === true ||
        composer.getAttribute("aria-disabled") === "true";
      if (disabled) return true;
      return false;
    }
    if (composer && !send) return true; // slot swapped to Stop
    if (!composer) return null; // unknown surface — fail-safe
    return false;
  }

  function readDialog() {
    const dialogs = queryAll(LOC.dialog).filter(visible);
    if (dialogs.length === 0) return { present: false };
    // topmost = last in document order among visible
    const top = dialogs[dialogs.length - 1];
    const text = (top.textContent || "").trim().slice(0, 400);
    const buttons = Array.prototype.slice
      .call(top.querySelectorAll("button, [role='button']"), 0, 30)
      .filter(visible);
    const cancelCandidates = buttons.filter((b) => {
      const label = (
        (b.getAttribute("aria-label") || "") +
        " " +
        (b.textContent || "")
      ).trim().toLowerCase();
      if (!label) return false;
      if (FORBIDDEN_WORDS.some((w) => label.includes(w))) return false;
      return CANCEL_WORDS.some((w) => label.includes(w));
    });
    return {
      present: true,
      text,
      dismissible: cancelCandidates.length > 0,
    };
  }

  function readAuth() {
    try {
      const token = localStorage.getItem("token") || "";
      if (!token) return { state: "signed-out", email: null };
      const parts = token.split(".");
      if (parts.length < 2) return { state: "signed-out", email: null };
      let payload = null;
      try {
        payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      } catch {
        return { state: "signed-out", email: null };
      }
      const email = payload && typeof payload.email === "string" ? payload.email : null;
      if (!email || /^guest-/i.test(email)) {
        return { state: "signed-out", email };
      }
      return { state: "signed-in", email };
    } catch {
      return { state: "unknown" };
    }
  }

  function sessionIdFromLocation() {
    const m = /^\/c\/([0-9a-fA-F-]{6,64})(?:\/.*)?$/.exec(
      window.location.pathname
    );
    return m ? m[1] : null;
  }

  function buildSnapshot() {
    const dialog = readDialog();
    return {
      ok: true,
      sessionId: sessionIdFromLocation(),
      url: window.location.href,
      turnOpen: readTurnOpen(),
      lastMutationAt,
      dialog,
      humanVerification: queryAll(LOC.humanVerificationPopup).filter(visible).length > 0,
      auth: readAuth(),
      ts: Date.now(),
    };
  }

  /* ─────────────── the server-side probe (lesson 46/97) ─────────────── */

  async function serverProbe(sessionId) {
    const auth = readAuth();
    if (auth.state !== "signed-in") {
      return { ok: false, error: "auth-required" };
    }
    let token = "";
    try {
      token = localStorage.getItem("token") || "";
    } catch {
      return { ok: false, error: "no-token" };
    }
    const headers = { Authorization: "Bearer " + token };
    const out = { ok: true, exists: false, updatedAt: null, hasAssistantPlaceholder: null };
    try {
      // THE EXISTENCE TRUTH: the LIST (lessons 97, 99). Trailing-slash
      // form is the flapping-route workaround family (lesson 51).
      const listRes = await fetch("/api/v1/chats/list?limit=100", {
        headers,
        credentials: "include",
      });
      if (!listRes.ok) {
        return { ok: false, error: "list-http-" + listRes.status };
      }
      const raw = await listRes.text();
      let items = null;
      try {
        const parsed = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed : parsed && parsed.data && Array.isArray(parsed.data) ? parsed.data : null;
      } catch {
        return { ok: false, error: "list-not-json" };
      }
      if (!items) return { ok: false, error: "list-shape" };
      const wanted = String(sessionId || "");
      const hit = items.find((c) => {
        const id = c && typeof c.id === "string" ? c.id : "";
        return id === wanted || id.replace(/^chat-/, "") === wanted;
      });
      out.exists = !!hit;
      if (hit && typeof hit.updated_at === "string") {
        out.updatedAt = Date.parse(hit.updated_at) || null;
      }
      if (hit && typeof hit.updatedAt === "number") {
        out.updatedAt = hit.updatedAt;
      }
      if (out.exists) {
        // placeholder fact (lesson 48): walk the detail tree best-effort;
        // ANY failure degrades to null (no verdict from this fact).
        try {
          const bare = wanted.replace(/^chat-/, "");
          const detRes = await fetch("/api/v1/chats/" + bare, {
            headers,
            credentials: "include",
          });
          if (detRes.ok) {
            const det = await detRes.json();
            const chat = det && det.chat ? det.chat : det;
            const messages =
              chat &&
              chat.history &&
              chat.history.messages &&
              typeof chat.history.messages === "object"
                ? chat.history.messages
                : null;
            if (messages) {
              const rows = Object.values(messages);
              const assistantRows = rows.filter(
                (m) => m && m.role === "assistant"
              );
              if (assistantRows.length > 0) {
                const anyWithContent = assistantRows.some(
                  (m) =>
                    (typeof m.content === "string" && m.content.length > 0) ||
                    (Array.isArray(m.content) && m.content.length > 0)
                );
                // hasAssistantPlaceholder === false only when EVERY
                // assistant row is content-less (the lesson-48 shape).
                out.hasAssistantPlaceholder = anyWithContent;
              } else {
                out.hasAssistantPlaceholder = false;
              }
            }
          }
        } catch {
          /* detail degraded — exists (LIST) is still the truth */
        }
      }
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ─────────────── the bounded dismissal (Cancel only) ─────────────── */

  function dismissDialog() {
    const dialog = readDialog();
    if (!dialog.present) return { ok: false, error: "no-dialog" };
    if (!dialog.dismissible) return { ok: false, error: "no-cancel-control" };
    const dialogs = queryAll(LOC.dialog).filter(visible);
    const top = dialogs[dialogs.length - 1];
    if (!top) return { ok: false, error: "dialog-vanished" };
    const buttons = Array.prototype.slice
      .call(top.querySelectorAll("button, [role='button']"), 0, 30)
      .filter(visible);
    for (const b of buttons) {
      const label = (
        (b.getAttribute("aria-label") || "") +
        " " +
        (b.textContent || "")
      ).trim().toLowerCase();
      if (!label) continue;
      if (FORBIDDEN_WORDS.some((w) => label.includes(w))) continue;
      if (CANCEL_WORDS.some((w) => label.includes(w))) {
        try {
          b.click();
          return { ok: true, clicked: label.slice(0, 40) };
        } catch {
          /* try the next candidate */
        }
      }
    }
    return { ok: false, error: "click-refused" };
  }

  /* ─────────────── wiring ─────────────── */

  function announce() {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const snap = buildSnapshot();
      try {
        chrome.runtime.sendMessage(
          { evt: "sw-content-ready", snapshot: snap },
          () => {
            // consume any lastError so the console stays clean
            void chrome.runtime.lastError;
          }
        );
      } catch {
        /* background may be asleep — the tick will find us */
      }
    }, 1200);
  }

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.cmd) {
      case CMD.SNAPSHOT:
        sendResponse(buildSnapshot());
        return;
      case CMD.SERVER_PROBE:
        serverProbe(msg.sessionId)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true; // async
      case CMD.DISMISS_DIALOG:
        sendResponse(dismissDialog());
        return;
      default:
        return;
    }
  }

  function boot() {
    startMutationObserver();
    announce();
    try {
      chrome.runtime.onMessage.addListener(onMessage);
    } catch {
      /* extension context gone (update/reload) — page reload re-arms */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
