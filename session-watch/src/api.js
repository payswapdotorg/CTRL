/**
 * The browser-API wrapper: a thin promise layer over the `chrome.*`
 * namespace, which Chrome, Opera AND Firefox all implement. This replaces
 * the webextension-polyfill with ~80 lines of scoped, injectable surface
 * (tests inject fakes; the bundle stays a classic script everywhere).
 *
 * Nothing here throws for expected "not found" shapes — they resolve to
 * typed values the ladder can branch on.
 */

const ERROR_RECEIVED = Symbol("sw-received-error");

function p(fn) {
  return new Promise((resolve) => {
    try {
      fn((value) => resolve({ ok: true, value }));
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

async function tabResult(promise) {
  const r = await promise;
  if (!r.ok) return { exists: false, reason: "api-error" };
  const t = r.value;
  if (!t || (t.id === undefined && t.tabId === undefined)) {
    return { exists: false, reason: "no-tab" };
  }
  return { exists: true, id: t.id, url: typeof t.url === "string" ? t.url : "", title: typeof t.title === "string" ? t.title : "" };
}

/**
 * Build the API surface over a namespace object (chrome / browser / fake).
 * @param {object} ns
 */
export function makeApi(ns) {
  const tabs = ns && ns.tabs;
  const alarms = ns && ns.alarms;
  const storage = ns && ns.storage && ns.storage.local;
  const notifications = ns && ns.notifications;
  const runtime = ns && ns.runtime;

  return {
    tabs: {
      get: (tabId) => tabResult(p((cb) => tabs.get(tabId, cb))),
      query: async (q) => {
        const r = await p((cb) => tabs.query(q, cb));
        return r.ok && Array.isArray(r.value) ? r.value : [];
      },
      reload: async (tabId) => {
        const r = await p((cb) => tabs.reload(tabId, {}, cb));
        return r.ok;
      },
      update: async (tabId, props) => {
        const r = await p((cb) => tabs.update(tabId, props, cb));
        return r.ok ? r.value : null;
      },
      create: async (props) => {
        const r = await p((cb) => tabs.create(props, cb));
        return r.ok ? r.value : null;
      },
      remove: async (tabId) => {
        const r = await p((cb) => tabs.remove(tabId, cb));
        return r.ok;
      },
      onUpdated: {
        addListener: (fn) => {
          if (tabs && tabs.onUpdated && tabs.onUpdated.addListener) {
            tabs.onUpdated.addListener(fn);
          }
        },
      },
      onRemoved: {
        addListener: (fn) => {
          if (tabs && tabs.onRemoved && tabs.onRemoved.addListener) {
            tabs.onRemoved.addListener(fn);
          }
        },
      },
    },
    alarms: {
      create: (name, info) => {
        if (alarms && alarms.create) alarms.create(name, info);
      },
      clear: async (name) => {
        const r = await p((cb) => alarms.clear(name, cb));
        return r.ok ? r.value === true : false;
      },
      onAlarm: {
        addListener: (fn) => {
          if (alarms && alarms.onAlarm && alarms.onAlarm.addListener) {
            alarms.onAlarm.addListener(fn);
          }
        },
      },
    },
    storage: {
      get: async (key) => {
        const r = await p((cb) => storage.get(key, cb));
        return r.ok ? r.value : {};
      },
      set: async (obj) => {
        const r = await p((cb) => storage.set(obj, cb));
        return r.ok;
      },
    },
    notifications: {
      create: (id, opts) => {
        if (notifications && notifications.create && opts && opts.message) {
          try {
            notifications.create(id, {
              type: "basic",
              iconUrl: opts.iconUrl || "icons/icon128.png",
              title: opts.title || "Session Watchdog",
              message: String(opts.message).slice(0, 300),
            });
            return true;
          } catch {
            return false;
          }
        }
        return false;
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          if (runtime && runtime.onMessage && runtime.onMessage.addListener) {
            runtime.onMessage.addListener(fn);
          }
        },
      },
      sendMessage: async (msg) => {
        const r = await p((cb) => runtime.sendMessage(msg, cb));
        return r.ok ? r.value : null;
      },
      onInstalled: {
        addListener: (fn) => {
          if (runtime && runtime.onInstalled && runtime.onInstalled.addListener) {
            runtime.onInstalled.addListener(fn);
          }
        },
      },
    },
    action: {
      setBadge: (text, color) => {
        const action = ns && ns.action;
        if (!action) return;
        try {
          if (action.setBadgeText) action.setBadgeText({ text: String(text || "") });
          if (color && action.setBadgeBackgroundColor) {
            action.setBadgeBackgroundColor({ color });
          }
        } catch {
          /* badge is cosmetic — never fatal */
        }
      },
    },
    /** Send a message to a content script with a hard timeout (ms). */
    sendToTab: (tabId, message, timeoutMs) =>
      new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: "timeout" });
          }
        }, Math.max(1000, timeoutMs || 8000));
        try {
          tabs.sendMessage(tabId, message, (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const err = ns.runtime && ns.runtime.lastError;
            if (err) {
              resolve({ ok: false, error: String(err.message || err) });
              return;
            }
            resolve(resp && resp.ok === true ? resp : { ok: false, error: resp && resp.error ? resp.error : "no-answer" });
          });
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, error: String(e && e.message ? e.message : e) });
          }
        }
      }),
  };
}
