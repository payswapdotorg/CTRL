/**
 * The Session Watchdog popup — the operator surface. Structure and
 * behavior only (no framework); styling lives in popup.css.
 *
 * Views: main (sessions + open tabs + event log) and settings. All data
 * comes from the background via sw-get-state; all mutations go back as
 * typed events. The popup never touches provider tabs directly.
 */

/* global chrome, document, window */

const EVT = {
  GET_STATE: "sw-get-state",
  SET_WATCH: "sw-set-watch",
  SET_SETTINGS: "sw-set-settings",
  FOCUS_TAB: "sw-focus-tab",
  RELAUNCH_NOW: "sw-relaunch-now",
  REMOVE_SESSION: "sw-remove-session",
  CHECK_NOW: "sw-check-now",
};

const $ = (id) => document.getElementById(id);

let state = null;
let logShown = false;
let pollTimer = null;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || { ok: false, error: "no-answer" });
      });
    } catch {
      resolve({ ok: false, error: "context-gone" });
    }
  });
}

async function refresh() {
  const resp = await send({ evt: EVT.GET_STATE });
  if (resp && resp.ok) {
    state = resp;
    render();
  } else {
    $("summaryText").textContent = "background unreachable";
  }
}

/* ───────────────────────── rendering ───────────────────────── */

function render() {
  renderSummary();
  renderSessions();
  renderTabs();
  renderLog();
  if (!$("settingsView").hidden) renderSettingsForm();
}

function renderSummary() {
  const sessions = (state && state.sessions) || [];
  const armed = sessions.filter((s) => s.armed);
  const live = armed.filter((s) => s.status === "LIVE").length;
  const alerts = armed.filter((s) => isAlert(s.status)).length;
  const el = $("summaryText");
  if (armed.length === 0) {
    el.textContent = "watching for sessions…";
    el.className = "";
  } else if (alerts > 0) {
    el.textContent = `${armed.length} watched · ${alerts} need attention`;
    el.className = "";
  } else {
    el.textContent = `${armed.length} watched · ${live} live · all quiet`;
    el.className = "ok";
  }
  $("footerText").textContent =
    state && state.bootedAt
      ? `Session Watchdog · up since ${new Date(state.bootedAt).toLocaleTimeString()}`
      : "Session Watchdog";
}

function isAlert(status) {
  return ["DEAD", "GONE", "WEDGED", "FROZEN", "AUTH_REQUIRED", "QUEUED-STALLED"].includes(status);
}

function renderSessions() {
  const list = $("sessionList");
  const empty = $("sessionEmpty");
  const sessions = ((state && state.sessions) || []).slice().sort((a, b) => {
    if (a.armed !== b.armed) return a.armed ? -1 : 1;
    const rank = (s) => (isAlert(s.status) ? 0 : s.status === "LIVE" ? 1 : 2);
    return rank(a) - rank(b) || (b.lastCheckAt || 0) - (a.lastCheckAt || 0);
  });
  $("sessionCount").textContent = String(sessions.filter((s) => s.armed).length);
  list.querySelectorAll(".sw-card").forEach((n) => n.remove());
  if (sessions.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const s of sessions) list.appendChild(sessionCard(s));
}

function sessionCard(s) {
  const card = el("div", "sw-card");
  card.setAttribute("role", "listitem");

  const top = el("div", "sw-card-top");
  const chip = el("span", "sw-status-chip chip-" + (s.status || "WATCHING"));
  chip.textContent = s.armed ? s.status || "WATCHING" : "PAUSED";
  top.appendChild(chip);
  const idLabel = el("span", "sw-session-id mono");
  idLabel.textContent = shortId(s.sessionId) + (s.auto ? " · auto" : "");
  idLabel.title = s.sessionUrl;
  top.appendChild(idLabel);
  card.appendChild(top);

  if (s.title) {
    const t = el("div", "sw-card-title");
    t.textContent = s.title;
    t.title = s.title;
    card.appendChild(t);
  }

  const meta = el("div", "sw-card-meta");
  const lastEvent = (s.events || []).slice(-1)[0];
  meta.textContent =
    lastEvent
      ? `${ago(lastEvent.ts)} — ${lastEvent.detail || lastEvent.kind}`
      : `armed ${ago(s.armedAt)}`;
  card.appendChild(meta);

  const actions = el("div", "sw-card-actions");

  const watch = el("label", "sw-switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = s.armed === true;
  input.setAttribute("aria-label", `Watch session ${shortId(s.sessionId)}`);
  input.addEventListener("change", async () => {
    await send({
      evt: EVT.SET_WATCH,
      sessionUrl: s.sessionUrl,
      sessionId: s.sessionId,
      tabId: s.tabId,
      title: s.title,
      armed: input.checked,
    });
    await refresh();
  });
  const track = el("span", "sw-switch-track");
  const label = el("span", "sw-switch-label");
  label.textContent = s.armed ? "watching" : "paused";
  watch.append(input, track, label);
  actions.appendChild(watch);

  const spacer = el("span", "sw-spacer");
  actions.appendChild(spacer);

  if (typeof s.tabId === "number" && s.tabId >= 0) {
    const focusBtn = el("button", "sw-btn sw-btn-mini");
    focusBtn.textContent = "open tab";
    focusBtn.addEventListener("click", async () => {
      await send({ evt: EVT.FOCUS_TAB, tabId: s.tabId });
      window.close();
    });
    actions.appendChild(focusBtn);
  }

  const relaunchBtn = el("button", "sw-btn sw-btn-mini");
  relaunchBtn.textContent = "relaunch";
  relaunchBtn.title = "Take the session tab back to its session URL";
  relaunchBtn.addEventListener("click", async () => {
    relaunchBtn.disabled = true;
    await send({ evt: EVT.RELAUNCH_NOW, sessionUrl: s.sessionUrl });
    setTimeout(refresh, 400);
  });
  actions.appendChild(relaunchBtn);

  const removeBtn = el("button", "sw-btn sw-btn-mini sw-btn-danger");
  removeBtn.textContent = "forget";
  removeBtn.title = "Stop watching and remove this session";
  removeBtn.addEventListener("click", async () => {
    await send({ evt: EVT.REMOVE_SESSION, sessionUrl: s.sessionUrl });
    await refresh();
  });
  actions.appendChild(removeBtn);

  card.appendChild(actions);
  return card;
}

function renderTabs() {
  const list = $("tabList");
  const empty = $("tabEmpty");
  list.querySelectorAll(".sw-tab-row").forEach((n) => n.remove());
  const tabs = ((state && state.tabs) || []).slice().sort((a, b) => {
    const as = a.session ? 0 : 1;
    const bs = b.session ? 0 : 1;
    return as - bs;
  });
  const watchedUrls = new Set(((state && state.sessions) || []).map((s) => s.sessionUrl));
  const rows = tabs.filter(
    (t) => t.session || (t.url || "").includes("/c/")
  );
  if (rows.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const t of rows) {
    const row = el("div", "sw-tab-row");
    const title = el("span", "sw-card-title");
    title.textContent = t.title || t.url;
    title.title = t.url;
    row.appendChild(title);
    if (t.session && watchedUrls.has(t.session.sessionUrl)) {
      const mark = el("span", "sw-connected-mark");
      mark.textContent = "connected";
      row.appendChild(mark);
    } else if (t.session) {
      const btn = el("button", "sw-btn sw-btn-mini");
      btn.textContent = "connect";
      btn.addEventListener("click", async () => {
        await send({
          evt: EVT.SET_WATCH,
          sessionUrl: t.session.sessionUrl,
          sessionId: t.session.sessionId,
          tabId: t.id,
          title: t.title,
          armed: true,
        });
        await refresh();
      });
      row.appendChild(btn);
    } else {
      const btn = el("button", "sw-btn sw-btn-mini");
      btn.textContent = "open";
      btn.addEventListener("click", async () => {
        await send({ evt: EVT.FOCUS_TAB, tabId: t.id });
        window.close();
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

function renderLog() {
  const log = $("eventLog");
  if (!logShown) return;
  log.querySelectorAll(".sw-ev").forEach((n) => n.remove());
  const events = ((state && state.events) || []).slice().reverse();
  if (events.length === 0) {
    const line = el("div", "sw-ev");
    const t = el("span", "sw-ev-time", "—");
    const k = el("span", "sw-ev-kind", "");
    const d = el("span", "", "no events yet");
    line.append(t, k, d);
    log.appendChild(line);
    return;
  }
  for (const e of events) {
    const line = el("div", "sw-ev");
    if (/dead|gone|wedged|auth|frozen|stalled/i.test(e.kind || "")) line.classList.add("ev-bad");
    else if (/reload|fresh|reopen|returned|roll|dismiss/i.test(e.kind || "")) line.classList.add("ev-warn");
    const t = el("span", "sw-ev-time", new Date(e.ts).toLocaleTimeString());
    const k = el("span", "sw-ev-kind", String(e.kind || ""));
    const d = el("span", "", String(e.detail || ""));
    line.append(t, k, d);
    log.appendChild(line);
  }
}

function renderSettingsForm() {
  const s = (state && state.settings) || {};
  $("tickSeconds").value = s.tickSeconds;
  $("freezeSeconds").value = s.freezeSeconds;
  $("unreachableThreshold").value = s.unreachableThreshold;
  $("stallSeconds").value = s.stallSeconds;
  $("relaunchCap").value = s.relaunchCap;
  $("swEnabled").checked = s.enabled !== false;
  $("autoWatch").checked = s.autoWatch !== false;
  $("relaunchOnTabClose").checked = s.relaunchOnTabClose !== false;
  $("dismissPopups").checked = s.dismissPopups !== false;
  $("notify").checked = s.notify !== false;
}

/* ───────────────────────── wiring ───────────────────────── */

$("settingsBtn").addEventListener("click", () => {
  const settings = $("settingsView");
  const main = $("mainView");
  const hidden = settings.hidden;
  settings.hidden = !hidden;
  main.hidden = hidden;
  if (hidden) renderSettingsForm();
});

$("checkNowBtn").addEventListener("click", async () => {
  $("checkNowBtn").textContent = "checking…";
  await send({ evt: EVT.CHECK_NOW });
  await refresh();
  $("checkNowBtn").textContent = "check now";
});

$("toggleLogBtn").addEventListener("click", () => {
  logShown = !logShown;
  $("eventLog").hidden = !logShown;
  $("toggleLogBtn").textContent = logShown ? "hide" : "show";
  $("toggleLogBtn").setAttribute("aria-expanded", String(logShown));
  renderLog();
});

$("settingsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const num = (id, min, max) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
  };
  await send({
    evt: EVT.SET_SETTINGS,
    settings: {
      enabled: $("swEnabled").checked,
      tickSeconds: num("tickSeconds", 30, 600),
      freezeSeconds: num("freezeSeconds", 120, 3600),
      unreachableThreshold: num("unreachableThreshold", 2, 10),
      stallSeconds: num("stallSeconds", 300, 21600),
      relaunchCap: num("relaunchCap", 1, 10),
      autoWatch: $("autoWatch").checked,
      relaunchOnTabClose: $("relaunchOnTabClose").checked,
      dismissPopups: $("dismissPopups").checked,
      notify: $("notify").checked,
    },
  });
  const saved = $("settingsSaved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
  await refresh();
});

$("resetSettingsBtn").addEventListener("click", async () => {
  await send({ evt: EVT.SET_SETTINGS, reset: true });
  await refresh();
  renderSettingsForm();
});

$("aboutLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  const dlg = $("aboutDialog");
  if (typeof dlg.showModal === "function") dlg.showModal();
});

/* helpers */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function shortId(id) {
  const s = String(id || "");
  return s.length > 8 ? s.slice(0, 8) : s || "?";
}
function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/* boot */
refresh();
pollTimer = setInterval(refresh, 2000);
window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
