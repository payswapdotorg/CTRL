/**
 * The Session Watchdog background (service worker / event page).
 *
 * Wiring only: it gathers facts, calls the PURE ladder (recovery.js
 * planAction), executes the returned plan through the API wrapper, and
 * persists. Every policy decision lives in the ladder; every lesson
 * citation lives there too.
 */

import { makeApi } from "../api.js";
import {
  STATUS, CMD, EVT, KEYS, ALARMS, NOTIFY_COOLDOWN_MS,
  DEFAULT_SETTINGS, normalizeSettings, classifyUrl,
} from "../protocol.js";
import {
  createSessionRecord, pushSessionEvent, resetIncident,
  resetRelaunchBudget, mayNotify, markNotified, boundSessions,
  sessionUrlFromTab,
} from "../state.js";
import { planAction, ACTION } from "../recovery.js";

const api = makeApi(globalThis.chrome || globalThis.browser);

/** Boot grace: tab-missing verdicts wait out browser-startup tab restore. */
const BOOT_GRACE_MS = 90 * 1000;
let bootedAt = Date.now();

/** In-memory cache of persisted state (single writer: this worker). */
let settings = normalizeSettings(null);
let sessions = {}; // sessionUrl -> record
let globalEvents = [];
let persistScheduled = false;

/* ────────────────────────── persistence ────────────────────────── */

async function loadState() {
  const [settingsRaw, sessionsRaw, eventsRaw] = await Promise.all([
    api.storage.get(KEYS.SETTINGS),
    api.storage.get(KEYS.SESSIONS),
    api.storage.get(KEYS.EVENTS),
  ]);
  settings = normalizeSettings(settingsRaw && settingsRaw[KEYS.SETTINGS]);
  const storedSessions = (sessionsRaw && sessionsRaw[KEYS.SESSIONS]) || {};
  sessions = {};
  for (const [url, rec] of Object.entries(storedSessions)) {
    if (rec && typeof rec === "object" && typeof rec.sessionUrl === "string") {
      sessions[url] = rec;
    }
  }
  globalEvents = Array.isArray(eventsRaw && eventsRaw[KEYS.EVENTS])
    ? eventsRaw[KEYS.EVENTS].slice(-200)
    : [];
}

function persist() {
  if (persistScheduled) return;
  persistScheduled = true;
  queueMicrotask(async () => {
    persistScheduled = false;
    try {
      await api.storage.set({
        [KEYS.SETTINGS]: settings,
        [KEYS.SESSIONS]: boundSessions(sessions),
        [KEYS.EVENTS]: globalEvents.slice(-200),
      });
    } catch {
      /* storage hiccups surface on the next persist */
    }
  });
}

function globalEvent(kind, detail, sessionId) {
  globalEvents.push({ ts: Date.now(), kind, detail: String(detail || ""), sessionId: sessionId || "" });
  if (globalEvents.length > 200) globalEvents.splice(0, globalEvents.length - 200);
  persist();
}

/* ────────────────────────── notifications ────────────────────────── */

function notify(session, planNotify) {
  if (!planNotify || !settings.notify) return;
  const kind = planNotify.kind || "info";
  const cooldown = NOTIFY_COOLDOWN_MS[kind] || 10 * 60 * 1000;
  const now = Date.now();
  if (!mayNotify(session, kind, now, cooldown)) return;
  markNotified(session, kind, now);
  api.notifications.create(`sw-${session.sessionId}-${kind}-${now}`, {
    title: "Session Watchdog",
    message: planNotify.message,
  });
  globalEvent("notify", planNotify.message, session.sessionId);
}

/* ────────────────────────── badge ────────────────────────── */

function updateBadge() {
  const armed = Object.values(sessions).filter((s) => s.armed);
  const alerts = armed.filter((s) =>
    [STATUS.DEAD, STATUS.WEDGED, STATUS.FROZEN, STATUS.AUTH_REQUIRED, STATUS.STALLED].includes(s.status)
  );
  if (alerts.length > 0) {
    api.action.setBadge("!", "#e11d48");
  } else if (armed.length > 0) {
    api.action.setBadge(String(Math.min(armed.length, 99)), "#059669");
  } else {
    api.action.setBadge("", "#059669");
  }
}

/* ────────────────────────── fact gathering ────────────────────────── */

async function tabFact(session) {
  if (typeof session.tabId !== "number" || session.tabId < 0) {
    // try rebind by URL before declaring the tab gone
    const tabs = await api.tabs.query({ url: `${settings.providerOrigin}/c/*` });
    const match = tabs.find((t) => {
      const f = sessionUrlFromTab(t.url, settings.providerOrigin);
      return f && f.sessionId === session.sessionId;
    });
    if (match) {
      session.tabId = match.id;
      return { exists: true, id: match.id, url: match.url, title: match.title || "" };
    }
    return null;
  }
  const t = await api.tabs.get(session.tabId);
  if (t.exists) return t;
  // tabId stale — try rebind by URL (chat id may have rolled: match record URL too)
  const tabs = await api.tabs.query({ url: `${settings.providerOrigin}/c/*` });
  const match = tabs.find((t2) => {
    const f = sessionUrlFromTab(t2.url, settings.providerOrigin);
    return f && (f.sessionId === session.sessionId || t2.url === session.sessionUrl);
  });
  if (match) {
    session.tabId = match.id;
    return { exists: true, id: match.id, url: match.url, title: match.title || "" };
  }
  return null;
}

async function snapshotFact(session) {
  if (typeof session.tabId !== "number" || session.tabId < 0) return { snap: null, err: "no-tab" };
  const r = await api.sendToTab(session.tabId, { cmd: CMD.SNAPSHOT }, 8000);
  if (r && r.ok) return { snap: r, err: null };
  return { snap: null, err: r && r.error ? r.error : "no-answer" };
}

async function serverProbeFact(session) {
  if (typeof session.tabId !== "number" || session.tabId < 0) return { ok: false };
  const r = await api.sendToTab(
    session.tabId,
    { cmd: CMD.SERVER_PROBE, sessionId: session.sessionId },
    10000
  );
  if (r && r.ok) return r;
  return { ok: false, error: r && r.error ? r.error : "no-answer" };
}

/* ────────────────────────── plan execution ────────────────────────── */

function applyPlanMeta(session, plan) {
  const now = Date.now();
  if (plan.status) session.status = plan.status;
  if (plan.resetIncident) {
    const wasUnhealthy = ![STATUS.LIVE, STATUS.IDLE, STATUS.WATCHING].includes(session.status);
    resetIncident(session);
    if (wasUnhealthy) resetRelaunchBudget(session);
  }
  if (plan.unreachableReload) session.unreachableReloads = (session.unreachableReloads || 0) + 1;
  if (plan.freezeReload) session.freezeReloads = (session.freezeReloads || 0) + 1;
  if (plan.freshTab) session.freshTabs = (session.freshTabs || 0) + 1;
  if (plan.relaunchAttempt) {
    session.relaunchAttempts = (session.relaunchAttempts || 0) + 1;
    session.lastRelaunchAt = now;
  }
  if (plan.returnDeferral) session.returnDeferrals = (session.returnDeferrals || 0) + 1;
  if (typeof plan.observeServer === "number") session.observedServerUpdatedAt = plan.observeServer;
  if (typeof plan.setQueuedSince === "number") session.queuedSince = plan.setQueuedSince;
  if (plan.roll) {
    session.sessionId = plan.roll.sessionId;
    session.sessionUrl = plan.roll.sessionUrl;
  }
  for (const e of plan.events || []) pushSessionEvent(session, e);
  if ((plan.events || []).length > 0 || plan.action !== ACTION.NONE) {
    session.lastCheckAt = now;
  }
}

async function executePlan(session, plan) {
  const now = Date.now();
  switch (plan.action) {
    case ACTION.RELOAD: {
      await api.tabs.reload(session.tabId);
      session.lastActionAt = now;
      globalEvent("reload", `${session.sessionId}: ${plan.reason}`, session.sessionId);
      break;
    }
    case ACTION.NAVIGATE_BACK: {
      await api.tabs.update(session.tabId, { url: session.sessionUrl });
      session.lastActionAt = now;
      globalEvent("navigate-back", `${session.sessionId}: ${plan.reason}`, session.sessionId);
      break;
    }
    case ACTION.FRESH_TAB: {
      const old = await api.tabs.get(session.tabId);
      const created = await api.tabs.create({
        url: session.sessionUrl,
        active: false,
        pinned: false,
      });
      if (created && typeof created.id === "number") {
        if (old && old.exists) await api.tabs.remove(session.tabId).catch(() => {});
        session.tabId = created.id;
        session.lastActionAt = now;
        globalEvent("fresh-tab", `${session.sessionId}: ${plan.reason}`, session.sessionId);
      }
      break;
    }
    case ACTION.REOPEN: {
      const created = await api.tabs.create({ url: session.sessionUrl, active: false });
      if (created && typeof created.id === "number") {
        session.tabId = created.id;
        session.lastActionAt = now;
        globalEvent("reopen", `${session.sessionId}: ${plan.reason}`, session.sessionId);
      }
      break;
    }
    case ACTION.DISMISS: {
      const r = await api.sendToTab(session.tabId, { cmd: CMD.DISMISS_DIALOG }, 5000);
      globalEvent(
        "dismiss",
        `${session.sessionId}: dialog dismiss ${r && r.ok ? "ok" : "refused"}`,
        session.sessionId
      );
      break;
    }
    default:
      break;
  }
  if (plan.notify) notify(session, plan.notify);
}

/* ────────────────────────── the tick ────────────────────────── */

async function checkSession(session) {
  const now = Date.now();
  session.lastCheckAt = now;

  const tab = await tabFact(session);
  if (!tab && now - bootedAt < BOOT_GRACE_MS) {
    // browser may still be restoring tabs — never reopen during the grace
    return;
  }

  let snap = null;
  let snapErr = null;
  if (tab && tab.exists && classifyUrl(tab.url, settings.providerOrigin).kind === "session") {
    const f = await snapshotFact(session);
    snap = f.snap;
    snapErr = f.err;
  } else if (tab && tab.exists) {
    // off-session provider page: the sensor still runs there (return path
    // needs its auth + server probe) — take a snapshot for those facts.
    const f = await snapshotFact(session);
    snap = f.snap;
    snapErr = f.err;
  }

  // absorb fresh sensor facts into the record
  if (snap) {
    session.turnOpen = snap.turnOpen === true ? true : snap.turnOpen === false ? false : null;
    if (typeof snap.lastMutationAt === "number") session.lastMutationAt = snap.lastMutationAt;
    if (snap.auth && typeof snap.auth.state === "string") session.authState = snap.auth.state;
    session.dialogPresent = !!(snap.dialog && snap.dialog.present);
  }

  const base = { now, settings, session, tab, snapshot: snap, snapshotError: snapErr, providerOrigin: settings.providerOrigin };
  let plan = planAction(base);

  if (plan.probe) {
    const probe = await serverProbeFact(session);
    plan = planAction({ ...base, serverProbe: probe });
  }

  applyPlanMeta(session, plan);
  await executePlan(session, plan);
  // verdict trail: record every verdict CHANGE (deduped) — the honest
  // story of what the ladder decided and when
  if (plan.reason && session.lastReason !== plan.reason) {
    session.lastReason = plan.reason;
    pushSessionEvent(session, {
      ts: Date.now(),
      kind: "verdict",
      detail: plan.reason,
    });
  }
}

async function tick() {
  if (!settings.enabled) return;
  const armed = Object.values(sessions).filter((s) => s.armed);
  for (const session of armed) {
    try {
      await checkSession(session);
    } catch (e) {
      pushSessionEvent(session, { ts: Date.now(), kind: "error", detail: String(e && e.message ? e.message : e) });
    }
  }
  // autoWatch: arm any provider session tab not yet tracked
  if (settings.autoWatch) {
    const tabs = await api.tabs.query({ url: `${settings.providerOrigin}/c/*` });
    for (const t of tabs) {
      const f = sessionUrlFromTab(t.url, settings.providerOrigin);
      if (!f) continue;
      if (!sessions[f.sessionUrl]) {
        armSession(f.sessionUrl, f.sessionId, t.id, t.title, true);
        globalEvent("auto-armed", `${f.sessionId} (tab ${t.id})`, f.sessionId);
      } else if (sessions[f.sessionUrl].tabId !== t.id) {
        sessions[f.sessionUrl].tabId = t.id;
      }
    }
  }
  updateBadge();
  persist();
}

/* ────────────────────────── arming ────────────────────────── */

function armSession(sessionUrl, sessionId, tabId, title, auto) {
  if (sessions[sessionUrl]) {
    const s = sessions[sessionUrl];
    s.armed = true;
    s.tabId = typeof tabId === "number" ? tabId : s.tabId;
    if (title) s.title = title;
    return s;
  }
  const rec = createSessionRecord({
    sessionUrl, sessionId, tabId, title, now: Date.now(), auto: auto === true,
  });
  sessions[sessionUrl] = rec;
  return rec;
}

/* ────────────────────────── events ────────────────────────── */

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo && changeInfo.url ? changeInfo.url : tab && tab.url;
  if (!url) return;
  const f = sessionUrlFromTab(url, settings.providerOrigin);
  // the record currently bound to this tab (one binding per tab)
  const bound = Object.values(sessions).find((s) => s.tabId === tabId);
  if (f) {
    if (bound) {
      if (bound.sessionId !== f.sessionId) {
        // chat-id roll: follow immediately (lessons 51/76/95)
        const oldUrl = bound.sessionUrl;
        pushSessionEvent(bound, {
          ts: Date.now(),
          kind: "roll",
          detail: `chat id rolled ${bound.sessionId} -> ${f.sessionId} (live event)`,
        });
        bound.sessionId = f.sessionId;
        bound.sessionUrl = f.sessionUrl;
        if (sessions[oldUrl] === bound) delete sessions[oldUrl];
        sessions[bound.sessionUrl] = bound;
        globalEvent("roll", `${bound.sessionId}`, bound.sessionId);
        persist();
      }
    } else if (settings.autoWatch && settings.enabled && !sessions[f.sessionUrl]) {
      armSession(f.sessionUrl, f.sessionId, tabId, tab && tab.title, true);
      globalEvent("auto-armed", `${f.sessionId} (tab ${tabId})`, f.sessionId);
      updateBadge();
      persist();
    }
  } else if (bound && bound.armed) {
    // real-time RETURNED detection (within seconds, not the next tick)
    const cls = classifyUrl(url, settings.providerOrigin);
    if (
      cls.kind === "home" &&
      bound.status !== STATUS.RETURNED &&
      bound.status !== STATUS.DEAD &&
      bound.status !== STATUS.AUTH_REQUIRED
    ) {
      bound.status = STATUS.RETURNED;
      pushSessionEvent(bound, {
        ts: Date.now(),
        kind: "returned",
        detail: "tab left the session URL (live event); verification on next tick",
      });
      globalEvent("returned", `${bound.sessionId} left the session URL`, bound.sessionId);
      persist();
    }
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  for (const s of Object.values(sessions)) {
    if (s.armed && s.tabId === tabId) {
      pushSessionEvent(s, { ts: Date.now(), kind: "tab-closed", detail: `tab ${tabId} closed (live event)` });
      s.tabId = -1;
      // the next tick decides (reopen vs GONE) honoring the boot grace
      persist();
    }
  }
});

/* ────────────────────────── messaging ────────────────────────── */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((resp) => sendResponse(resp || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async response
});

async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== "object") return { ok: false, error: "malformed" };

  // content sensor announcements
  if (msg.evt === EVT.CONTENT_READY && sender && sender.tab) {
    return handleContentReady(msg, sender);
  }

  switch (msg.evt) {
    case EVT.GET_STATE: {
      const tabs = await api.tabs.query({ url: `${settings.providerOrigin}/*` });
      return {
        ok: true,
        settings,
        sessions: Object.values(sessions),
        tabs: tabs.map((t) => ({
          id: t.id, url: t.url, title: t.title || "",
          active: t.active === true, session: sessionUrlFromTab(t.url, settings.providerOrigin),
        })),
        events: globalEvents.slice(-60),
        bootedAt,
      };
    }
    case EVT.SET_WATCH: {
      const url = msg.sessionUrl;
      const rec = sessions[url];
      if (msg.armed === false) {
        if (rec) {
          rec.armed = false;
          pushSessionEvent(rec, { ts: Date.now(), kind: "disarmed", detail: "operator disarmed" });
        }
      } else {
        const tabId = typeof msg.tabId === "number" ? msg.tabId : rec ? rec.tabId : -1;
        armSession(url, msg.sessionId || (rec && rec.sessionId) || "", tabId, msg.title || (rec && rec.title) || "", false);
      }
      updateBadge();
      persist();
      return { ok: true };
    }
    case EVT.SET_SETTINGS: {
      if (msg.reset === true) {
        settings = normalizeSettings(null);
      } else {
        settings = normalizeSettings(Object.assign({}, settings, msg.settings || {}));
      }
      ensureAlarm();
      updateBadge();
      persist();
      globalEvent("settings", msg.reset === true ? "settings reset to defaults" : "settings updated");
      return { ok: true, settings };
    }
    case EVT.FOCUS_TAB: {
      if (typeof msg.tabId === "number") await api.tabs.update(msg.tabId, { active: true });
      return { ok: true };
    }
    case EVT.RELAUNCH_NOW: {
      const rec = sessions[msg.sessionUrl];
      if (!rec) return { ok: false, error: "unknown-session" };
      resetRelaunchBudget(rec);
      rec.relaunchAttempts = 0;
      rec.status = STATUS.RECOVERING;
      const tab = await tabFact(rec);
      if (tab && tab.exists) {
        await api.tabs.update(rec.tabId, { url: rec.sessionUrl });
      } else {
        const created = await api.tabs.create({ url: rec.sessionUrl, active: false });
        if (created && typeof created.id === "number") rec.tabId = created.id;
      }
      pushSessionEvent(rec, { ts: Date.now(), kind: "manual-relaunch", detail: "operator relaunched" });
      globalEvent("manual-relaunch", rec.sessionId, rec.sessionId);
      persist();
      return { ok: true };
    }
    case EVT.REMOVE_SESSION: {
      delete sessions[msg.sessionUrl];
      updateBadge();
      persist();
      return { ok: true };
    }
    case EVT.CHECK_NOW: {
      await tick();
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown-evt" };
  }
}

async function handleContentReady(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const snap = msg.snapshot || {};
  const f = sessionUrlFromTab(sender.tab && sender.tab.url, settings.providerOrigin);
  let rec = f ? sessions[f.sessionUrl] : null;
  if (!rec && snap.sessionId) {
    rec = sessions[`${settings.providerOrigin}/c/${snap.sessionId}`];
  }
  if (rec) {
    // rebind + confirm recovery after a reload/relaunch (lessons 52/54)
    rec.tabId = typeof tabId === "number" ? tabId : rec.tabId;
    rec.consecutiveUnreachable = 0;
    if (typeof snap.lastMutationAt === "number") rec.lastMutationAt = snap.lastMutationAt;
    if (snap.turnOpen !== undefined) rec.turnOpen = snap.turnOpen === true ? true : snap.turnOpen === false ? false : null;
    if (snap.auth && typeof snap.auth.state === "string") rec.authState = snap.auth.state;
    const recoveringRecently =
      rec.lastActionAt && Date.now() - rec.lastActionAt < 3 * 60 * 1000;
    if (recoveringRecently) {
      pushSessionEvent(rec, { ts: Date.now(), kind: "recovered", detail: "page reloaded and answered after a recovery action" });
      globalEvent("recovered", `${rec.sessionId} answered after recovery`, rec.sessionId);
    }
    if (rec.status === STATUS.RECOVERING) rec.status = STATUS.WATCHING;
  } else if (f && settings.autoWatch && settings.enabled) {
    armSession(f.sessionUrl, f.sessionId, tabId, sender.tab && sender.tab.title, true);
    globalEvent("auto-armed", `${f.sessionId} (tab ${tabId})`, f.sessionId);
  }
  updateBadge();
  persist();
  return { ok: true };
}

/* ────────────────────────── startup ────────────────────────── */

function ensureAlarm() {
  const minutes = Math.max(1, Math.round(settings.tickSeconds / 60));
  api.alarms.create(ALARMS.TICK, { periodInMinutes: minutes, delayInMinutes: minutes });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARMS.TICK) {
    tick().catch(() => {});
  }
});

api.runtime.onInstalled.addListener(() => {
  bootedAt = Date.now();
  loadState().then(() => {
    ensureAlarm();
    globalEvent("installed", "Session Watchdog installed");
  });
});

// service-worker cold start / event-page load
(async function start() {
  await loadState();
  ensureAlarm();
  updateBadge();
})();
