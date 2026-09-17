/**
 * Unit tests for the v1.2 surface: THE SENTINEL — the operator's runbook.
 *
 * The pinned ask (operator 2026-10-15, this session): "I think a better
 * idea would be to have the extension setup a sentinel that runs the
 * prompts just like we've been doing." The extension becomes the
 * operator's stand-in: a queue of prompts, one per turn, in order,
 * automatically — with the same laws as keep-going (never over a human
 * draft, same quiet grace, bounded budget that a reopened turn resets).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planAction, ACTION } from "../../src/recovery.js";
import { STATUS, normalizeSettings, ALARM_CHIME_KINDS, NOTIFY_COOLDOWN_MS, SENTINEL_MAX_PROMPTS } from "../../src/protocol.js";
import {
  createSessionRecord,
  sanitizeSentinelPrompts,
  createSentinel,
  sentinelNextPrompt,
  sentinelProgress,
  advanceSentinel,
} from "../../src/state.js";
import { buildDiagDump } from "../../src/diag.js";

const P = "https://chat.z.ai";
const SID = "aaaaaaaa-2222-3333-4444-555555555555";
const SURL = `${P}/c/${SID}`;

const T = 2_000_000; // a comfortable "now"
const settings = (over = {}) =>
  normalizeSettings(Object.assign({ providerOrigin: P, freezeSeconds: 360, stallSeconds: 1800 }, over));

const mkSession = (over = {}) =>
  Object.assign(createSessionRecord({ sessionUrl: SURL, sessionId: SID, tabId: 7, now: 1000000 }), over);

const tabOn = (url) => ({ exists: true, id: 7, url, title: "t" });

// an IDLE snapshot: turn closed, composer free, no draft, long quiet
const idleSnap = (over = {}) =>
  Object.assign(
    {
      ok: true,
      sessionId: SID,
      turnOpen: false,
      lastMutationAt: T - 999999,
      composerHasDraft: false,
      dialog: { present: false },
      humanVerification: false,
      auth: { state: "signed-in" },
    },
    over
  );

const idleInput = (session, over = {}) => ({
  now: T,
  settings: settings(over.settings),
  session,
  tab: tabOn(SURL),
  snapshot: idleSnap(over.snap),
  providerOrigin: P,
});

/** A session with an armed 3-prompt runbook, idle past the grace. */
const mkSentinelSession = (over = {}) => {
  const prompts = (over && over.prompts) || ["build the flange mount", "continue", "ship it and summarize"];
  const sen = createSentinel(prompts, 1000000);
  return mkSession(Object.assign({ idleSince: T - 120 * 1000, sentinel: sen }, over));
};

/* ── sanitization (the runbook is operator input — never trusted) ── */

test("sanitizeSentinelPrompts: array form — trimmed, blanks dropped", () => {
  assert.deepEqual(
    sanitizeSentinelPrompts(["  first ", "", "second", "   "]),
    ["first", "second"]
  );
});

test("sanitizeSentinelPrompts: newline blob form (the popup textarea)", () => {
  assert.deepEqual(
    sanitizeSentinelPrompts("build it\n\n  continue  \ncontinue\n\n"),
    ["build it", "continue", "continue"]
  );
});

test("sanitizeSentinelPrompts: caps each prompt, caps the count, rejects garbage", () => {
  const long = "x".repeat(5000);
  const out = sanitizeSentinelPrompts([long, "ok"]);
  assert.equal(out[0].length, 2000); // MESSAGE_MAX
  assert.equal(out[1], "ok");
  const many = Array.from({ length: SENTINEL_MAX_PROMPTS + 40 }, (_, i) => `p${i}`);
  assert.equal(sanitizeSentinelPrompts(many).length, SENTINEL_MAX_PROMPTS);
  assert.deepEqual(sanitizeSentinelPrompts(null), []);
  assert.deepEqual(sanitizeSentinelPrompts(42), []);
  assert.deepEqual(sanitizeSentinelPrompts(["", "   "]), []);
  assert.deepEqual(sanitizeSentinelPrompts([null, 7, {}]), []);
});

/* ── the runbook record helpers ─────────────────────────────── */

test("createSentinel shape + sentinelNextPrompt", () => {
  const sen = createSentinel(["a", "b"], T);
  assert.deepEqual(sen.queue, ["a", "b"]);
  assert.equal(sen.total, 2);
  assert.equal(sen.sentCount, 0);
  assert.equal(sen.startedAt, T);
  const s = mkSession({ sentinel: sen });
  assert.equal(sentinelNextPrompt(s), "a");
  assert.equal(sentinelNextPrompt(mkSession()), null); // no sentinel
  assert.equal(sentinelNextPrompt(mkSession({ sentinel: { queue: [], total: 1, sentCount: 1 } })), null); // drained
  assert.equal(sentinelNextPrompt(null), null);
});

test("advanceSentinel: head match consumes; non-head NEVER consumes", () => {
  const s = mkSession({ sentinel: createSentinel(["a", "b"], T) });
  assert.equal(advanceSentinel(s, "manual relaunch"), "ignored"); // not the head
  assert.deepEqual(s.sentinel.queue, ["a", "b"]);
  assert.equal(advanceSentinel(s, "a"), "advanced");
  assert.equal(s.sentinel.sentCount, 1);
  assert.deepEqual(s.sentinel.queue, ["b"]);
  assert.equal(advanceSentinel(s, "b"), "complete");
  assert.equal(s.sentinel.sentCount, 2);
  assert.deepEqual(s.sentinel.queue, []);
  // the CALLER clears session.sentinel on "complete"; a further call is ignored
  assert.equal(advanceSentinel(s, "b"), "ignored");
});

test("sentinelProgress: the prompt ABOUT to send is sentCount+1 of total", () => {
  const s = mkSession({ sentinel: createSentinel(["a", "b", "c"], T) });
  assert.equal(sentinelProgress(s), "1/3");
  advanceSentinel(s, "a");
  assert.equal(sentinelProgress(s), "2/3");
  advanceSentinel(s, "b");
  assert.equal(sentinelProgress(s), "3/3");
  assert.equal(sentinelProgress(mkSession()), "0/0");
});

/* ── THE LADDER: the sentinel branch (the core v1.2 law) ─────── */

test("SENTINEL: idle past the grace -> SEND the next runbook prompt", () => {
  const plan = planAction(idleInput(mkSentinelSession()));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
  assert.equal(plan.status, STATUS.RECOVERING);
  assert.equal(plan.sendMessage, "build the flange mount");
  assert.equal(plan.sentinel, true);
  assert.equal(plan.relaunchAttempt, true);
  assert.equal(plan.clearIdle, true);
  assert.ok(plan.notify);
  assert.equal(plan.notify.kind, "relaunched");
  assert.ok(/sentinel 1\/3/.test(plan.notify.message), plan.notify.message);
  assert.ok(/sentinel-send/.test(JSON.stringify(plan.events)));
});

test("SENTINEL: the SECOND prompt after the first turn completes", () => {
  const s = mkSentinelSession();
  advanceSentinel(s, "build the flange mount");
  const plan = planAction(idleInput(s));
  assert.equal(plan.reason, "sentinel-next");
  assert.equal(plan.sendMessage, "continue");
  assert.ok(/sentinel 2\/3/.test(plan.notify.message), plan.notify.message);
});

test("SENTINEL: the notification is name-aware", () => {
  const plan = planAction(idleInput(mkSentinelSession({ name: "night-shift" })));
  assert.match(plan.notify.message, /night-shift/);
});

test("SENTINEL: runs even when keep-going is globally OFF", () => {
  const plan = planAction(idleInput(mkSentinelSession(), { settings: { relaunchOnTurnEnd: false } }));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
});

test("SENTINEL: runs even when the session's own relaunch message is OFF", () => {
  const plan = planAction(idleInput(mkSentinelSession({ relaunchMessage: "" })));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
});

test("SENTINEL: beats the per-session custom relaunch message", () => {
  const plan = planAction(idleInput(mkSentinelSession({ relaunchMessage: "custom keep-going text" })));
  assert.equal(plan.sendMessage, "build the flange mount");
});

test("SENTINEL: a human draft -> PAUSED, never clobbered", () => {
  const plan = planAction(idleInput(mkSentinelSession(), { snap: { composerHasDraft: true } }));
  assert.equal(plan.reason, "sentinel-paused");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.clearIdle, true);
  assert.ok(/sentinel-paused/.test(JSON.stringify(plan.events)));
});

test("SENTINEL: inside the grace -> idle-waiting (one clock, one knob)", () => {
  const plan = planAction(idleInput(mkSentinelSession({ idleSince: 0 }))); // grace starts now
  assert.equal(plan.reason, "idle-waiting");
  assert.equal(plan.setIdleSince, T);
});

test("SENTINEL: a pending send owns the window (no double queue)", () => {
  const s = mkSentinelSession({ pendingMessage: { text: "build the flange mount", setAt: T, attempts: 1, sentinel: true } });
  const plan = planAction(idleInput(s));
  assert.equal(plan.reason, "pending-send");
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("SENTINEL: budget exhausted -> NEEDS_INPUT with the queue INTACT", () => {
  const s = mkSentinelSession({ relaunchAttempts: 3 });
  const plan = planAction(idleInput(s));
  assert.equal(plan.status, STATUS.NEEDS_INPUT);
  assert.equal(plan.reason, "sentinel-budget");
  assert.equal(plan.notify.kind, "needsInput");
  assert.match(plan.notify.message, /sentinel stuck at 1\/3/);
  assert.match(plan.notify.message, /night|flange|11111111|aaaaaaaa/); // name-aware label
  // THE LAW: a stuck runbook is not a dropped runbook — a manual relaunch
  // (which resets the budget) must be able to resume it
  assert.equal(s.sentinel.queue.length, 3);
  assert.equal(s.sentinel.sentCount, 0);
  assert.ok(/sentinel-blocked/.test(JSON.stringify(plan.events)));
});

test("SENTINEL: a LIVE turn resets the budget (productive runbooks are infinite)", () => {
  const plan = planAction({
    now: T,
    settings: settings(),
    session: mkSentinelSession({ relaunchAttempts: 3 }),
    tab: tabOn(SURL),
    snapshot: {
      ok: true, sessionId: SID, turnOpen: true,
      lastMutationAt: T - 1000, dialog: { present: false },
      humanVerification: false, auth: { state: "signed-in" },
    },
    providerOrigin: P,
  });
  assert.equal(plan.reason, "live");
  assert.equal(plan.resetBudget, true);
});

test("SENTINEL: no sentinel -> the keep-going ladder unchanged (regression)", () => {
  const plan = planAction(idleInput(mkSession({ idleSince: T - 120 * 1000 })));
  assert.equal(plan.reason, "turn-ended");
  assert.equal(plan.sendMessage, "continue");
  assert.equal(plan.sentinel, undefined);
});

/* ── the RETURNED path: the runbook rides the navigate-back ──── */

test("SENTINEL: on a return, the next runbook prompt is the queued message", () => {
  const input = {
    now: T,
    settings: settings(),
    session: mkSentinelSession(),
    tab: tabOn(`${P}/`),
    snapshot: idleSnap(),
    serverProbe: { ok: true, exists: true, updatedAt: T - 1000, hasAssistantPlaceholder: true },
    providerOrigin: P,
  };
  const plan = planAction(input);
  assert.equal(plan.action, ACTION.NAVIGATE_BACK);
  assert.equal(plan.reason, "returned-alive");
  assert.equal(plan.sendMessage, "build the flange mount");
  assert.equal(plan.sentinel, true);
});

test("RETURNED without a sentinel -> the relaunch message as before (regression)", () => {
  const input = {
    now: T,
    settings: settings(),
    session: mkSession(),
    tab: tabOn(`${P}/`),
    snapshot: idleSnap(),
    serverProbe: { ok: true, exists: true, updatedAt: T - 1000, hasAssistantPlaceholder: true },
    providerOrigin: P,
  };
  const plan = planAction(input);
  assert.equal(plan.sendMessage, "continue");
  assert.equal(plan.sentinel, undefined);
});

/* ── the alert-kind + diagnostics surfaces ───────────────────── */

test("\"sentinel\" is a CHIME kind with its own cooldown (the watchdog acted)", () => {
  assert.ok(ALARM_CHIME_KINDS.includes("sentinel"));
  assert.equal(NOTIFY_COOLDOWN_MS.sentinel, 5 * 60 * 1000);
});

test("buildDiagDump carries the runbook progress", () => {
  const s = mkSentinelSession({ name: "runbook-test" });
  advanceSentinel(s, "build the flange mount");
  const text = buildDiagDump({
    version: "1.2.0",
    now: T,
    settings: settings(),
    sessions: [s],
    globalEvents: [],
    alarmInfo: { active: false },
  });
  assert.match(text, /sentinel: 1\/3 delivered, 2 queued/);
  assert.match(text, /next: "continue"/);
  assert.match(text, /runbook-test/);
});

test("the sentinel survives record round-trips (plain JSON, no classes)", () => {
  const s = mkSentinelSession();
  const revived = JSON.parse(JSON.stringify(s));
  assert.equal(sentinelNextPrompt(revived), "build the flange mount");
  assert.equal(advanceSentinel(revived, "build the flange mount"), "advanced");
  assert.equal(sentinelProgress(revived), "2/3");
});

/* ══════════════════════════════════════════════════════════════════
 * v1.3 — THE KEEP-GOING LOOP (operator 2026-10-15): "the sentinel
 * should keep a session going by sending in a custom prompt + a request
 * for the session to reply with a short Yes message in case the entirety
 * of the roadmap is implemented. If it receives a simple Yes then it
 * should stop, otherwise it keeps sending in the custom prompt."
 * ══════════════════════════════════════════════════════════════════ */

import {
  sanitizeSentinelPrompt,
  sentinelLoopMessage,
  createSentinelLoop,
  isSimpleYes,
} from "../../src/state.js";
import { SENTINEL_YES_REQUEST, MESSAGE_MAX } from "../../src/protocol.js";

const LOOP_PROMPT = "continue working on the roadmap";

/** A session with an armed keep-going loop, idle past the grace. */
const mkLoopSession = (over = {}) => {
  const sen = createSentinelLoop((over && over.prompt) || LOOP_PROMPT, 1000000);
  const rec = mkSession(Object.assign({ idleSince: T - 120 * 1000, sentinel: sen }, over));
  delete over.prompt; // never a record field
  return rec;
};

/* ── THE SIMPLE YES — the strict stop condition ─────────────────── */

test("isSimpleYes: exactly the word, wrapped at most in noise", () => {
  assert.equal(isSimpleYes("Yes"), true);
  assert.equal(isSimpleYes("yes"), true);
  assert.equal(isSimpleYes("  YES!  "), true);
  assert.equal(isSimpleYes("Yes."), true);
  assert.equal(isSimpleYes("yes?"), true);
  assert.equal(isSimpleYes("**Yes**"), true);        // rendered markdown leftovers
  assert.equal(isSimpleYes("\u201CYes\u201D"), true); // curly quotes
  assert.equal(isSimpleYes("Yes\u2026"), true);
});

test("isSimpleYes: anything else is NOT the Yes (the loop keeps going)", () => {
  assert.equal(isSimpleYes("Yes, the roadmap is complete"), false);
  assert.equal(isSimpleYes("Yes and no"), false);
  assert.equal(isSimpleYes("yes it is"), false);
  assert.equal(isSimpleYes("The roadmap is implemented."), false);
  assert.equal(isSimpleYes("Almost done, 2 items left"), false);
  assert.equal(isSimpleYes("y"), false);
  assert.equal(isSimpleYes("yeah"), false);
  assert.equal(isSimpleYes(""), false);
  assert.equal(isSimpleYes(null), false);
  assert.equal(isSimpleYes(undefined), false);
  assert.equal(isSimpleYes(42), false);
  assert.equal(isSimpleYes("Y".repeat(40)), false); // long = not simple
});

/* ── the loop record helpers ────────────────────────────────────── */

test("sanitizeSentinelPrompt: trimmed, capped so the full loop message fits", () => {
  assert.equal(sanitizeSentinelPrompt("  continue  "), "continue");
  assert.equal(sanitizeSentinelPrompt(""), "");
  assert.equal(sanitizeSentinelPrompt("   "), "");
  assert.equal(sanitizeSentinelPrompt(null), "");
  const long = "x".repeat(5000);
  const capped = sanitizeSentinelPrompt(long);
  assert.ok(capped.length < MESSAGE_MAX);
  assert.ok(sentinelLoopMessage(capped).length <= MESSAGE_MAX);
});

test("sentinelLoopMessage: the custom prompt + the Yes-request, every send", () => {
  const msg = sentinelLoopMessage("continue");
  assert.equal(msg, `continue\n\n${SENTINEL_YES_REQUEST}`);
  assert.ok(/reply with just "Yes"/.test(msg));
});

test("createSentinelLoop shape + sentinelNextPrompt", () => {
  const sen = createSentinelLoop(LOOP_PROMPT, T);
  assert.equal(sen.mode, "loop");
  assert.equal(sen.total, 0); // unbounded by design
  assert.equal(sen.sentCount, 0);
  assert.equal(sen.prompt, LOOP_PROMPT);
  assert.equal(sen.startedAt, T);
  assert.equal(sen.queue.length, 1);
  assert.equal(sentinelNextPrompt(mkSession({ sentinel: sen })), sentinelLoopMessage(LOOP_PROMPT));
});

test("advanceSentinel LOOP: the counter moves, the queue NEVER drains", () => {
  const s = mkLoopSession();
  const msg = sentinelLoopMessage(LOOP_PROMPT);
  assert.equal(advanceSentinel(s, "manual relaunch"), "ignored"); // not the head
  assert.equal(advanceSentinel(s, msg), "advanced");
  assert.equal(s.sentinel.sentCount, 1);
  assert.equal(s.sentinel.queue.length, 1); // still armed
  assert.equal(advanceSentinel(s, msg), "advanced");
  assert.equal(advanceSentinel(s, msg), "advanced"); // never "complete"
  assert.equal(s.sentinel.sentCount, 3);
  assert.equal(s.sentinel.queue.length, 1);
});

test("sentinelProgress LOOP mode: confirmed sends, no total", () => {
  const s = mkLoopSession();
  assert.equal(sentinelProgress(s), "0 sent");
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  assert.equal(sentinelProgress(s), "2 sent");
});

/* ── THE LADDER: the loop branch (the core v1.3 law) ────────────── */

test("LOOP: idle past the grace -> SEND the custom prompt + the Yes-request", () => {
  const plan = planAction(idleInput(mkLoopSession()));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
  assert.equal(plan.status, STATUS.RECOVERING);
  assert.equal(plan.sendMessage, sentinelLoopMessage(LOOP_PROMPT));
  assert.ok(plan.sendMessage.endsWith(SENTINEL_YES_REQUEST));
  assert.equal(plan.sentinel, true);
  assert.equal(plan.notify.kind, "relaunched");
  assert.match(plan.notify.message, /sentinel loop/);
  assert.match(plan.notify.message, /not a Yes/);
});

test("LOOP: a NON-Yes reply -> the custom prompt is sent AGAIN", () => {
  const s = mkLoopSession();
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT)); // first delivery confirmed
  const plan = planAction(idleInput(s, { snap: { lastAssistantText: "Working: 3 roadmap items remain." } }));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
  assert.equal(plan.sendMessage, sentinelLoopMessage(LOOP_PROMPT));
  assert.match(plan.notify.message, /loop \(1 sent\)/); // one confirmed, this is #2
});

test("LOOP: a SIMPLE YES -> the loop stops (sentinelDone, chime, no send)", () => {
  const s = mkLoopSession();
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s, { snap: { lastAssistantText: "Yes" } }));
  assert.equal(plan.action, ACTION.EVENT_ONLY);       // NOTHING is sent
  assert.equal(plan.reason, "sentinel-yes");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.sentinelDone, true);
  assert.equal(plan.notify.kind, "sentinel");          // the completion chime
  assert.match(plan.notify.message, /simple Yes/);
  assert.match(plan.notify.message, /roadmap is complete/);
  assert.match(plan.notify.message, /1 prompt/);
  assert.ok(/sentinel-yes/.test(JSON.stringify(plan.events)));
});

test("LOOP: the Yes is detected from the RECORD fact too (snapshot without the key)", () => {
  const s = mkLoopSession({ lastAssistantText: "Yes." });
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s)); // idleSnap carries no lastAssistantText
  assert.equal(plan.reason, "sentinel-yes");
});

test("LOOP: a STALE Yes (before the first delivery) never stops a fresh loop", () => {
  // the Yes must ANSWER OUR PROMPT: sentCount 0 + transcript "Yes" -> SEND
  const plan = planAction(idleInput(mkLoopSession(), { snap: { lastAssistantText: "Yes" } }));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
  assert.equal(plan.sendMessage, sentinelLoopMessage(LOOP_PROMPT));
});

test("LOOP: an unknown transcript (sensor degraded) -> keep sending", () => {
  const s = mkLoopSession();
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s, { snap: { lastAssistantText: null } }));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "sentinel-next");
});

test("LOOP: a human draft -> PAUSED, never clobbered (the same law)", () => {
  const s = mkLoopSession();
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s, { snap: { composerHasDraft: true, lastAssistantText: "still working" } }));
  assert.equal(plan.reason, "sentinel-paused");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("LOOP: the Yes check is a PURE READ — it fires even over a human draft", () => {
  // stopping the loop sends NOTHING, so the draft law (never clobber a
  // typing human) is about SENDS; a completed roadmap completes regardless
  const s = mkLoopSession();
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s, { snap: { composerHasDraft: true, lastAssistantText: "Yes" } }));
  assert.equal(plan.reason, "sentinel-yes");
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.sentinelDone, true);
});

test("LOOP: inside the grace -> idle-waiting (one clock, one knob)", () => {
  const plan = planAction(idleInput(mkLoopSession({ idleSince: 0 })));
  assert.equal(plan.reason, "idle-waiting");
  assert.equal(plan.setIdleSince, T);
});

test("LOOP: budget exhausted -> NEEDS_INPUT with the loop INTACT", () => {
  const s = mkLoopSession({ relaunchAttempts: 3 });
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const plan = planAction(idleInput(s, { snap: { lastAssistantText: "no luck" } }));
  assert.equal(plan.status, STATUS.NEEDS_INPUT);
  assert.equal(plan.reason, "sentinel-budget");
  assert.equal(plan.notify.kind, "needsInput");
  assert.match(plan.notify.message, /sentinel stuck at 1 sent/);
  assert.equal(s.sentinel.mode, "loop");       // kept for a manual relaunch
  assert.equal(s.sentinel.queue.length, 1);
});

test("LOOP: a LIVE turn resets the budget (productive loops are infinite)", () => {
  const plan = planAction({
    now: T,
    settings: settings(),
    session: mkLoopSession({ relaunchAttempts: 3 }),
    tab: tabOn(SURL),
    snapshot: {
      ok: true, sessionId: SID, turnOpen: true,
      lastMutationAt: T - 1000, dialog: { present: false },
      humanVerification: false, auth: { state: "signed-in" },
    },
    providerOrigin: P,
  });
  assert.equal(plan.reason, "live");
  assert.equal(plan.resetBudget, true);
});

test("LOOP: on a return, the loop message rides the navigate-back", () => {
  const plan = planAction({
    now: T,
    settings: settings(),
    session: mkLoopSession(),
    tab: tabOn(`${P}/`),
    snapshot: idleSnap(),
    serverProbe: { ok: true, exists: true, updatedAt: T - 1000, hasAssistantPlaceholder: true },
    providerOrigin: P,
  });
  assert.equal(plan.action, ACTION.NAVIGATE_BACK);
  assert.equal(plan.reason, "returned-alive");
  assert.equal(plan.sendMessage, sentinelLoopMessage(LOOP_PROMPT));
  assert.equal(plan.sentinel, true);
});

test("OLD RECORDS (v1.2, no mode field) keep runbook semantics (regression)", () => {
  const sen = createSentinel(["a", "b"], T);
  delete sen.mode; // the stored v1.2 shape
  const s = mkSession({ idleSince: T - 120 * 1000, sentinel: sen, lastAssistantText: "Yes" });
  const plan = planAction(idleInput(s, { snap: { lastAssistantText: "Yes" } }));
  assert.equal(plan.reason, "sentinel-next");   // the Yes check is LOOP-only
  assert.equal(plan.sendMessage, "a");          // the runbook still consumes
  assert.equal(advanceSentinel(s, "a"), "advanced");
  assert.deepEqual(s.sentinel.queue, ["b"]);
});

/* ── the diagnostics + round-trip surfaces ──────────────────────── */

test("buildDiagDump carries the loop progress (v1.3)", () => {
  const s = mkLoopSession({ name: "loop-test" });
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  advanceSentinel(s, sentinelLoopMessage(LOOP_PROMPT));
  const text = buildDiagDump({
    version: "1.3.0",
    now: T,
    settings: settings(),
    sessions: [s],
    globalEvents: [],
    alarmInfo: { active: false },
  });
  assert.match(text, /sentinel: LOOP · 2 sent · waiting for a simple Yes/);
  assert.match(text, /continue working on the roadmap/);
  assert.match(text, /loop-test/);
});

test("buildDiagDump flags a stale-cached worker (swBuild != version, Sep-17 lesson)", () => {
  const dump = (swBuild) => buildDiagDump({
    version: "1.3.0",
    swBuild,
    now: T,
    settings: settings(),
    sessions: [],
    globalEvents: [],
    alarmInfo: { active: false },
  });
  // matching (or absent) marker: silent — the normal case
  assert.doesNotMatch(dump("1.3.0"), /swBuild/);
  assert.doesNotMatch(dump(undefined), /swBuild/);
  // mismatch: the dump NAMES the stale worker for the operator's report
  assert.match(dump("1.2.0"), /swBuild: 1\.2\.0.*stale cached worker/);
});

test("the loop survives record round-trips (plain JSON, no classes)", () => {
  const s = mkLoopSession();
  const revived = JSON.parse(JSON.stringify(s));
  assert.equal(sentinelNextPrompt(revived), sentinelLoopMessage(LOOP_PROMPT));
  assert.equal(advanceSentinel(revived, sentinelLoopMessage(LOOP_PROMPT)), "advanced");
  assert.equal(sentinelProgress(revived), "1 sent");
  assert.equal(revived.sentinel.queue.length, 1);
});
