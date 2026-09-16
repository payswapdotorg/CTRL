/**
 * The Session Watchdog popup — the operator surface. Structure and
 * behavior only (no framework); styling lives in popup.css.
 *
 * Views: main (sessions + open tabs + event log) and settings. All data
 * comes from the background via sw-get-state; all mutations go back as
 * typed events. The popup never touches provider tabs directly.
 *
 * v1.1: per-session NAME + relaunch-message editing, the alarm banner
 * (silence), the alerts settings (alarm/email/webhook/ntfy + tests) and
 * the one-click diagnostics export.
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
  UPDATE_SESSION: "sw-update-session",
  EXPORT_DIAG: "sw-export-diag",
  ALARM_ACK: "sw-alarm-ack",
  ALARM_TEST: "sw-alarm-test",
  EMAIL_TEST: "sw-email-test",
};

const $ = (id) => document.getElementById(id);

let state = null;
let logShown = false;
let pollTimer = null;
let diagDumpText = "";

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
  renderAlarmBanner();
  renderSessions();
  renderTabs();
  renderLog();
  if (!$("settingsView").hidden) {
    renderSettingsForm();
    renderKeepGoingForm();
    renderAlertsForm();
  }
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
    state && state.version
      ? `Session Watchdog v${state.version}`
      : "Session Watchdog";
}

function renderAlarmBanner() {
  const info = (state && state.alarmInfo) || { active: false };
  const banner = $("alarmBanner");
  if (info.active) {
    banner.hidden = false;
    $("alarmBannerText").textContent =
      info.level === "siren"
        ? `ALARM — ${info.label || "a session"} needs you (${info.kind || "?"})`
        : `relaunched — ${info.label || "a session"}`;
    banner.classList.toggle("sw-alarm-chime", info.level !== "siren");
  } else {
    banner.hidden = true;
    banner.classList.remove("sw-alarm-chime");
  }
}

function isAlert(status) {
  return ["DEAD", "GONE", "WEDGED", "FROZEN", "AUTH_REQUIRED", "QUEUED-STALLED", "NEEDS_INPUT"].includes(status);
}

function labelOfSession(s) {
  const name = typeof s.name === "string" ? s.name.trim() : "";
  if (name) return name;
  const hint = typeof s.titleHint === "string" ? s.titleHint.trim() : "";
  if (hint) return hint;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  if (title) return title;
  return shortId(s.sessionId);
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

  // the operator NAME (v1.1): rename any watched session; notifications
  // and alarms become name-aware
  const nameRow = el("div", "sw-name-row");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "sw-name-input";
  nameInput.value = typeof s.name === "string" ? s.name : "";
  nameInput.placeholder = labelOfSession(s);
  nameInput.maxLength = 80;
  nameInput.setAttribute("aria-label", `Name for session ${shortId(s.sessionId)}`);
  nameInput.title = "A custom name used in notifications and alarms";
  nameInput.addEventListener("change", async () => {
    await send({ evt: EVT.UPDATE_SESSION, sessionUrl: s.sessionUrl, name: nameInput.value });
    await refresh();
  });
  nameRow.appendChild(nameInput);
  card.appendChild(nameRow);

  const meta = el("div", "sw-card-meta");
  const lastEvent = (s.events || []).slice(-1)[0];
  meta.textContent =
    lastEvent
      ? `${ago(lastEvent.ts)} — ${lastEvent.detail || lastEvent.kind}`
      : `armed ${ago(s.armedAt)}`;
  card.appendChild(meta);

  // the per-session relaunch message (v1.1): inherit / custom / off
  const msgRow = el("div", "sw-msg-row");
  const msgLabel = el("span", "sw-msg-label", "on turn end:");
  const msgSel = document.createElement("select");
  msgSel.className = "sw-msg-select";
  msgSel.setAttribute("aria-label", `Relaunch message mode for ${shortId(s.sessionId)}`);
  const ownNull = s.relaunchMessage === null || s.relaunchMessage === undefined;
  const ownOff = s.relaunchMessage === "";
  for (const [val, text] of [
    ["inherit", "global default"],
    ["custom", "custom…"],
    ["off", "OFF"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if ((val === "inherit" && ownNull) || (val === "off" && ownOff) || (val === "custom" && !ownNull && !ownOff)) {
      opt.selected = true;
    }
    msgSel.appendChild(opt);
  }
  const msgInput = document.createElement("input");
  msgInput.type = "text";
  msgInput.className = "sw-msg-input";
  msgInput.value = ownNull || ownOff ? "" : String(s.relaunchMessage);
  msgInput.placeholder = "the message to send";
  msgInput.maxLength = 2000;
  msgInput.hidden = msgSel.value !== "custom";
  msgSel.addEventListener("change", () => {
    msgInput.hidden = msgSel.value !== "custom";
  });
  const msgSave = el("button", "sw-btn sw-btn-mini", "save");
  msgSave.title = "Save this session's relaunch message";
  msgSave.addEventListener("click", async () => {
    let relaunchMessage = null;
    if (msgSel.value === "off") relaunchMessage = "";
    else if (msgSel.value === "custom") relaunchMessage = msgInput.value.trim() || "";
    await send({ evt: EVT.UPDATE_SESSION, sessionUrl: s.sessionUrl, relaunchMessage });
    await refresh();
  });
  msgRow.append(msgLabel, msgSel, msgInput, msgSave);
  card.appendChild(msgRow);

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
    if (/dead|gone|wedged|auth|frozen|stalled|needs|error|fail/i.test(e.kind || "")) line.classList.add("ev-bad");
    else if (/reload|fresh|reopen|returned|roll|dismiss|send|alarm|email|diag/i.test(e.kind || "")) line.classList.add("ev-warn");
    const t = el("span", "sw-ev-time", new Date(e.ts).toLocaleTimeString());
    const k = el("span", "sw-ev-kind", String(e.kind || ""));
    const d = el("span", "", String(e.detail || ""));
    line.append(t, k, d);
    log.appendChild(line);
  }
}

/* ───────────────────────── settings forms ───────────────────────── */

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

function renderKeepGoingForm() {
  const s = (state && state.settings) || {};
  $("relaunchOnTurnEnd").checked = s.relaunchOnTurnEnd !== false;
  $("turnEndGraceSeconds").value = s.turnEndGraceSeconds;
  $("relaunchMessage").value = typeof s.relaunchMessage === "string" ? s.relaunchMessage : "";
}

function renderAlertsForm() {
  const s = (state && state.settings) || {};
  $("alarmEnabled").checked = s.alarmEnabled !== false;
  $("alarmOnRelaunch").checked = s.alarmOnRelaunch !== false;
  $("alarmRepeatMinutes").value = s.alarmRepeatMinutes;
  $("emailEnabled").checked = s.emailEnabled === true;
  $("emailTo").value = s.emailTo || "";
  $("emailFrom").value = s.emailFrom || "";
  $("emailApiKey").value = ""; // never echo the secret back into the DOM
  $("emailApiKey").placeholder = s.emailApiKey ? "••••••••saved (type to replace)" : "xkeysib-…";
  $("ntfyTopic").value = s.ntfyTopic || "";
  $("webhookUrl").value = s.webhookUrl || "";
}

/* ───────────────────────── wiring ───────────────────────── */

$("settingsBtn").addEventListener("click", () => {
  const settings = $("settingsView");
  const main = $("mainView");
  const hidden = settings.hidden;
  settings.hidden = !hidden;
  main.hidden = hidden;
  if (hidden) {
    renderSettingsForm();
    renderKeepGoingForm();
    renderAlertsForm();
  }
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

$("silenceAlarmBtn").addEventListener("click", async () => {
  await send({ evt: EVT.ALARM_ACK, via: "popup" });
  await refresh();
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
  flashSaved("settingsSaved");
  await refresh();
});

$("keepGoingForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const v = Number($("turnEndGraceSeconds").value);
  await send({
    evt: EVT.SET_SETTINGS,
    settings: {
      relaunchOnTurnEnd: $("relaunchOnTurnEnd").checked,
      turnEndGraceSeconds: Number.isFinite(v) ? Math.min(600, Math.max(30, Math.round(v))) : undefined,
      relaunchMessage: $("relaunchMessage").value,
    },
  });
  flashSaved("keepGoingSaved");
  await refresh();
});

$("alertsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const v = Number($("alarmRepeatMinutes").value);
  const patch = {
    alarmEnabled: $("alarmEnabled").checked,
    alarmOnRelaunch: $("alarmOnRelaunch").checked,
    alarmRepeatMinutes: Number.isFinite(v) ? Math.min(30, Math.max(0, Math.round(v))) : undefined,
    emailEnabled: $("emailEnabled").checked,
    emailTo: $("emailTo").value.trim(),
    emailFrom: $("emailFrom").value.trim(),
    ntfyTopic: $("ntfyTopic").value.trim(),
    webhookUrl: $("webhookUrl").value.trim(),
  };
  if ($("emailApiKey").value.trim()) patch.emailApiKey = $("emailApiKey").value.trim();
  await send({ evt: EVT.SET_SETTINGS, settings: patch });
  flashSaved("alertsSaved");
  await refresh();
});

$("testAlarmBtn").addEventListener("click", async () => {
  await send({ evt: EVT.ALARM_TEST });
  showTestResult("alarm ringing — it auto-stops in a few seconds (or silence it above)");
  await refresh();
});

$("testEmailBtn").addEventListener("click", async () => {
  showTestResult("sending test email…");
  const r = await send({ evt: EVT.EMAIL_TEST });
  if (r && r.sent) showTestResult("test email sent — check the inbox (and spam folder)");
  else showTestResult(`email failed: ${(r && r.reason) || "unknown"}`);
});

/* the diagnostics export (v1.1): one click → paste-ready block */

$("copyDiagBtn").addEventListener("click", async () => {
  const r = await send({ evt: EVT.EXPORT_DIAG });
  if (!r || !r.ok || typeof r.text !== "string") {
    showTestResult("diagnostics failed: " + ((r && r.error) || "no answer"));
    return;
  }
  diagDumpText = r.text;
  const dlg = $("diagDialog");
  $("diagText").value = diagDumpText;
  if (typeof dlg.showModal === "function") dlg.showModal();
});

$("diagCopyBtn").addEventListener("click", async () => {
  let ok = false;
  try {
    await navigator.clipboard.writeText(diagDumpText);
    ok = true;
  } catch {
    ok = fallbackCopy($("diagText"));
  }
  $("diagStatus").textContent = ok
    ? "Copied — paste it into the CTRL issue."
    : "Select the text below and copy manually (Ctrl+C).";
});

$("diagDownloadBtn").addEventListener("click", () => {
  try {
    const blob = new Blob([diagDumpText], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `session-watchdog-diag-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    /* clipboard path still stands */
  }
});

function fallbackCopy(textarea) {
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function showTestResult(text) {
  const elx = $("alertsTestResult");
  elx.textContent = text;
  elx.hidden = false;
  setTimeout(() => (elx.hidden = true), 8000);
}

function flashSaved(id) {
  const saved = $(id);
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
}

$("resetSettingsBtn").addEventListener("click", async () => {
  await send({ evt: EVT.SET_SETTINGS, reset: true });
  await refresh();
  renderSettingsForm();
  renderKeepGoingForm();
  renderAlertsForm();
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
