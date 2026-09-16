/**
 * Pure session-record state (no browser APIs — unit-tested directly).
 *
 * A session record is keyed by its session URL (stable across tab changes,
 * browser restarts and our own recovery tab swaps — lesson 52/54: sessions
 * are tracked by TAB, but tabs are mortal, so the URL is the durable key
 * and `tabId` is always just the current binding).
 */

import { STATUS, SESSION_EVENT_RING, MAX_SESSIONS, NAME_MAX } from "./protocol.js";

/**
 * Create a fresh armed session record.
 * @param {{sessionUrl:string, sessionId:string, tabId:number,
 *          title?:string, now:number, auto?:boolean}} input
 */
export function createSessionRecord(input) {
  if (!input || typeof input.sessionUrl !== "string" || !input.sessionUrl) {
    throw new Error("sessionUrl required");
  }
  return {
    sessionUrl: input.sessionUrl,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
    tabId: typeof input.tabId === "number" ? input.tabId : -1,
    title: typeof input.title === "string" ? input.title : "",
    // operator naming (v1.1): name beats titleHint beats title in the popup
    name: "",                     // operator-set label ("" = derive from hint)
    titleHint: "",                // first user message text (sensor-derived)
    relaunchMessage: null,        // null = inherit global setting; "" = off; "text" = custom
    pendingMessage: null,         // {text, reason, setAt, attempts} while a send is pending
    // keep-going ladder (v1.1): when the composer was first seen free
    idleSince: 0,                 // ts of the first turnOpen===false observation
    lastMessageSentAt: 0,         // ts of our last successful relaunch message
    armed: true,
    auto: input.auto === true,
    armedAt: input.now,
    createdAt: input.now,
    status: STATUS.WATCHING,
    lastReason: "",
    // liveness facts (last observed)
    lastCheckAt: 0,
    lastMutationAt: 0,
    observedServerUpdatedAt: 0,
    queuedSince: 0,
    turnOpen: null,
    dialogPresent: false,
    authState: "unknown",
    // incident counters (reset on healthy LIVE/IDLE)
    consecutiveUnreachable: 0,
    unreachableReloads: 0,
    freshTabs: 0,
    freezeReloads: 0,
    relaunchAttempts: 0,
    lastRelaunchAt: 0,
    lastActionAt: 0,
    // notification throttling: kind -> last ts
    notifiedAt: {},
    // bounded event ring (newest last)
    events: [],
  };
}

/** Push an event onto a record's ring (bounded, oldest dropped). */
export function pushSessionEvent(record, evt) {
  if (!record || !evt || typeof evt.ts !== "number") return record;
  record.events.push(evt);
  if (record.events.length > SESSION_EVENT_RING) {
    record.events.splice(0, record.events.length - SESSION_EVENT_RING);
  }
  return record;
}

/** Reset every incident counter (a healthy observation). NOTE: idleSince
 *  is KEEP-GOING state, not an incident counter — zeroing it here would
 *  reset the turn-end grace on every idle tick and the grace could never
 *  elapse (caught by the E2E blocked-send scenario). It is cleared only
 *  by an observed OPEN turn or an explicit clearIdle plan flag. */
export function resetIncident(session) {
  session.consecutiveUnreachable = 0;
  session.unreachableReloads = 0;
  session.freshTabs = 0;
  session.freezeReloads = 0;
  session.returnDeferrals = 0;
  session.queuedSince = 0;
  return session;
}

/** Reset the relaunch budget (a new incident begins). */
export function resetRelaunchBudget(session) {
  session.relaunchAttempts = 0;
  return session;
}

/**
 * The display label for a session (operator v1.1): the operator-set name
 * beats the first-user-message hint beats the short id. Used in every
 * notification and the diagnostic dump so alerts are name-aware.
 * @returns {string}
 */
export function labelOf(session) {
  if (!session) return "?";
  const name = typeof session.name === "string" ? session.name.trim() : "";
  if (name) return name.slice(0, NAME_MAX);
  const hint = typeof session.titleHint === "string" ? session.titleHint.trim() : "";
  if (hint) return hint.slice(0, NAME_MAX);
  const id = typeof session.sessionId === "string" ? session.sessionId : "";
  return id.length > 8 ? id.slice(0, 8) : id || "?";
}

/**
 * Notification throttle decision (pure).
 * @returns {boolean} true when a notification of this kind may fire now.
 */
export function mayNotify(session, kind, now, cooldownMs) {
  if (!session || typeof kind !== "string") return false;
  const last = session.notifiedAt[kind] || 0;
  return now - last >= cooldownMs;
}

/** Record that a notification kind fired. */
export function markNotified(session, kind, now) {
  if (session) session.notifiedAt[kind] = now;
  return session;
}

/**
 * Bound the sessions map (drop the oldest unarmed records first,
 * then the oldest records at all) — never exceeds MAX_SESSIONS.
 */
export function boundSessions(sessions) {
  const ids = Object.keys(sessions);
  if (ids.length <= MAX_SESSIONS) return sessions;
  const scored = ids.map((id) => ({
    id,
    armed: sessions[id].armed ? 1 : 0,
    at: sessions[id].lastCheckAt || sessions[id].armedAt || 0,
  }));
  scored.sort((a, b) => a.armed - b.armed || a.at - b.at);
  const toDrop = scored.slice(0, ids.length - MAX_SESSIONS);
  for (const s of toDrop) delete sessions[s.id];
  return sessions;
}

/**
 * Derive the session URL facts from a tab URL + provider origin.
 * Returns null when the tab is not on a session URL.
 * @returns {{sessionUrl:string, sessionId:string}|null}
 */
export function sessionUrlFromTab(tabUrl, providerOrigin) {
  if (typeof tabUrl !== "string") return null;
  let u;
  try {
    u = new URL(tabUrl);
  } catch {
    return null;
  }
  if (u.origin !== providerOrigin) return null;
  const m = /^\/c\/([0-9a-fA-F-]{6,64})(?:\/.*)?$/.exec(u.pathname);
  if (!m) return null;
  return { sessionUrl: `${providerOrigin}/c/${m[1]}`, sessionId: m[1] };
}
