/**
 * Unit tests for the v1.1 surface: the keep-going ladder (DESIGN §7),
 * labelOf, effectiveRelaunchMessage, the new settings clamps, the alarm
 * kind lists, and the diagnostic dump with its redaction law.
 *
 * The pinned story here is the operator's live failure (2026-10-14):
 * "it returned without finishing and the watcher didn't do anything to
 * relaunch it" — a session whose turn ends mid-task and idles must get
 * the relaunch message, never silence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planAction, ACTION, effectiveRelaunchMessage } from "../../src/recovery.js";
import { STATUS, normalizeSettings, ALARM_SIREN_KINDS, ALARM_CHIME_KINDS } from "../../src/protocol.js";
import { createSessionRecord, labelOf } from "../../src/state.js";
import { redactSettings, buildDiagDump } from "../../src/diag.js";

const P = "https://chat.z.ai";
const SID = "11111111-2222-3333-4444-555555555555";
const SURL = `${P}/c/${SID}`;

const T = 2_000_000; // a comfortable "now"
const GRACE = 90;    // the default turn-end grace (seconds)

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

/* ── the keep-going ladder (the core v1.1 law) ─────────────── */

test("KEEP-GOING: idle past the grace -> SEND the default message", () => {
  const plan = planAction(idleInput(mkSession({ idleSince: T - 120 * 1000 })));
  assert.equal(plan.action, ACTION.SEND_MESSAGE);
  assert.equal(plan.reason, "turn-ended");
  assert.equal(plan.status, STATUS.RECOVERING);
  assert.equal(plan.sendMessage, "continue");
  assert.equal(plan.relaunchAttempt, true);
  assert.equal(plan.clearIdle, true);
  assert.ok(plan.notify);
  assert.equal(plan.notify.kind, "relaunched");
  assert.ok(/turn-end-send/.test(JSON.stringify(plan.events)));
});

test("KEEP-GOING: the notification is name-aware (labelOf)", () => {
  const plan = planAction(idleInput(mkSession({ idleSince: T - 120 * 1000, name: "night-shift" })));
  assert.match(plan.notify.message, /night-shift/);
});

test("KEEP-GOING: per-session custom message beats the global default", () => {
  const s = mkSession({ idleSince: T - 120 * 1000, relaunchMessage: "keep building v1.1" });
  const plan = planAction(idleInput(s));
  assert.equal(plan.sendMessage, "keep building v1.1");
});

test("KEEP-GOING: per-session \"\" (explicit OFF) -> plain IDLE", () => {
  const s = mkSession({ idleSince: T - 120 * 1000, relaunchMessage: "" });
  const plan = planAction(idleInput(s));
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "idle");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.clearIdle, true);
  assert.ok(/keep-going-off/.test(JSON.stringify(plan.events || [])));
});

test("KEEP-GOING: global \"\" -> plain IDLE (the operator's OFF switch)", () => {
  const s = mkSession({ idleSince: T - 120 * 1000 });
  const plan = planAction(idleInput(s, { settings: { relaunchMessage: "" } }));
  assert.equal(plan.reason, "idle");
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("KEEP-GOING: relaunchOnTurnEnd=false -> plain IDLE", () => {
  const s = mkSession({ idleSince: T - 120 * 1000 });
  const plan = planAction(idleInput(s, { settings: { relaunchOnTurnEnd: false } }));
  assert.equal(plan.reason, "idle");
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("KEEP-GOING: inside the grace -> IDLE, idleSince tracked", () => {
  const plan = planAction(idleInput(mkSession())); // no idleYet -> starts now
  assert.equal(plan.reason, "idle-waiting");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.setIdleSince, T);
  assert.equal(plan.resetIncident, true);
});

test("KEEP-GOING: DOM mutated recently (grace) -> still waiting", () => {
  const plan = planAction(
    idleInput(mkSession({ idleSince: T - 120 * 1000 }), { snap: { lastMutationAt: T - 5 * 1000 } })
  );
  assert.equal(plan.reason, "idle-waiting");
});

test("KEEP-GOING: a human draft -> paused, never clobbered", () => {
  const plan = planAction(
    idleInput(mkSession({ idleSince: T - 120 * 1000 }), { snap: { composerHasDraft: true } })
  );
  assert.equal(plan.reason, "draft-present");
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.clearIdle, true);
});

test("KEEP-GOING: a pending send owns the window (no double queue)", () => {
  const s = mkSession({ idleSince: T - 120 * 1000, pendingMessage: { text: "continue", setAt: T, attempts: 1 } });
  const plan = planAction(idleInput(s));
  assert.equal(plan.reason, "pending-send");
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("KEEP-GOING: budget exhausted -> NEEDS_INPUT + needsInput alarm kind", () => {
  const s = mkSession({ idleSince: T - 120 * 1000, relaunchAttempts: 3 });
  const plan = planAction(idleInput(s));
  assert.equal(plan.status, STATUS.NEEDS_INPUT);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "idle-budget");
  assert.equal(plan.notify.kind, "needsInput");
  assert.ok(ALARM_SIREN_KINDS.includes("needsInput"));
});

test("KEEP-GOING: LIVE resets the budget (productive continues are infinite)", () => {
  // the reset is carried by the plan flags (executed in applyPlanMeta)
  const plan = planAction({
    now: T,
    settings: settings(),
    session: mkSession({ relaunchAttempts: 3 }),
    tab: tabOn(SURL),
    snapshot: {
      ok: true, sessionId: SID, turnOpen: true,
      lastMutationAt: T - 1000, dialog: { present: false },
      humanVerification: false, auth: { state: "signed-in" },
    },
  });
  assert.equal(plan.reason, "live");
  assert.equal(plan.resetBudget, true);
});

test("IDLE verdict does NOT reset the budget (same incident continues)", () => {
  const plan = planAction(idleInput(mkSession()));
  assert.equal(plan.resetBudget, undefined);
});

/* ── labelOf (the naming law: name > titleHint > short id) ──── */

test("labelOf precedence", () => {
  assert.equal(labelOf(mkSession({ name: "alpha", titleHint: "hint" })), "alpha");
  assert.equal(labelOf(mkSession({ titleHint: "Dispatch: begin" })), "Dispatch: begin");
  assert.equal(labelOf(mkSession()), "11111111");
  assert.equal(labelOf(mkSession({ name: "   ", titleHint: "" })), "11111111");
  assert.equal(labelOf(null), "?");
});

/* ── effectiveRelaunchMessage precedence ────────────────────── */

test("effectiveRelaunchMessage: own text > own \"\" (off) > global", () => {
  assert.equal(effectiveRelaunchMessage({ relaunchMessage: "custom" }, settings()), "custom");
  assert.equal(effectiveRelaunchMessage({ relaunchMessage: "" }, settings()), null);
  assert.equal(effectiveRelaunchMessage({ relaunchMessage: null }, settings()), "continue");
  assert.equal(effectiveRelaunchMessage({}, settings({ relaunchMessage: "" })), null);
  assert.equal(effectiveRelaunchMessage({ relaunchMessage: "   " }, settings()), null);
  assert.equal(effectiveRelaunchMessage(null, settings()), "continue");
});

/* ── the v1.1 settings clamps ───────────────────────────────── */

test("v1.1 settings defaults + clamps", () => {
  const d = normalizeSettings(null);
  assert.equal(d.relaunchOnTurnEnd, true);
  assert.equal(d.relaunchMessage, "continue");
  assert.equal(d.turnEndGraceSeconds, 90);
  assert.equal(d.alarmEnabled, true);
  assert.equal(d.alarmOnRelaunch, true);
  assert.equal(d.alarmRepeatMinutes, 2);
  assert.equal(d.emailEnabled, false);
  assert.equal(d.emailTo, "team@payswap.org");
  const c = normalizeSettings({
    turnEndGraceSeconds: 5, alarmRepeatMinutes: 99, ntfyTopic: "bad topic!/",
  });
  assert.equal(c.turnEndGraceSeconds, 30);
  assert.equal(c.alarmRepeatMinutes, 30);
  assert.equal(c.ntfyTopic, "badtopic");
});

test("alarm kind lists: failures siren, relaunches chime", () => {
  for (const k of ["dead", "gone", "wedged", "frozen", "auth", "stalled", "humanVerification", "needsInput"]) {
    assert.ok(ALARM_SIREN_KINDS.includes(k), k);
  }
  assert.deepEqual([...ALARM_CHIME_KINDS], ["relaunched"]);
});

/* ── the diagnostic dump (redaction is the law) ─────────────── */

test("redactSettings masks the API key and nothing else", () => {
  const r = redactSettings({ emailApiKey: "xkeysib-SECRET123", emailTo: "team@payswap.org", relaunchCap: 3 });
  assert.doesNotMatch(r.emailApiKey, /SECRET123/);
  assert.match(r.emailApiKey, /123/); // last four stay for identification
  assert.equal(r.emailTo, "team@payswap.org");
  assert.equal(r.relaunchCap, 3);
  assert.equal(redactSettings({}).emailApiKey, undefined);
});

test("buildDiagDump: name-aware, verdict-bearing, secret-free", () => {
  const s = mkSession({
    name: "night-shift",
    status: STATUS.NEEDS_INPUT,
    relaunchAttempts: 2,
    idleSince: T - 60_000,
    events: [{ ts: T, kind: "needs-input", detail: "budget exhausted" }],
  });
  const text = buildDiagDump({
    version: "1.1.0",
    now: T,
    bootedAt: T - 5000,
    settings: settings({ emailApiKey: "xkeysib-SECRET123" }),
    sessions: [s],
    globalEvents: [{ ts: T, kind: "alarm-ack", detail: "acknowledged via popup" }],
    alarmInfo: { active: true, level: "siren", kind: "needsInput", label: "night-shift" },
  });
  assert.match(text, /version: 1\.1\.0/);
  assert.match(text, /night-shift/);
  assert.match(text, /NEEDS_INPUT/);
  assert.match(text, /alarm-ack/);
  assert.doesNotMatch(text, /SECRET123/);
  assert.match(text, /redacted/);
});

test("buildDiagDump: bounded and safe on empty input", () => {
  const text = buildDiagDump({});
  assert.match(text, /Session Watchdog diagnostics/);
  assert.match(text, /version: \?/);
  assert.doesNotThrow(() => buildDiagDump(null));
});
