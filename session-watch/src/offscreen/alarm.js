/**
 * The Session Watchdog alarm page.
 *
 * Two lives, one file:
 *   1. the chrome.offscreen AUDIO_PLAYBACK document (Chrome/Opera) —
 *      invisible, owns the sound; the background starts/stops it by
 *      message;
 *   2. the Firefox fallback TAB (opened with ?level=&label=) — visible,
 *      flashing red/green, self-starts from the query, and its STOP
 *      button acknowledges the alarm through the background.
 *
 * The sound is synthesized (WebAudio oscillator) so the build carries no
 * audio assets: siren = looping two-tone square wave; chime = three
 * bounded beeps. Hard stop after 30 minutes no matter what.
 */

(function () {
  "use strict";
  /* global chrome, document, window, AudioContext, webkitAudioContext, URL, location */

  const HARD_STOP_MS = 30 * 60 * 1000;
  let ctx = null;
  let timer = null;
  let stopped = false;

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* the background may be asleep or gone — nothing to do */
    }
  }

  function beep(freq, startAt, duration, gainValue) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.02);
    gain.gain.setValueAtTime(gainValue, startAt + duration - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  function startAudio(level) {
    stopAudio();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume().catch(function () {});
      }
      if (level === "chime") {
        // three bounded beeps — "handled", not "help"
        const t0 = ctx.currentTime + 0.05;
        beep(880, t0, 0.18, 0.5);
        beep(880, t0 + 0.3, 0.18, 0.5);
        beep(1174, t0 + 0.6, 0.3, 0.5);
        timer = setTimeout(function () { stopAudio(); }, 3000);
      } else {
        // the siren: a looping two-tone until a human answers
        let toggle = false;
        const ring = function () {
          if (!ctx || stopped) return;
          try {
            beep(toggle ? 880 : 660, ctx.currentTime + 0.03, 0.42, 0.75);
          } catch { /* keep looping */ }
          toggle = !toggle;
          timer = setTimeout(ring, 450);
        };
        ring();
        timer = setTimeout(function () { stop(); }, HARD_STOP_MS);
      }
    } catch {
      /* audio is best-effort; the visual alarm still stands */
    }
  }

  function stopAudio() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (ctx) {
      try {
        if (typeof ctx.close === "function" && ctx.state !== "closed") ctx.close();
      } catch { /* already closed */ }
      ctx = null;
    }
  }

  function start(level, label) {
    stopped = false;
    document.body.classList.toggle("chime", level === "chime");
    var detail = document.getElementById("detail");
    if (detail && label) detail.textContent = label + " — the watchdog needs you.";
    var title = document.getElementById("title");
    if (title) title.textContent = level === "chime" ? "Session Watchdog — relaunched" : "⚠ SESSION WATCHDOG ALARM";
    startAudio(level);
  }

  function stop() {
    stopped = true;
    stopAudio();
  }

  // the STOP button (tab mode): acknowledge through the background, which
  // stops every channel (offscreen sound included) and clears the repeat.
  var stopBtn = document.getElementById("stopBtn");
  if (stopBtn) {
    stopBtn.addEventListener("click", function () {
      stop();
      send({ evt: "sw-alarm-ack" });
      document.body.style.animation = "none";
      stopBtn.textContent = "acknowledged";
      stopBtn.disabled = true;
    });
  }

  // background -> here (offscreen document mode)
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.cmd === "sw-alarm-start") start(msg.level, msg.label);
      else if (msg.cmd === "sw-alarm-stop") stop();
      return false;
    });
  } catch {
    /* context gone */
  }

  // tab mode: self-start from the query string
  (function () {
    try {
      var q = new URL(location.href).searchParams;
      var level = q.get("level");
      if (level === "siren" || level === "chime") {
        var label = q.get("label") || "";
        var hint = document.getElementById("hint");
        if (hint) hint.textContent = "Opened by the Session Watchdog — it closes itself once silenced.";
        start(level, label);
      }
    } catch {
      /* no query: the offscreen mode waits for a start command */
    }
  })();

  // announce readiness (the background may retry the start on this)
  send({ evt: "sw-alarm-ready" });
})();
