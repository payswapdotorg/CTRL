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


def extension_candidates():
    """Every chrome-extension service-worker target id (Sep-17 lesson:
    Chrome's built-in glic extension ALSO runs a background.js — an
    unverified scan can grab the WRONG extension's id)."""
    ids = []
    for t in cdp_tabs():
        url = t.get("url", "")
        if url.startswith("chrome-extension://") and "/background.js" in url:
            ext_id = url.split("/")[2]
            if ext_id not in ids:
                ids.append(ext_id)
    return ids


def verify_ours(ext_id):
    """A candidate is OURS exactly when its popup page carries our title
    (glic and other background.js extensions answer nothing there)."""
    try:
        t, tid = open_tab(f"chrome-extension://{ext_id}/popup/popup.html")
        time.sleep(0.8)
        title = t.ev("document.title", timeout=8)
        close_tab(tid)
        return title == "Session Watchdog"
    except Exception:
        return False


def find_extension_id(wake=True):
    for ext_id in extension_candidates():
        if verify_ours(ext_id):
            return ext_id
    if wake:
        # MV3 service workers go dormant (ours does not boot until a
        # content page announces); ANY page on the harness origin injects
        # the content script, whose announce wakes our worker
        t, tid = open_tab(f"{HARNESS}/wake")
        time.sleep(2.0)
        close_tab(tid)
        for ext_id in extension_candidates():
            if verify_ours(ext_id):
                return ext_id
        # Chrome 151 lesson: --load-extension can half-register (the SW
        # boots once, then blocks). The CDP Extensions domain (armed by
        # --enable-unsafe-extension-automation) loads it deterministically.
        try:
            bws = json.load(urllib.request.urlopen(f"{CDP}/json/version", timeout=5))["webSocketDebuggerUrl"]
            build_test = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "build", "test"))
            ws = websocket.create_connection(bws, timeout=15)
            ws.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": build_test}}))
            ws.recv()
            ws.close()
            time.sleep(2.0)
        except Exception as e:
            log(f"  Extensions.loadUnpacked fallback failed: {e}")
        for ext_id in extension_candidates():
            if verify_ours(ext_id):
                return ext_id
    return None


def sw_target():
    for t in cdp_tabs():
        if t.get("url", "").startswith("chrome-extension://") and t.get("url", "").endswith("/background.js"):
            return t
    return None


def expected_build():
    pkg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "package.json")
    return json.load(open(pkg)).get("version")


def assert_fresh_sw(state):
    """The Sep-17 v1.3 lesson: a PERSISTED unpacked extension (a
    loadUnpacked registration rides the profile across Chrome restarts)
    can serve a STALE service-worker SCRIPT from the profile's script
    cache after a rebuild — v1.3 files on disk, the live worker still
    running v1.2 code and answering 'no-prompts' to a loop arm. The
    manifest cannot detect this (Chrome re-reads it from disk at every
    boot), so the worker carries SW_BUILD — the version baked into the
    script at bundle time — exposed as swBuild in sw-get-state. This
    guard makes the suite REFUSE to drive anything but the code that
    was just built. (A chrome.runtime.reload() from CDP was tried as a
    self-heal and half-broke the registration — the Chrome 151 class —
    so a loud failure with the fix is the honest repair.)"""
    got = (state or {}).get("swBuild")
    want = expected_build()
    if got != want:
        raise SystemExit(
            f"STALE SERVICE WORKER: swBuild={got!r} but the build is {want!r}. "
            "The profile's SW script cache is serving an old script. Fix: stop Chrome, "
            "delete <profile>/Default/'Service Worker' and <profile>/Default/'Code Cache', "
            "start Chrome again, re-run. (v1.3 Sep-17 lesson)"
        )
    log(f"swBuild {got} == the built version — the live worker IS the code just built")


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

    def sentinel_start(self, session_url, prompts):
        # prompts: the newline blob exactly as the popup textarea sends it
        return self.raw_send({"evt": "sw-sentinel-start", "sessionUrl": session_url, "prompts": prompts})

    def sentinel_stop(self, session_url):
        return self.raw_send({"evt": "sw-sentinel-stop", "sessionUrl": session_url})

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

    # the Sep-17 v1.3 guard: the live worker must BE the code just built
    # (a stale cached SW script otherwise answers for old code silently)
    assert_fresh_sw(popup.state())

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

    # ── M. SENTINEL: the runbook drives the session, one prompt per ──
    #    turn, in order, then completes (the v1.2 law) ────────────────
    log("M. sentinel runbook")
    cid_m, tab_m, tid_m = fresh_session("worker-sentinel")
    time.sleep(2.5)
    mur = f"{HARNESS}/c/{cid_m}"
    control(cid_m, "normal")
    tab_m.navigate(mur)  # idle shape: the turn is closed, composer free
    time.sleep(2.0)

    # arm a two-prompt runbook through the exact popup textarea shape
    r = popup.sentinel_start(mur, "first: build the flange mount\nsecond: ship it and summarize")
    check("M1 runbook armed (2 prompts)", bool(r and r.get("ok") and r.get("session", {}).get("sentinel", {}).get("total") == 2), str(r))

    def _first_landed(st_):
        s = session_by_url(st_ or {}, mur)
        return bool(s and "sentinel-send" in events_of(s) and any(t == "first: build the flange mount" for t in harness_messages(cid_m)))

    log("  pumping ticks through the grace until prompt 1/2 lands…")
    st = pump_until(popup, _first_landed, timeout_s=180, interval=5.0)
    sm = session_by_url(st or {}, mur)
    msgs = harness_messages(cid_m)
    check("M2 prompt 1 delivered (in order, first)", msgs.index("first: build the flange mount") == 0, str(msgs))
    check("M3 runbook advanced to 1/2", bool(sm and (sm.get("sentinel") or {}).get("sentCount") == 1), str((sm or {}).get("sentinel")))

    # the turn is open (the harness flipped to generating on the send);
    # close it, reload into the idle shape, and let the sentinel continue
    control(cid_m, "normal")
    tab_m.navigate(mur)
    time.sleep(2.0)

    def _complete(st_):
        s = session_by_url(st_ or {}, mur)
        return bool(s and "sentinel-complete" in events_of(s) and not s.get("sentinel"))

    log("  pumping ticks through the grace until prompt 2/2 lands and completes…")
    st = pump_until(popup, _complete, timeout_s=180, interval=5.0)
    sm = session_by_url(st or {}, mur)
    msgs = harness_messages(cid_m)
    check("M4 prompt 2 delivered after the second turn", sum(1 for t in msgs if t == "second: ship it and summarize") == 1, str(msgs))
    check("M5 prompts ran IN ORDER", msgs.index("first: build the flange mount") < msgs.index("second: ship it and summarize"), str(msgs))
    check("M6 sentinel-complete event + record cleared", bool(sm and "sentinel-complete" in events_of(sm) and not sm.get("sentinel")), str(events_of(sm)))

    # the diagnostics carry the sentinel story while one is armed
    r = popup.sentinel_start(mur, "third: one more for the diag")
    check("M7 second runbook armed", bool(r and r.get("ok")), str(r))
    d = popup.export_diag()
    text = (d or {}).get("text") or ""
    check("M8 diagnostics carry the runbook", "sentinel:" in text and "third: one more for the diag"[:20] in text, text[:300])
    r = popup.sentinel_stop(mur)
    check("M9 runbook stopped by the operator", bool(r and r.get("ok")), str(r))
    st = popup.state()
    sm = session_by_url(st, mur)
    check("M10 sentinel-stop event + record cleared", bool(sm and "sentinel-stop" in events_of(sm) and not sm.get("sentinel")), str(events_of(sm)))

    # ── N. THE KEEP-GOING LOOP (v1.3): the custom prompt + the Yes- ──
    #    request re-sent every turn; a simple Yes stops it ────────────
    log("N. sentinel keep-going loop")
    cid_n, tab_n, tid_n = fresh_session("worker-loop")
    time.sleep(2.5)
    nur = f"{HARNESS}/c/{cid_n}"
    control(cid_n, "normal")
    # a STALE "Yes" sits in the transcript from before arming — a fresh
    # loop must still SEND first (the Yes must answer OUR prompt)
    control(cid_n, "assistant-say", "Yes")
    tab_n.navigate(nur)  # idle shape: turn closed, transcript ends in "Yes"
    time.sleep(2.0)

    r = popup.raw_send({"evt": "sw-sentinel-start", "sessionUrl": nur, "mode": "loop", "prompt": "continue working on the roadmap"})
    sn = (r or {}).get("session", {}).get("sentinel") or {}
    check("N1 loop armed (mode+prompt)", bool(r and r.get("ok") and sn.get("mode") == "loop" and sn.get("prompt") == "continue working on the roadmap"), str(r))

    def _loop_first(st_):
        s = session_by_url(st_ or {}, nur)
        msgs = harness_messages(cid_n)
        return bool(
            s
            and (s.get("sentinel") or {}).get("sentCount", 0) >= 1
            and any(t.startswith("continue working on the roadmap") for t in msgs)
        )

    log("  pumping ticks through the grace until the loop message lands…")
    st = pump_until(popup, _loop_first, timeout_s=180, interval=5.0)
    msgs = harness_messages(cid_n)
    YES_REQ = 'If the entirety of the roadmap is implemented, reply with just "Yes" and nothing else.'
    check(
        "N2 the loop message = custom prompt + the Yes-request",
        any(t.startswith("continue working on the roadmap\n\n") and t.endswith(YES_REQ) for t in msgs),
        str(msgs)[:220],
    )
    check(
        "N3 the STALE pre-arm Yes did NOT stop the fresh loop",
        any(t.startswith("continue working on the roadmap") for t in msgs),
        str(msgs)[:220],
    )

    # the turn opened on the send; answer with a NON-Yes and close it
    control(cid_n, "assistant-say", "Working: 3 roadmap items remain.")
    control(cid_n, "normal")
    tab_n.navigate(nur)
    time.sleep(2.0)

    def _loop_second(st_):
        s = session_by_url(st_ or {}, nur)
        msgs = harness_messages(cid_n)
        return bool(
            s
            and (s.get("sentinel") or {}).get("sentCount", 0) >= 2
            and sum(1 for t in msgs if t.startswith("continue working on the roadmap")) >= 2
        )

    log("  pumping ticks until the loop sends AGAIN (the reply was not a Yes)…")
    st = pump_until(popup, _loop_second, timeout_s=180, interval=5.0)
    sm = session_by_url(st or {}, nur)
    check("N4 a non-Yes reply -> the custom prompt is sent AGAIN", bool(sm and (sm.get("sentinel") or {}).get("sentCount", 0) >= 2), str((sm or {}).get("sentinel")))

    # now the roadmap is done: the session replies a simple Yes
    sent_before_yes = sum(1 for t in harness_messages(cid_n) if t.startswith("continue working on the roadmap"))
    control(cid_n, "assistant-say", "Yes")
    control(cid_n, "normal")
    tab_n.navigate(nur)
    time.sleep(2.0)

    def _loop_done(st_):
        s = session_by_url(st_ or {}, nur)
        return bool(s and "sentinel-yes" in events_of(s) and "sentinel-complete" in events_of(s) and not s.get("sentinel"))

    log("  pumping ticks until the simple Yes stops the loop…")
    st = pump_until(popup, _loop_done, timeout_s=180, interval=5.0)
    sm = session_by_url(st or {}, nur)
    msgs = harness_messages(cid_n)
    sent_after_yes = sum(1 for t in msgs if t.startswith("continue working on the roadmap"))
    check("N5 the simple Yes -> sentinel-yes + complete + record cleared", bool(sm and "sentinel-yes" in events_of(sm) and not sm.get("sentinel")), str(events_of(sm)))
    check("N6 NOTHING is sent after the Yes", sent_after_yes == sent_before_yes, f"{sent_before_yes} before, {sent_after_yes} after")

    # diagnostics carry the loop story while one is armed; the operator
    # can stop a loop too
    r = popup.raw_send({"evt": "sw-sentinel-start", "sessionUrl": nur, "mode": "loop", "prompt": "keep going forever"})
    check("N7 second loop armed", bool(r and r.get("ok")), str(r))
    d = popup.export_diag()
    text = (d or {}).get("text") or ""
    check("N8 diagnostics carry the loop", "LOOP" in text and "waiting for a simple Yes" in text and "keep going forever" in text, text[:300])
    r = popup.raw_send({"evt": "sw-sentinel-stop", "sessionUrl": nur})
    st = popup.state()
    sm = session_by_url(st, nur)
    check("N9 loop stopped by the operator (record cleared)", bool(r and r.get("ok") and sm and not sm.get("sentinel")), str(events_of(sm)))

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
        cleanup_ids = [tid_e, tid_j, tid_k, tid_l, tid_m, tid_n, find_tab_id_for_session(cid_a)]
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
