/**
 * Pure session-record state (no browser APIs — unit-tested directly).
 *
 * A session record is keyed by its session URL (stable across tab changes,
 * browser restarts and our own recovery tab swaps — lesson 52/54: sessions
 * are tracked by TAB, but tabs are mortal, so the URL is the durable key
 * and `tabId` is always just the current binding).
 */

import {
  STATUS, SESSION_EVENT_RING, MAX_SESSIONS, NAME_MAX, MESSAGE_MAX,
  SENTINEL_MAX_PROMPTS, SENTINEL_YES_REQUEST, SENTINEL_LOOP_PROMPT_MAX,
} from "./protocol.js";

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
    // the sentinel (v1.2/v1.3): null, or the operator's explicit prompt
    // program — a RUNBOOK (a queue driven one turn at a time) or a
    // keep-going LOOP (one custom prompt re-sent every turn until the
    // session replies a simple "Yes" — the roadmap-complete signal)
    sentinel: null,               // {mode:'runbook'|'loop', queue:[...], total, sentCount, startedAt, prompt?}
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
    lastAssistantText: null,     // v1.3: last observed assistant reply (the Yes sensor)
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

/* ─────────── the sentinel (v1.2 runbook + v1.3 loop — pure helpers) ─────────── */

/**
 * Sanitize an operator runbook: an array of strings OR one newline-
 * separated blob -> trimmed, blank lines dropped, each prompt capped at
 * MESSAGE_MAX, the count capped at SENTINEL_MAX_PROMPTS.
 * @returns {string[]} the usable prompts ([] = nothing to run)
 */
export function sanitizeSentinelPrompts(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split("\n")
      : [];
  const prompts = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    prompts.push(t.slice(0, MESSAGE_MAX));
  }
  return prompts.slice(0, SENTINEL_MAX_PROMPTS);
}

/**
 * Create the RUNBOOK sentinel record (v1.2, pure).
 * @param {string[]} prompts  sanitized, non-empty
 * @param {number} now
 */
export function createSentinel(prompts, now) {
  return {
    mode: "runbook",
    queue: prompts.slice(),        // remaining prompts; front = next to send
    total: prompts.length,         // original count (the "3/7" display)
    sentCount: 0,                  // confirmed deliveries
    startedAt: typeof now === "number" ? now : 0,
  };
}

/**
 * Sanitize the operator's single LOOP prompt (v1.3): trimmed, capped
 * at SENTINEL_LOOP_PROMPT_MAX so prompt + the Yes-request always fits
 * the composer bound. "" = nothing to run.
 * @returns {string}
 */
export function sanitizeSentinelPrompt(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t) return "";
  return t.slice(0, SENTINEL_LOOP_PROMPT_MAX);
}

/**
 * The message a LOOP sentinel sends every turn: the operator's custom
 * prompt + the request to reply a short "Yes" when the roadmap is done
 * (pure — one law, one shape).
 * @returns {string}
 */
export function sentinelLoopMessage(prompt) {
  const t = typeof prompt === "string" ? prompt.trim() : "";
  return `${t}\n\n${SENTINEL_YES_REQUEST}`;
}

/**
 * Create the LOOP sentinel record (v1.3, pure): the queue holds the ONE
 * loop message forever (a loop never drains — only a simple Yes, the
 * operator's stop, or an exhausted budget ends it).
 * @param {string} prompt  sanitized, non-empty
 * @param {number} now
 */
export function createSentinelLoop(prompt, now) {
  return {
    mode: "loop",
    queue: [sentinelLoopMessage(prompt)],
    total: 0,                     // unbounded by design (0 = "—")
    sentCount: 0,                 // confirmed deliveries (the "N sent" display)
    startedAt: typeof now === "number" ? now : 0,
    prompt: typeof prompt === "string" ? prompt : "",
  };
}

/**
 * THE SIMPLE YES (v1.3 — the loop's stop condition). Strictly the word
 * "yes" (case-insensitive) alone, wrapped at most in whitespace,
 * punctuation or rendered-markdown emphasis ("Yes.", " **yes** ",
 * "YES!"). Anything else — "Yes, and here is the summary…", "almost
 * done", an empty string, an unknown — is NOT the Yes: the loop keeps
 * going (the operator's law: "otherwise it keeps sending in the custom
 * prompt").
 * @returns {boolean}
 */
export function isSimpleYes(text) {
  if (typeof text !== "string") return false;
  let t = text.trim();
  if (!t || t.length > 24) return false; // a simple Yes is SHORT by definition
  // strip surrounding emphasis/quote/whitespace wrappers (leftovers of
  // rendered markdown), then trailing sentence punctuation
  t = t.replace(/^[\s*_`'>"\u201C\u2018\[]+/, "");
  t = t.replace(/[\s*_`'<"\u201D\u2019\]]+$/, "");
  t = t.replace(/[.!?,;:~\u2026]+$/, "");
  return t.toLowerCase() === "yes";
}

/**
 * The next prompt a live sentinel would send (null when inactive).
 * @returns {string|null}
 */
export function sentinelNextPrompt(session) {
  const sen = session && session.sentinel;
  if (!sen || typeof sen !== "object" || !Array.isArray(sen.queue)) return null;
  if (sen.queue.length === 0) return null;
  return typeof sen.queue[0] === "string" ? sen.queue[0] : null;
}

/**
 * Progress label for events/notifications (mode-aware):
 *   runbook — the prompt ABOUT to be sent is sentCount+1 of total ("3/7")
 *   loop    — confirmed sends so far ("3 sent")
 * @returns {string}
 */
export function sentinelProgress(session) {
  const sen = session && session.sentinel;
  if (!sen || typeof sen !== "object") return "0/0";
  const sent = typeof sen.sentCount === "number" ? sen.sentCount : 0;
  if (sen.mode === "loop") return `${sent} sent`;
  const total = typeof sen.total === "number" ? sen.total : sen.queue ? sen.queue.length : 0;
  return `${Math.min(sent + 1, Math.max(total, 1))}/${total}`;
}

/**
 * Advance after a CONFIRMED delivery of `text` (mutates the record):
 *   runbook — the queue head is consumed ("advanced"/"complete")
 *   loop    — the counter moves, the queue NEVER drains ("advanced"
 *             forever; only the Yes, the operator's stop, or an
 *             exhausted budget ends a loop)
 * A text that is not the queue head never consumes anything — a manual
 * relaunch message must not eat the sentinel.
 * @returns {"advanced"|"complete"|"ignored"}
 */
export function advanceSentinel(session, text) {
  const sen = session && session.sentinel;
  if (!sen || typeof sen !== "object" || !Array.isArray(sen.queue)) return "ignored";
  if (sen.queue.length === 0 || sen.queue[0] !== text) return "ignored";
  if (sen.mode === "loop") {
    sen.sentCount = (typeof sen.sentCount === "number" ? sen.sentCount : 0) + 1;
    return "advanced";
  }
  sen.queue.shift();
  sen.sentCount = (typeof sen.sentCount === "number" ? sen.sentCount : 0) + 1;
  return sen.queue.length === 0 ? "complete" : "advanced";
}
