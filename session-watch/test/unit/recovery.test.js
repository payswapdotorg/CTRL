/**
 * Unit tests for the pure decision ladder (src/recovery.js planAction)
 * — every law in DESIGN.md §2/§3 gets a pinned case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planAction, ACTION } from "../../src/recovery.js";
import { STATUS, classifyUrl, normalizeSettings } from "../../src/protocol.js";
import { createSessionRecord, pushSessionEvent, mayNotify, boundSessions, sessionUrlFromTab } from "../../src/state.js";

const P = "https://chat.z.ai";
const SID = "11111111-2222-3333-4444-555555555555";
const SURL = `${P}/c/${SID}`;
const settings = () => normalizeSettings({ providerOrigin: P, freezeSeconds: 360, stallSeconds: 1800 });

const mkSession = (over = {}) =>
  Object.assign(createSessionRecord({ sessionUrl: SURL, sessionId: SID, tabId: 7, now: 1000000 }), over);

const tabOn = (url) => ({ exists: true, id: 7, url, title: "t" });
const snap = (over = {}) =>
  Object.assign(
    {
      ok: true,
      sessionId: SID,
      turnOpen: false,
      lastMutationAt: 999999,
      dialog: { present: false },
      humanVerification: false,
      auth: { state: "signed-in" },
    },
    over
  );

const T = 2_000_000; // a comfortable "now"

/* ── classifyUrl ────────────────────────────────────────────── */

test("classifyUrl grammar", () => {
  assert.deepEqual(classifyUrl(`${P}/c/${SID}`, P), { kind: "session", sessionId: SID });
  assert.equal(classifyUrl(`${P}/c/${SID}/edit`, P).kind, "session");
  assert.equal(classifyUrl(`${P}/`, P).kind, "home");
  assert.equal(classifyUrl(`${P}/sign-in`, P).kind, "home");
  assert.equal(classifyUrl("https://example.com/c/abc", P).kind, "offsite");
  assert.equal(classifyUrl("chrome-error://chromewebdata/", P).kind, "neterror");
  assert.equal(classifyUrl("about:blank", P).kind, "offsite");
  assert.equal(classifyUrl("not a url", P).kind, "neterror");
});

/* ── the ladder ─────────────────────────────────────────────── */

test("LIVE: open turn + fresh DOM mutation", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 1000 }),
  });
  assert.equal(plan.status, STATUS.LIVE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.resetIncident, true);
});

test("LIVE: silent DOM but the SERVER moved (lesson 106 — silent stretches are normal)", () => {
  const s = mkSession({ observedServerUpdatedAt: 1000 });
  const plan = planAction({
    now: T, settings: settings(), session: s, tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 999999 }),
    serverProbe: { ok: true, exists: true, updatedAt: 5000, hasAssistantPlaceholder: true },
  });
  assert.equal(plan.status, STATUS.LIVE);
  assert.equal(plan.reason, "live-silent");
  assert.equal(plan.observeServer, 5000);
});

test("FROZEN ladder: first reload, then fresh tab, then terminal FROZEN (lesson 37/52)", () => {
  const probe = { ok: true, exists: true, updatedAt: 1000, hasAssistantPlaceholder: true };
  const base = { now: T, settings: settings(), tab: tabOn(SURL), serverProbe: probe };
  const quiet = () => snap({ turnOpen: true, lastMutationAt: T - 999999 });

  // two-sample law: the first probe records the baseline, defers
  const p0 = planAction({ ...base, session: mkSession(), snapshot: quiet() });
  assert.equal(p0.reason, "baseline");
  assert.equal(p0.action, ACTION.EVENT_ONLY);
  assert.equal(p0.observeServer, 1000);

  const p1 = planAction({ ...base, session: mkSession({ observedServerUpdatedAt: 1000 }), snapshot: quiet() });
  assert.equal(p1.action, ACTION.RELOAD);
  assert.equal(p1.freezeReload, true);

  const p2 = planAction({ ...base, session: mkSession({ observedServerUpdatedAt: 1000, freezeReloads: 2 }), snapshot: quiet() });
  assert.equal(p2.action, ACTION.FRESH_TAB);
  assert.equal(p2.freshTab, true);

  const p3 = planAction({ ...base, session: mkSession({ observedServerUpdatedAt: 1000, freezeReloads: 2, freshTabs: 2 }), snapshot: quiet() });
  assert.equal(p3.action, ACTION.EVENT_ONLY);
  assert.equal(p3.status, STATUS.FROZEN);
  assert.ok(p3.notify);
});

test("QUEUED law: no assistant placeholder is NEVER reloaded (lesson 48)", () => {
  const probe = { ok: true, exists: true, updatedAt: 1000, hasAssistantPlaceholder: false };
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 999999 }),
    serverProbe: probe,
  });
  assert.equal(plan.status, STATUS.QUEUED);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.setQueuedSince, T);
});

test("STALLED: queued past the stall window (still no reload)", () => {
  const probe = { ok: true, exists: true, updatedAt: 1000, hasAssistantPlaceholder: false };
  const plan = planAction({
    now: T, settings: settings(), session: mkSession({ queuedSince: T - 1_900_000 }), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 999999 }),
    serverProbe: probe,
  });
  assert.equal(plan.status, STATUS.STALLED);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.ok(plan.notify);
});

test("DOM-quiet turn with no probe yet asks for the server probe first", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 999999 }),
  });
  assert.equal(plan.action, ACTION.PROBE);
});

test("unreachable ladder: threshold reload, then fresh tab, then WEDGED (lesson 3.19b/52)", () => {
  const base = { now: T, settings: settings(), tab: tabOn(SURL), snapshot: null, snapshotError: "timeout" };
  const p1 = planAction({ ...base, session: mkSession({ consecutiveUnreachable: 2 }) });
  assert.equal(p1.action, ACTION.RELOAD);

  const p2 = planAction({ ...base, session: mkSession({ consecutiveUnreachable: 2, unreachableReloads: 2 }) });
  assert.equal(p2.action, ACTION.FRESH_TAB);

  const p3 = planAction({ ...base, session: mkSession({ consecutiveUnreachable: 2, unreachableReloads: 2, freshTabs: 2 }) });
  assert.equal(p3.action, ACTION.EVENT_ONLY);
  assert.equal(p3.status, STATUS.WEDGED);
});

test("below the unreachable threshold: count only", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession({ consecutiveUnreachable: 0 }), tab: tabOn(SURL),
    snapshot: null, snapshotError: "timeout",
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "unreachable-count");
});

test("RETURNED + alive in the chats list -> navigate back (the operator's core ask)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(`${P}/`),
    snapshot: snap({ sessionId: null }),
    serverProbe: { ok: true, exists: true, updatedAt: Date.now(), hasAssistantPlaceholder: true },
  });
  assert.equal(plan.action, ACTION.NAVIGATE_BACK);
  assert.equal(plan.status, STATUS.RECOVERING);
  assert.equal(plan.relaunchAttempt, true);
});

test("RETURNED + absent from the list: one deferral, then DEAD (lesson 97)", () => {
  const base = {
    now: T, settings: settings(), session: mkSession(), tab: tabOn(`${P}/`),
    snapshot: snap({ sessionId: null }),
    serverProbe: { ok: true, exists: false },
  };
  const p1 = planAction(base);
  assert.equal(p1.action, ACTION.EVENT_ONLY);
  assert.equal(p1.returnDeferral, true);

  const p2 = planAction({ ...base, session: mkSession({ returnDeferrals: 1 }) });
  assert.equal(p2.status, STATUS.DEAD);
  assert.ok(p2.notify);
});

test("RETURNED + probe failed -> no verdict, no action", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(`${P}/`),
    snapshot: snap({ sessionId: null }),
    serverProbe: { ok: false, error: "list-http-500" },
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "returned-probe-failed");
});

test("returned relaunches are capped (never grinding — lesson 40/61)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession({ relaunchAttempts: 3 }), tab: tabOn(`${P}/`),
    snapshot: snap({ sessionId: null }),
    serverProbe: { ok: true, exists: true, updatedAt: Date.now(), hasAssistantPlaceholder: true },
  });
  assert.equal(plan.status, STATUS.DEAD);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("tab closed -> reopen (lesson 52/54), capped -> GONE", () => {
  const p1 = planAction({ now: T, settings: settings(), session: mkSession(), tab: null });
  assert.equal(p1.action, ACTION.REOPEN);
  assert.equal(p1.relaunchAttempt, true);

  const p2 = planAction({ now: T, settings: settings(), session: mkSession({ relaunchAttempts: 3 }), tab: null });
  assert.equal(p2.status, STATUS.GONE);
  assert.ok(p2.notify);
});

test("reopen disabled -> GONE with no action", () => {
  const plan = planAction({
    now: T, settings: normalizeSettings({ providerOrigin: P, relaunchOnTabClose: false }),
    session: mkSession(), tab: null,
  });
  assert.equal(plan.status, STATUS.GONE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("net-error page -> navigate back", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(),
    tab: tabOn("chrome-error://chromewebdata/"),
  });
  assert.equal(plan.action, ACTION.NAVIGATE_BACK);
});

test("off-site tab -> GONE, never hijacked", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn("https://example.com/"),
  });
  assert.equal(plan.status, STATUS.GONE);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("chat-id ROLL is followed, never treated as death (lessons 51/76/95)", () => {
  const NEW = "99999999-8888-7777-6666-555555555555";
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(`${P}/c/${NEW}`),
    snapshot: snap({ sessionId: NEW }),
  });
  assert.equal(plan.reason, "roll");
  assert.deepEqual(plan.roll, { sessionId: NEW, sessionUrl: `${P}/c/${NEW}` });
  assert.notEqual(plan.status, STATUS.DEAD);
});

test("dialog with a cancel control -> DISMISS; without -> reported only", () => {
  const p1 = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ dialog: { present: true, dismissible: true, text: "Currently in peak hours" } }),
  });
  assert.equal(p1.action, ACTION.DISMISS);

  const p2 = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ dialog: { present: true, dismissible: false, text: "Switch to Flash?" } }),
  });
  assert.equal(p2.action, ACTION.EVENT_ONLY);
  assert.equal(p2.reason, "dialog-undismissable");
  assert.ok(p2.notify);
});

test("dialog dismissal disabled in settings -> record only", () => {
  const plan = planAction({
    now: T, settings: normalizeSettings({ providerOrigin: P, dismissPopups: false }),
    session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ dialog: { present: true, dismissible: true } }),
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("auth signed-out -> AUTH_REQUIRED, no recovery actions (lesson 114)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ auth: { state: "signed-out", email: "guest-1234@guest.com" } }),
  });
  assert.equal(plan.status, STATUS.AUTH_REQUIRED);
  assert.equal(plan.action, ACTION.EVENT_ONLY);
});

test("human verification popup -> reported, never touched (CTRL-014 cont. 23)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ humanVerification: true }),
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "human-verification");
  assert.ok(plan.notify);
});

test("no open turn -> IDLE (never frozen)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: false, lastMutationAt: T - 999999 }),
  });
  assert.equal(plan.status, STATUS.IDLE);
  assert.equal(plan.resetIncident, true);
});

test("unknown turn state -> no verdict (fail-safe against rotted selectors)", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: null }),
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "unknown-turn-state");
});

test("disarmed session -> no plan", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession({ armed: false }), tab: tabOn(SURL),
    snapshot: snap(),
  });
  assert.equal(plan.reason, "not-armed");
});

test("probe failure during a quiet open turn -> defers, no verdict", () => {
  const plan = planAction({
    now: T, settings: settings(), session: mkSession(), tab: tabOn(SURL),
    snapshot: snap({ turnOpen: true, lastMutationAt: T - 999999 }),
    serverProbe: { ok: false, error: "list-http-500" },
  });
  assert.equal(plan.action, ACTION.EVENT_ONLY);
  assert.equal(plan.reason, "probe-failed");
});

/* ── state helpers ──────────────────────────────────────────── */

test("notification throttle", () => {
  const s = mkSession();
  assert.equal(mayNotify(s, "dead", T, 1000), true);
  s.notifiedAt.dead = T - 500;
  assert.equal(mayNotify(s, "dead", T, 1000), false);
  s.notifiedAt.dead = T - 2000;
  assert.equal(mayNotify(s, "dead", T, 1000), true);
});

test("session event ring is bounded", () => {
  const s = mkSession();
  for (let i = 0; i < 120; i++) pushSessionEvent(s, { ts: i, kind: "k" + (i % 7), detail: "d" });
  assert.equal(s.events.length, 50);
  assert.equal(s.events[0].ts, 70); // oldest dropped
});

test("boundSessions drops oldest unarmed first", () => {
  const sessions = {};
  for (let i = 0; i < 66; i++) {
    const url = `${P}/c/sid-${i}`;
    sessions[url] = createSessionRecord({ sessionUrl: url, sessionId: "sid-" + i, tabId: i, now: i });
    sessions[url].armed = i >= 3; // first three unarmed
    sessions[url].lastCheckAt = i;
  }
  boundSessions(sessions);
  assert.equal(Object.keys(sessions).length, 64);
  assert.ok(sessions[`${P}/c/sid-0`] === undefined, "unarmed dropped first");
  assert.ok(sessions[`${P}/c/sid-5`] !== undefined, "armed kept");
});

test("sessionUrlFromTab extracts /c/<id> only", () => {
  assert.deepEqual(sessionUrlFromTab(`${P}/c/${SID}`, P), { sessionUrl: SURL, sessionId: SID });
  assert.equal(sessionUrlFromTab(`${P}/`, P), null);
  assert.equal(sessionUrlFromTab("https://other.example/c/x", P), null);
  assert.equal(sessionUrlFromTab(null, P), null);
});

/* ── settings clamps ────────────────────────────────────────── */

test("settings are clamped, never trusted", () => {
  const s = normalizeSettings({ tickSeconds: 1, freezeSeconds: 1e9, relaunchCap: -3, autoWatch: "yes" });
  assert.equal(s.tickSeconds, 30);
  assert.equal(s.freezeSeconds, 3600);
  assert.equal(s.relaunchCap, 1);
  assert.equal(s.autoWatch, true);
  const junk = normalizeSettings({ tickSeconds: "abc" });
  assert.equal(junk.tickSeconds, 60);
  assert.equal(normalizeSettings(null).enabled, true);
});

test("providerOrigin default and clamp", () => {
  assert.equal(normalizeSettings(null).providerOrigin, "https://chat.z.ai");
  assert.equal(normalizeSettings({ providerOrigin: "javascript:alert(1)" }).providerOrigin, "https://chat.z.ai");
  assert.equal(normalizeSettings({ providerOrigin: "http://127.0.0.1:8099" }).providerOrigin, "http://127.0.0.1:8099");
});
