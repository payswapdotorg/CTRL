/**
 * Shared protocol + constants for the Session Watchdog.
 *
 * Everything the background, the content sensor and the popup agree on
 * lives here: message kinds, statuses, default settings and their clamps,
 * and the URL grammar of the provider surface.
 */

/** Session lifecycle statuses (user-facing chips). */
export const STATUS = Object.freeze({
  WATCHING: "WATCHING",       // armed, no facts yet
  LIVE: "LIVE",               // open turn + recent activity
  IDLE: "IDLE",               // no open turn, page answers
  FROZEN: "FROZEN",           // freeze verdict; recovery exhausted or pending
  RECOVERING: "RECOVERING",   // a recovery action is in flight / just taken
  RETURNED: "RETURNED",       // tab rolled off the session URL
  QUEUED: "QUEUED",           // open turn, no assistant placeholder (lesson 48)
  STALLED: "QUEUED-STALLED",  // queued + quiet past the stall window
  DEAD: "DEAD",               // absent from the chats LIST, budget exhausted
  AUTH_REQUIRED: "AUTH_REQUIRED",
  GONE: "GONE",               // tab closed and not reopened (setting/budget)
  WEDGED: "WEDGED",           // content channel unreachable, budget exhausted
});

/** Commands background -> content sensor. */
export const CMD = Object.freeze({
  SNAPSHOT: "sw-snapshot",
  SERVER_PROBE: "sw-server-probe",
  DISMISS_DIALOG: "sw-dismiss-dialog",
});

/** Events content -> background / popup -> background. */
export const EVT = Object.freeze({
  CONTENT_READY: "sw-content-ready",
  GET_STATE: "sw-get-state",
  SET_WATCH: "sw-set-watch",
  SET_SETTINGS: "sw-set-settings",
  FOCUS_TAB: "sw-focus-tab",
  RELAUNCH_NOW: "sw-relaunch-now",
  REMOVE_SESSION: "sw-remove-session",
  CHECK_NOW: "sw-check-now",
});

/** The provider origin (the shipped surface). */
export const PROVIDER_ORIGIN = "https://chat.z.ai";

/** Session URL grammar: /c/<uuid> (the provider's routing state). */
export const SESSION_PATH_RE = /^\/c\/([0-9a-fA-F-]{6,64})(?:\/.*)?$/;

/** Storage keys. */
export const KEYS = Object.freeze({
  SETTINGS: "watchdog.settings",
  SESSIONS: "watchdog.sessions",
  EVENTS: "watchdog.events",
});

/** Alarm names. */
export const ALARMS = Object.freeze({
  TICK: "watchdog-tick",
});

/** Per-session event ring bound. */
export const SESSION_EVENT_RING = 50;
/** Global event ring bound. */
export const GLOBAL_EVENT_RING = 200;
/** Max sessions tracked (bounded by design). */
export const MAX_SESSIONS = 64;

/**
 * Default settings (clamped by normalizeSettings on every read/write).
 * Every default encodes a lesson — see DESIGN.md §2/§6.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  tickSeconds: 60,             // alarm cadence (browser alarms floor: 1 min)
  freezeSeconds: 360,          // open turn + no mutation window (lesson 36/106)
  unreachableThreshold: 3,     // consecutive unanswered ticks -> reload
  stallSeconds: 1800,          // queued-without-placeholder quiet window (lesson 48/89d)
  relaunchCap: 3,              // bounded recovery, never grinding (lesson 40/61)
  autoWatch: true,             // arm tabs that land on session URLs
  relaunchOnTabClose: true,    // reopen closed session tabs (lesson 52/54)
  dismissPopups: true,         // Cancel-only dialog dismissal (operator rule)
  notify: true,
  providerOrigin: PROVIDER_ORIGIN, // /c/<id> grammar holder (default: chat.z.ai)
});

/** Clamp helpers. */
function clampBool(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}
function clampInt(v, dflt, min, max) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

function clampUrl(v, dflt) {
  if (typeof v !== "string" || !v) return dflt;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return dflt;
    return u.origin;
  } catch {
    return dflt;
  }
}

/**
 * Validate + clamp a settings object (never trust storage).
 * @returns {object} a fresh normalized settings object
 */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: clampBool(s.enabled, d.enabled),
    tickSeconds: clampInt(s.tickSeconds, d.tickSeconds, 30, 600),
    freezeSeconds: clampInt(s.freezeSeconds, d.freezeSeconds, 120, 3600),
    unreachableThreshold: clampInt(s.unreachableThreshold, d.unreachableThreshold, 2, 10),
    stallSeconds: clampInt(s.stallSeconds, d.stallSeconds, 300, 21600),
    relaunchCap: clampInt(s.relaunchCap, d.relaunchCap, 1, 10),
    autoWatch: clampBool(s.autoWatch, d.autoWatch),
    relaunchOnTabClose: clampBool(s.relaunchOnTabClose, d.relaunchOnTabClose),
    dismissPopups: clampBool(s.dismissPopups, d.dismissPopups),
    notify: clampBool(s.notify, d.notify),
    providerOrigin: clampUrl(s.providerOrigin, d.providerOrigin),
  };
}

/**
 * URL classification (the ladder's step 1 — DESIGN §3).
 *
 * @param {string} rawUrl
 * @param {string} providerOrigin
 * @returns {{kind:'session'|'home'|'offsite'|'neterror', sessionId?:string}}
 */
export function classifyUrl(rawUrl, providerOrigin) {
  const url = typeof rawUrl === "string" ? rawUrl : "";
  if (
    url.startsWith("chrome-error://") ||
    url.startsWith("about:neterror") ||
    url === ""
  ) {
    return { kind: "neterror" };
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: "neterror" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { kind: "offsite" };
  }
  if (u.origin !== providerOrigin) {
    return { kind: "offsite" };
  }
  const m = SESSION_PATH_RE.exec(u.pathname);
  if (m) {
    return { kind: "session", sessionId: m[1] };
  }
  return { kind: "home" };
}

/** Notification throttle windows per kind (ms). */
export const NOTIFY_COOLDOWN_MS = Object.freeze({
  relaunched: 10 * 60 * 1000,
  dead: 30 * 60 * 1000,
  auth: 30 * 60 * 1000,
  frozen: 15 * 60 * 1000,
  stalled: 30 * 60 * 1000,
  wedged: 30 * 60 * 1000,
  humanVerification: 30 * 60 * 1000,
  gone: 30 * 60 * 1000,
});
