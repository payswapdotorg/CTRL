#!/usr/bin/env python3
"""
The Session Watchdog end-to-end suite (replay session).

Drives the REAL extension (build/test loaded into the replay Chrome via
--load-extension) against the deterministic chat.z.ai mock (test/harness/
server.py) through the REAL popup surface (opened as a tab — the
CTRL-014 lesson-50/72 pattern), and asserts every failure mode
recovers exactly per the decision ladder.

Prerequisites (checked, not assumed):
  - CDP on 127.0.0.1:9222 answers
  - the extension service worker target exists (chrome-extension://…)
  - the harness answers on 127.0.0.1:8099 (started by this script if down)

Usage: python3 test/e2e/replay_e2e.py [--keep]   (--keep leaves tabs open)
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

import websocket  # websocket-client

CDP = "http://127.0.0.1:9222"
HARNESS = "http://127.0.0.1:8099"
HERE = __file__

PASS, FAIL = [], []


def log(msg):
    print(f"[e2e] {msg}", flush=True)


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"  ✔ {name}", flush=True)
    else:
        FAIL.append(name)
        print(f"  ✖ {name}  {detail}", flush=True)


# ─────────────────────────── CDP helper ───────────────────────────


class Tab:
    def __init__(self, ws_url, url, title=""):
        self.ws_url = ws_url
        self.url = url
        self.title = title
        self._ws = None
        self._id = 0

    def connect(self, timeout=15):
        self._ws = websocket.create_connection(self.ws_url, timeout=timeout)
        return self

    def ev(self, expr, await_promise=False, timeout=20):
        self._id += 1
        rid = self._id
        self._ws.settimeout(timeout)
        self._ws.send(
            json.dumps(
                {
                    "id": rid,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expr,
                        "returnByValue": True,
                        "awaitPromise": await_promise,
                    },
                }
            )
        )
        while True:
            r = json.loads(self._ws.recv())
            if r.get("id") == rid:
                res = r.get("result", {}).get("result", {})
                if res.get("type") == "undefined":
                    return None
                return res.get("value")

    def navigate(self, url):
        self._id += 1
        rid = self._id
        self._ws.settimeout(30)
        self._ws.send(json.dumps({"id": rid, "method": "Page.navigate", "params": {"url": url}}))
        while True:
            r = json.loads(self._ws.recv())
            if r.get("id") == rid:
                return r.get("result", {})

    def close(self):
        try:
            self._ws.close()
        except Exception:
            pass


def cdp_tabs():
    data = json.load(urllib.request.urlopen(f"{CDP}/json/list", timeout=5))
    return data


def open_tab(url):
    """Open a tab via /json/new workaround: Chrome 151 ignores ?url= —
    create about:blank then Page.navigate (lesson 80/100 pattern)."""
    req = urllib.request.Request(f"{CDP}/json/new", method="PUT")
    info = json.load(urllib.request.urlopen(req, timeout=5))
    t = Tab(info["webSocketDebuggerUrl"], info["url"], info.get("title", ""))
    t.connect()
    t.navigate(url)
    return t, info["id"]


def close_tab(tab_id):
    try:
        urllib.request.urlopen(f"{CDP}/json/close/{tab_id}", timeout=5).read()
    except Exception:
        pass


# ─────────────────────────── harness control ───────────────────────────


def harness_up():
    try:
        return json.load(urllib.request.urlopen(f"{HARNESS}/healthz", timeout=3)).get("ok") is True
    except Exception:
        return False


def ensure_harness():
    if harness_up():
        log("harness already up")
        return
    harness_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness")
    subprocess.Popen(
        [sys.executable, os.path.join(harness_dir, "server.py")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(30):
        if harness_up():
            return
        time.sleep(0.3)
    raise SystemExit("harness failed to start")


def control(chat_id, action, arg=None):
    body = json.dumps({"chat": chat_id, "action": action, "arg": arg}).encode()
    req = urllib.request.Request(
        f"{HARNESS}/control", data=body, headers={"Content-Type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=5))


def harness_messages(chat_id):
    """v1.1: every composer message the harness accepted for this chat."""
    data = json.load(urllib.request.urlopen(f"{HARNESS}/audit", timeout=5))
    return [
        c.get("arg")
        for c in data.get("controls", [])
        if c.get("action") == "message" and c.get("chat") == chat_id
    ]


def new_chat(title):
    body = json.dumps({"title": title}).encode()
    req = urllib.request.Request(f"{HARNESS}/new", data=body, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=5))["id"]


# ─────────────────────────── extension surface ───────────────────────────


def find_extension_id(wake=True):
    for t in cdp_tabs():
        url = t.get("url", "")
        if url.startswith("chrome-extension://") and "/background.js" in url:
            return url.split("/")[2].split("/")[0]
    if wake:
        # MV3 service workers go dormant; a content-script page wakes the
        # background (the announce message), which surfaces the target
        t, tid = open_tab(f"{HARNESS}/wake")
        time.sleep(2.0)
        close_tab(tid)
        for t2 in cdp_tabs():
            url = t2.get("url", "")
            if url.startswith("chrome-extension://") and "/background.js" in url:
                return url.split("/")[2].split("/")[0]
    return None


class Popup:
    """The popup opened as a tab — the operator surface."""

    def __init__(self, ext_id):
        self.ext_id = ext_id
        self.tab = None
        self.tab_id = None

    def open(self):
        self.tab, self.tab_id = open_tab(f"chrome-extension://{self.ext_id}/popup/popup.html")
        time.sleep(1.5)
        return self

    def state(self):
        return self.tab.ev(
            "(async()=>{try{return await new Promise(r=>chrome.runtime.sendMessage"
            "({evt:'sw-get-state'},r));}catch(e){return {ok:false,error:String(e)}}})()",
            await_promise=True,
            timeout=15,
        )

    def settings(self, patch):
        return self.tab.ev(
            f"(async()=>{{return await new Promise(r=>chrome.runtime.sendMessage"
            f"({{evt:'sw-set-settings',settings:{json.dumps(patch)}}},r))}})()",
            await_promise=True,
        )

    def check_now(self):
        self.tab.ev(
            "(async()=>{return await new Promise(r=>chrome.runtime.sendMessage({evt:'sw-check-now'},r))})()",
            await_promise=True,
            timeout=90,
        )

    def raw_send(self, msg, timeout=30):
        return self.tab.ev(
            f"(async()=>{{return await new Promise(r=>chrome.runtime.sendMessage({json.dumps(msg)},r))}})()",
            await_promise=True,
            timeout=timeout,
        )

    def update_session(self, session_url, patch):
        return self.raw_send({"evt": "sw-update-session", "sessionUrl": session_url, **patch})

    def export_diag(self):
        return self.raw_send({"evt": "sw-export-diag"}, timeout=30)

    def alarm_ack(self):
        return self.raw_send({"evt": "sw-alarm-ack", "via": "e2e"})

    def popup_dom(self):
        return self.tab.ev(
            "(function(){const s=[...document.querySelectorAll('.sw-card')].map(c=>({"
            "chip:c.querySelector('.sw-status-chip')?c.querySelector('.sw-status-chip').textContent:'',"
            "id:c.querySelector('.sw-session-id')?c.querySelector('.sw-session-id').textContent:''}));"
            "return JSON.stringify(s)})()"
        )

    def close(self):
        if self.tab_id:
            close_tab(self.tab_id)


def session_by_url(state, url):
    for s in state.get("sessions", []):
        if s.get("sessionUrl") == url:
            return s
    return None


def events_of(s):
    return [e.get("kind") for e in (s or {}).get("events", [])]


def wait_for(fn, timeout_s=30, interval=1.0, desc="condition"):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return None


def pump_until(popup, pred, timeout_s=240, interval=6.0, settle=1.0):
    """v1.1: drive check-now ticks while waiting — the keep-going ladder
    needs ticks to advance (grace windows, send retries, budget)."""
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            popup.check_now()
        except Exception:
            pass
        time.sleep(settle)
        try:
            last = popup.state()
        except Exception:
            last = None
        if last and pred(last):
            return last
        time.sleep(interval)
    return last


# ─────────────────────────── the suite ───────────────────────────


def main():
    keep = "--keep" in sys.argv
    ensure_harness()
    log("harness up")

    ext_id = find_extension_id()
    if not ext_id:
        raise SystemExit("extension service worker not found — is build/test loaded?")
    log(f"extension id: {ext_id}")

    popup = Popup(ext_id).open()
    log("popup open as a tab")

    # point the watchdog at the harness origin; freeze window at the
    # clamp minimum (120s) so the quiet-clock scenarios run in minutes;
    # the v1.1 keep-going grace at its clamp minimum (30s) likewise.
    # The first message after a cold SW start can drop — retry.
    r = None
    for attempt in range(5):
        r = popup.settings({
            "providerOrigin": HARNESS,
            "tickSeconds": 30,
            "freezeSeconds": 120,
            "turnEndGraceSeconds": 30,
            "relaunchCap": 2,
        })
        if (r or {}).get("ok"):
            break
        log(f"  settings attempt {attempt + 1} got {r} — retrying")
        time.sleep(2)
    if not (r or {}).get("ok"):
        raise SystemExit(f"settings failed: {r}")
    log(f"providerOrigin -> {HARNESS} (freeze 120s, turn-end grace 30s)")
    QUIET = 128  # freezeSeconds + margin
    GRACE = 40   # turnEndGraceSeconds + margin

    st = popup.state()

    # v1.1 hygiene: sessions from PREVIOUS runs (and the operator's real
    # chat.z.ai tabs, orphaned the moment providerOrigin moved to the
    # harness) would pollute this run and steal the alarm slot — forget
    # everything not under the harness origin and silence any stale alarm.
    stale = [s for s in (st.get("sessions") or []) if not (s.get("sessionUrl") or "").startswith(HARNESS)]
    for s in stale:
        popup.raw_send({"evt": "sw-remove-session", "sessionUrl": s.get("sessionUrl")})
    popup.alarm_ack()
    log(f"  cleaned {len(stale)} stale session(s) + acknowledged stale alarms")

    def fresh_session(title, mode=None):
        cid = new_chat(title)
        if mode:
            control(cid, mode)
        t, tid = open_tab(f"{HARNESS}/c/{cid}")
        return cid, t, tid

    # ── A. auto-connect + LIVE ────────────────────────────────────
    log("A. auto-connect + LIVE")
    cid_a, tab_a, tid_a = fresh_session("worker-alpha (generating)")
    time.sleep(2.5)
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("A1 auto-connected (armed by URL)", bool(sa and sa.get("armed")))
    check("A2 auto flag set", bool(sa and sa.get("auto")))
    popup.check_now()
    time.sleep(1.0)
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("A3 status LIVE (streaming DOM)", bool(sa and sa.get("status") == "LIVE"), str((sa or {}).get("status")))

    # popup DOM shows the session card with a LIVE chip (the popup
    # re-renders on its 2s poll — wait for it)
    dom = wait_for(
        lambda: (
            lambda d: any(cid_a[:8] in c.get("id", "") for c in d) and any(c.get("chip") == "LIVE" for c in d)
        )(json.loads(popup.popup_dom() or "[]")),
        timeout_s=10,
        desc="popup chip LIVE",
    )
    check("A4 popup shows the session card", any(cid_a[:8] in c.get("id", "") for c in json.loads(popup.popup_dom() or "[]")))
    check("A5 popup chip reads LIVE", dom is True, popup.popup_dom())

    # ── B. IDLE ───────────────────────────────────────────────────
    log("B. keep-going (turn ended, composer idle)")
    control(cid_a, "normal")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")  # reload the page into idle shape
    time.sleep(2.0)
    popup.check_now()
    time.sleep(0.5)
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("B1 status IDLE while inside the grace window", bool(sa and sa.get("status") == "IDLE"), str((sa or {}).get("status")))
    log(f"  waiting out the turn-end grace ({GRACE}s)…")
    time.sleep(GRACE)
    popup.check_now()
    time.sleep(1.0)
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("B2 turn-end-send fired (the relaunch, not silence)", "turn-end-send" in events_of(sa), str(events_of(sa)))
    msgs = harness_messages(cid_a)
    check("B3 the relaunch message landed in the harness", any(t == "continue" for t in msgs), str(msgs))
    check("B4 the turn reopened (no more idle)", (sa or {}).get("status") in ("LIVE", "RECOVERING"), str((sa or {}).get("status")))
    control(cid_a, "normal")  # settle the chat for the next scenario

    # ── C. RETURN: tab bounces home, chat alive -> navigate back ──
    log("C. return")
    control(cid_a, "generating")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")
    time.sleep(2.0)
    control(cid_a, "return")  # one-shot: the next page load bounces home
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")  # trigger the bounce
    time.sleep(2.5)
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("C1 RETURNED detected (live event)", bool(sa and sa.get("status") == "RETURNED"), str((sa or {}).get("status")))
    popup.check_now()
    wait_for(lambda: tab_back(cid_a), timeout_s=15, desc="tab back at session url")
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("C2 tab taken back to the session URL", tab_back(cid_a), str(current_tabs_url()))
    check("C3 returned-relaunch event recorded", "returned-relaunch" in events_of(sa), str(events_of(sa)))
    check("C4 status recovered", (sa or {}).get("status") in ("RECOVERING", "WATCHING", "LIVE", "IDLE"), str((sa or {}).get("status")))

    # ── D. FREEZE: two-sample verdict -> reload -> recovered ──────
    log("D. freeze")
    popup.check_now()  # healthy pass first (LIVE with mutations)
    control(cid_a, "freeze")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")  # the fresh page renders the frozen shape
    time.sleep(2.0)
    log(f"  waiting out the freeze window ({QUIET}s)…")
    time.sleep(QUIET)
    popup.check_now()  # probe 1: baseline
    time.sleep(1.5)
    popup.check_now()  # probe 2: frozen verdict -> reload
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    evs = events_of(sa)
    check("D1 baseline recorded first", "baseline" in evs, str(evs))
    check("D2 freeze-reload fired", "freeze-reload" in evs, str(evs))
    time.sleep(3.0)  # the watchdog's reload lands; the fresh page boots its sensor
    control(cid_a, "normal")
    popup.check_now()
    st = popup.state()
    sa = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("D3 recovered after reload", (sa or {}).get("status") in ("LIVE", "IDLE"), str((sa or {}).get("status")))

    # ── E. QUEUED: never reloaded ─────────────────────────────────
    log("E. queued")
    cid_e, tab_e, tid_e = fresh_session("worker-queued")
    time.sleep(2.0)
    control(cid_e, "queued")
    tab_e.navigate(f"{HARNESS}/c/{cid_e}")  # the fresh page renders the queued shape
    time.sleep(2.0)
    log(f"  waiting out the freeze window ({QUIET}s)…")
    time.sleep(QUIET)
    reloads_before = len([e for e in events_of(session_by_url(popup.state(), f"{HARNESS}/c/{cid_e}")) if "reload" in e])
    popup.check_now()
    time.sleep(1.5)
    popup.check_now()
    st = popup.state()
    se = session_by_url(st, f"{HARNESS}/c/{cid_e}")
    reloads_after = len([e for e in events_of(se) if "reload" in e])
    check("E1 status QUEUED", bool(se and se.get("status") == "QUEUED"), str((se or {}).get("status")))
    check("E2 no reload ever (lesson 48)", reloads_after == reloads_before, f"{reloads_before}->{reloads_after}")

    # ── F. ROLL: chat id rolls, watchdog follows ──────────────────
    log("F. roll")
    roll = control(cid_a, "roll")
    new_id = roll.get("newId")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")  # the old URL redirects to the new id
    time.sleep(2.5)
    st = popup.state()
    sr = session_by_url(st, f"{HARNESS}/c/{new_id}")
    check("F1 followed the rolled id", bool(sr and sr.get("armed")))
    check("F2 roll event recorded", "roll" in events_of(sr), str(events_of(sr)))
    check("F3 old record gone", session_by_url(st, f"{HARNESS}/c/{cid_a}") is None)
    cid_a = new_id  # track the rolled identity from here on

    # ── G. DIALOG: Cancel-only dismissal ──────────────────────────
    log("G. dialog")
    control(cid_a, "dialog")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")
    modal_up = wait_for(lambda: tab_a.ev("(document.getElementById('modal-cover')!==null)") is True, timeout_s=10)
    check("G0 the modal rendered", modal_up is True)
    popup.check_now()
    time.sleep(1.0)
    st = popup.state()
    sg = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    global_kinds = [e.get("kind") for e in st.get("events", [])]
    check(
        "G1 dialog-dismiss event",
        "dialog-dismiss" in events_of(sg) or "dismiss" in global_kinds,
        f"session={events_of(sg)} global={global_kinds}",
    )
    # the harness modal removes itself on Cancel click; verify from the page
    gone = tab_a.ev("(document.getElementById('modal-cover')===null)")
    check("G2 modal actually closed by Cancel", gone is True, str(gone))
    control(cid_a, "dialog-clear")

    # ── H. AUTH death: reported, never acted on ───────────────────
    log("H. auth")
    control(cid_a, "signed-out")
    tab_a.navigate(f"{HARNESS}/c/{cid_a}")
    time.sleep(2.0)
    popup.check_now()
    st = popup.state()
    sh = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("H1 AUTH_REQUIRED status", bool(sh and sh.get("status") == "AUTH_REQUIRED"), str((sh or {}).get("status")))
    check("H2 auth event recorded", "auth" in events_of(sh), str(events_of(sh)))
    control(cid_a, "signed-in")

    # ── I. TAB CLOSED: reopened at the session URL ────────────────
    log("I. tab closed")
    tab_a.close()
    close_tab(tid_a)
    time.sleep(1.0)
    popup.check_now()
    time.sleep(2.0)
    st = popup.state()
    si = session_by_url(st, f"{HARNESS}/c/{cid_a}")
    check("I1 reopen event", "reopen" in events_of(si), str(events_of(si)))
    check("I2 tab reopened at the session URL", tab_back(cid_a), str(current_tabs_url()))

    # ── J. DIE: destroyed server-side -> DEAD after one deferral ──
    log("J. die")
    cid_j, tab_j, tid_j = fresh_session("worker-doomed")
    time.sleep(2.0)
    control(cid_j, "die")
    tab_j.navigate(f"{HARNESS}/c/{cid_j}")  # 302 -> home (death certificate)
    time.sleep(2.0)
    popup.check_now()
    time.sleep(0.5)
    st = popup.state()
    sj1 = session_by_url(st, f"{HARNESS}/c/{cid_j}")
    check("J1 first pass defers (returned-absent)", "returned-absent" in events_of(sj1), str(events_of(sj1)))
    popup.check_now()
    st = popup.state()
    sj2 = session_by_url(st, f"{HARNESS}/c/{cid_j}")
    check("J2 DEAD verdict", bool(sj2 and sj2.get("status") == "DEAD"), str((sj2 or {}).get("status")))
    check("J3 dead event recorded", "dead" in events_of(sj2), str(events_of(sj2)))

    # ── K. WEDGE: hanging page -> unreachable ladder -> reload ────
    log("K. wedge")
    cid_k, tab_k, tid_k = fresh_session("worker-wedge")
    time.sleep(2.0)
    popup.check_now()  # arm + healthy pass
    control(cid_k, "wedge")
    try:
        tab_k.navigate(f"{HARNESS}/c/{cid_k}")  # the load hangs forever — the
    except Exception:  # CDP navigation response itself may time out: that IS
        log("  navigate hung (expected — that is the wedge)")  # the scenario
    time.sleep(1.5)
    for _ in range(3):
        popup.check_now()
        time.sleep(0.5)
    st = popup.state()
    sk = session_by_url(st, f"{HARNESS}/c/{cid_k}")
    check("K1 unreachable-reload fired", "unreachable-reload" in events_of(sk), str(events_of(sk)))
    control(cid_k, "normal")
    popup.check_now()
    time.sleep(2.0)
    popup.check_now()
    st = popup.state()
    sk = session_by_url(st, f"{HARNESS}/c/{cid_k}")
    check("K2 recovered after un-wedge + reload", (sk or {}).get("status") in ("LIVE", "IDLE"), str((sk or {}).get("status")))

    # ── L. KEEP-GOING failure: custom message, blocked send, ─────
    #    NEEDS_INPUT, the alarm lifecycle, the diagnostics export ──
    log("L. keep-going failure + alarm + diagnostics")
    cid_l, tab_l, tid_l = fresh_session("worker-blocked")
    time.sleep(2.0)
    control(cid_l, "normal")
    tab_l.navigate(f"{HARNESS}/c/{cid_l}")  # idle shape: the turn ended
    time.sleep(2.0)

    # name the session + set a custom relaunch message (operator v1.1)
    lur = f"{HARNESS}/c/{cid_l}"
    r = popup.update_session(lur, {"name": "night-shift", "relaunchMessage": "keep building v1.1"})
    check("L1 session named + custom message saved", bool(r and r.get("ok") and r.get("session", {}).get("name") == "night-shift"), str(r))

    # block the composer submit: every send lands nowhere — the exact
    # "failed to recover" shape that must end in NEEDS_INPUT + alarm
    control(cid_l, "block-send")

    def _needs_input(st_):
        s = session_by_url(st_ or {}, lur)
        return bool(s and s.get("status") == "NEEDS_INPUT")

    log("  pumping ticks through the blocked-send ladder (grace -> send -> grace -> send -> NEEDS_INPUT)…")
    st = pump_until(popup, _needs_input, timeout_s=300, interval=5.0)
    sl = session_by_url(st or {}, lur)
    check("L2 NEEDS_INPUT verdict after the budget exhausted", bool(sl and sl.get("status") == "NEEDS_INPUT"), str((sl or {}).get("status")))
    msgs = harness_messages(cid_l)
    check("L3 the custom message was sent (not the default)", any(t == "keep building v1.1" for t in msgs), str(msgs))
    evs = events_of(sl)
    check("L4 turn-end sends + budget events recorded", "turn-end-send" in evs and "needs-input" in evs, str(evs))

    # the alarm: active while unacknowledged, silent after the ack
    st = popup.state()
    ai = (st or {}).get("alarmInfo") or {}
    check("L5 alarm active (siren, needsInput)", bool(ai.get("active") and ai.get("level") == "siren" and ai.get("kind") == "needsInput"), str(ai))
    popup.alarm_ack()
    time.sleep(0.5)
    st = popup.state()
    ai = (st or {}).get("alarmInfo") or {}
    check("L6 alarm silenced by the ack", bool(not ai.get("active")), str(ai))

    # the diagnostics export: version + name + verdict present, and the
    # email API key NEVER leaves the machine
    popup.settings({"emailApiKey": "xkeysib-SECRET123DO.NOTLEAK"})
    d = popup.export_diag()
    text = (d or {}).get("text") or ""
    check("L7 diagnostics export answers", bool(d and d.get("ok") and len(text) > 400), str((d or {}).get("error", "")))
    check("L8 diagnostics carry the name + verdict", "night-shift" in text and "NEEDS_INPUT" in text, text[:200])
    check("L9 the API key is redacted", "SECRET123DO.NOTLEAK" not in text and "••" in text, "key leaked!")
    popup.settings({"emailApiKey": ""})

    control(cid_l, "unblock-send")
    control(cid_l, "normal")

    # ── final: the badge + honest summary ─────────────────────────
    st = popup.state()
    total = len([s for s in st.get("sessions", []) if s.get("armed")])

    print()
    print(f"  scenarios passed: {len(PASS)}")
    print(f"  scenarios failed: {len(FAIL)}")
    if FAIL:
        print("  FAILED:", ", ".join(FAIL))
    print(f"  armed sessions at end: {total}")

    if not keep:
        popup.close()
        cleanup_ids = [tid_e, tid_j, tid_k, tid_l, find_tab_id_for_session(cid_a)]
        cleanup_ids = [t for t in cleanup_ids if t and str(t) != str(tid_a)]
        cleanup_ids.append(tid_a)
        for tid in cleanup_ids:
            if tid:
                close_tab(tid)

    return 0 if not FAIL else 1


def tab_back(cid):
    for t in cdp_tabs():
        if t.get("type") == "page" and f"/c/{cid}" in t.get("url", ""):
            return True
    return False


def current_tabs_url():
    try:
        return [t.get("url", "")[:60] for t in cdp_tabs() if t.get("type") == "page"]
    except Exception as e:
        return str(e)


def find_tab_id_for_session(cid):
    for t in cdp_tabs():
        if t.get("type") == "page" and f"/c/{cid}" in t.get("url", ""):
            return t.get("id")
    return None


if __name__ == "__main__":
    sys.exit(main())
