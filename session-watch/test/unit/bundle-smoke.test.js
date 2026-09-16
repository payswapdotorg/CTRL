/**
 * Smoke-test the generated bundles under a fake chrome namespace:
 * the background must boot, register listeners, answer sw-get-state,
 * and run a full tick against fake tabs. This catches wiring mistakes
 * the syntax check cannot (undefined imports, listener signature
 * errors, storage shape mismatches).
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

function makeChromeFake({ tabs = [], stored = {} } = {}) {
  const state = { tabs: tabs.map((t) => ({ ...t })), storage: { ...stored } };
  const listeners = { tabUpdated: [], tabRemoved: [], alarm: [], message: [], installed: [] };
  const alarms = {};

  const storageArea = {
    get: (key, cb) => {
      const out = {};
      if (typeof key === "string") out[key] = state.storage[key];
      else Object.assign(out, state.storage);
      setTimeout(() => cb(out), 0);
    },
    set: (obj, cb) => {
      Object.assign(state.storage, obj);
      if (cb) setTimeout(cb, 0);
    },
  };

  const tabsApi = {
    get: (id, cb) => {
      const t = state.tabs.find((x) => x.id === id);
      setTimeout(() => cb(t ? { id: t.id, url: t.url, title: t.title || "" } : undefined), 0);
    },
    query: (q, cb) => {
      let list = state.tabs;
      if (q && q.url) {
        // support the glob-ish url filter used by the background
        const pattern = new RegExp("^" + q.url.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        list = list.filter((t) => pattern.test(t.url));
      }
      setTimeout(() => cb(list.map((t) => ({ ...t }))), 0);
    },
    reload: (id, _opts, cb) => {
      const t = state.tabs.find((x) => x.id === id);
      if (t) t.reloads = (t.reloads || 0) + 1;
      if (cb) setTimeout(cb, 0);
    },
    update: (id, props, cb) => {
      const t = state.tabs.find((x) => x.id === id);
      if (t && props && typeof props.url === "string") t.url = props.url;
      if (t && props && props.active === true) state.tabs.forEach((x) => (x.active = x.id === id));
      setTimeout(() => cb && cb(t ? { ...t } : undefined), 0);
    },
    create: (props, cb) => {
      const id = Math.max(0, ...state.tabs.map((t) => t.id)) + 1;
      const t = { id, url: props && props.url ? props.url : "about:blank", title: "", active: false };
      state.tabs.push(t);
      setTimeout(() => cb && cb({ ...t }), 0);
    },
    remove: (id, cb) => {
      state.tabs = state.tabs.filter((x) => x.id !== id);
      setTimeout(() => cb && cb(), 0);
    },
    sendMessage: (tabId, msg, cb) => {
      const t = state.tabs.find((x) => x.id === tabId);
      if (t && t.contentScript === false) {
        setTimeout(() => cb(undefined), 0);
        fake.runtime.lastError = { message: "Could not establish connection" };
        return;
      }
      if (t && t.answers) {
        const answer = t.answers(msg);
        setTimeout(() => cb(answer), 0);
        return;
      }
      setTimeout(() => cb({ ok: true, turnOpen: false, auth: { state: "signed-in" }, lastMutationAt: Date.now(), dialog: { present: false } }), 0);
    },
    onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
    onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
  };

  const fake = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      sendMessage: (_msg, cb) => setTimeout(() => cb && cb({ ok: true }), 0),
    },
    storage: { local: storageArea },
    tabs: tabsApi,
    alarms: {
      create: (name, info) => {
        alarms[name] = info;
      },
      clear: (name, cb) => {
        const had = !!alarms[name];
        delete alarms[name];
        setTimeout(() => cb && cb(had), 0);
      },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    notifications: {
      create: (id, opts) => {
        fake.notificationsSent.push({ id, opts });
      },
    },
    action: {
      setBadgeText: (o) => (fake.badge = o),
      setBadgeBackgroundColor: () => {},
    },
    notificationsSent: [],
  };
  return { fake, state, listeners, alarms };
}

function runBundle(bundlePath, chromeFake) {
  const code = readFileSync(bundlePath, "utf8");
  const sandbox = {
    chrome: chromeFake.fake,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Date,
    Promise,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    TypeError,
    Symbol,
    URL,
    fetch: () => Promise.reject(new Error("no-fetch-in-smoke")),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: bundlePath });
  return ctx;
}

/** Drive one background message and await its response. */
function sendMessage(listeners, msg) {
  return new Promise((resolve, reject) => {
    const fn = listeners.message[0];
    if (!fn) return reject(new Error("no message listener"));
    const keepAlive = fn(msg, {}, (resp) => resolve(resp));
    // listener returned true => async; otherwise the sync response already fired
    if (keepAlive !== true) {
      // response was called synchronously — resolve handled it
    }
    setTimeout(() => resolve(undefined), 500);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("background boots, arms via autoWatch, and answers state", async () => {
  const PROVIDER = "https://chat.z.ai";
  const { fake, state, listeners, alarms } = makeChromeFake({
    tabs: [
      {
        id: 7,
        url: `${PROVIDER}/c/11111111-2222-3333-4444-555555555555`,
        title: "Worker A",
        answers: () => ({
          ok: true,
          sessionId: "11111111-2222-3333-4444-555555555555",
          turnOpen: false,
          auth: { state: "signed-in" },
          lastMutationAt: Date.now(),
          dialog: { present: false },
        }),
      },
    ],
  });
  runBundle(new URL("../../build/test/background.js", import.meta.url).pathname, { fake, state, listeners, alarms });

  await wait(150); // startup loadState + ensureAlarm
  assert.ok(alarms["watchdog-tick"], "tick alarm created");

  // fire the alarm twice: tick 1 auto-arms the session tab, tick 2 checks it
  listeners.alarm[0]({ name: "watchdog-tick" });
  await wait(300);
  listeners.alarm[0]({ name: "watchdog-tick" });
  await wait(300);

  const resp = await sendMessage(listeners, { evt: "sw-get-state" });
  assert.ok(resp && resp.ok, "state answered");
  assert.equal(resp.sessions.length, 1, "one session armed");
  assert.equal(resp.sessions[0].sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(resp.sessions[0].status, "IDLE", "answered + no open turn = IDLE");
  assert.ok(resp.sessions[0].auto, "auto-armed");
});

test("returned tab is navigated back after the server probe says alive", async () => {
  const PROVIDER = "https://chat.z.ai";
  const SID = "11111111-2222-3333-4444-555555555555";
  const { fake, state, listeners } = makeChromeFake({
    tabs: [
      {
        id: 7,
        url: `${PROVIDER}/c/${SID}`,
        title: "Worker A",
        answers: (msg) => {
          if (msg.cmd === "sw-server-probe") {
            return { ok: true, exists: true, updatedAt: Date.now(), hasAssistantPlaceholder: true };
          }
          return { ok: true, auth: { state: "signed-in" }, dialog: { present: false } };
        },
      },
    ],
  });
  runBundle(new URL("../../build/test/background.js", import.meta.url).pathname, { fake, state, listeners });
  await wait(150);
  listeners.alarm[0]({ name: "watchdog-tick" });
  await wait(300);

  // the session rolls home (the operator's "return")
  state.tabs[0].url = `${PROVIDER}/`;
  listeners.alarm[0]({ name: "watchdog-tick" });
  await wait(400);

  assert.equal(state.tabs[0].url, `${PROVIDER}/c/${SID}`, "tab navigated back to the session URL");
});

test("frozen session (open turn, quiet DOM, frozen server) gets reloaded", async () => {
  const PROVIDER = "https://chat.z.ai";
  const SID = "11111111-2222-3333-4444-555555555555";
  let frozen = false;
  const tab = {
    id: 7,
    url: `${PROVIDER}/c/${SID}`,
    title: "Worker A",
    answers: (msg) => {
      if (msg.cmd === "sw-server-probe") {
        return { ok: true, exists: true, updatedAt: 1000, hasAssistantPlaceholder: true };
      }
      return {
        ok: true,
        turnOpen: frozen ? true : false,
        auth: { state: "signed-in" },
        lastMutationAt: frozen ? 1000 : Date.now(),
        dialog: { present: false },
      };
    },
  };
  const { fake, state, listeners } = makeChromeFake({ tabs: [tab] });
  runBundle(new URL("../../build/test/background.js", import.meta.url).pathname, { fake, state, listeners });
  await wait(150);
  listeners.alarm[0]({ name: "watchdog-tick" }); // arm
  await wait(300);

  frozen = true; // turn open, DOM quiet (lastMutationAt long ago), server frozen
  listeners.alarm[0]({ name: "watchdog-tick" }); // probe 1: baseline recorded
  await wait(400);
  assert.equal(state.tabs[0].reloads, undefined, "no reload before the second sample");
  listeners.alarm[0]({ name: "watchdog-tick" }); // probe 2: frozen verdict
  await wait(400);
  assert.equal(state.tabs[0].reloads, 1, "the frozen tab was reloaded once");
});
