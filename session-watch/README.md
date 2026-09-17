# Session Watchdog — the chat.z.ai session keeper

**Operator directive (2026-09-16, zai-web session `web-c180605c-f0a5-4a62-bd96-4fe05592804e`):**

> "write an extension that will watch over my chat.z.ai sessions and relaunch
> them when they freeze or return, I should be able to connect multiple
> sessions to the extension and it should be installable in firefox, opera
> and chrome. test the extension in the replay session until it works
> perfectly, and use the lessons you've learnt working on chat.z.ai [...]
> this is a different project, which should be pushed to
> payswapdotorg/controller. the issue I'm currently having is that I have to
> keep watch on my sessions myself or they die or freeze or just return. I
> launch sessions in firefox, opera and chrome mostly."

This directory is that project: a standalone, operator-facing browser
extension. It is **independent of the governed CTRL work-item roadmap** (it
does not touch `controller/` or `extension/` — the CTRL-014 tree) and exists
on the direct operator authority quoted above.

## What it does

The operator runs long chat.z.ai sessions (agent tasks, generation turns)
in Chrome, Opera and Firefox. Observed failure modes (each one is a
field-proven lesson from the replay2 campaign, `AGENT_BOOT_PROMPT.md`
lessons 1–122):

| Failure mode | Field evidence | Watchdog response |
| --- | --- | --- |
| **stop mid-task** — the turn ends, the composer idles, the task is unfinished (the 2026-10-14 live failure) | operator report | **keep-going**: after a quiet grace window, send the relaunch message ("continue" or your own — per session); failed sends retry, then NEEDS_INPUT + alarm |
| **the operator's own seat** — driving a session prompt-by-prompt by hand (the 2026-10-15 direction: "a sentinel that runs the prompts just like we've been doing") | operator report | **the sentinel runbook (v1.2)**: give each session a list of prompts — the extension sends them one per turn, in order, to the end, then chimes |
| **"is the roadmap done yet?"** — keep driving until the work is COMPLETE, not until a list runs out (the 2026-10-15 direction: "if it receives a simple Yes then it should stop, otherwise it keeps sending in the custom prompt") | operator report | **the keep-going loop (v1.3)**: one custom prompt, re-sent every turn with a request to reply a short "Yes" when the entirety of the roadmap is implemented — a simple Yes stops it and chimes |
| **freeze** — renderer wedges / turn freezes mid-stream | lessons 3.19b, 36, 52, 54, 67 | detect (open turn + no DOM mutation + frozen server `updated_at`), then reload; escalate to fresh tab at the same session URL |
| **return** — tab rolls back to `https://chat.z.ai/` (home) | lessons 31, 51, 60, 76, 89(a), 95, 111 | verify the chat server-side via the in-page chats LIST API; if it exists navigate the tab back to the session URL **and send the relaunch message** |
| **die** — session destroyed server-side (absent from chats list) | lessons 28, 60, 87, 97, 98 | bounded relaunch attempts, then DEAD status + notification (manual relaunch stays available) |
| **tab closed / browser restarted** | lessons 52, 54, 105 | reopen the tab at the session URL (toggleable) |
| **capacity/dialog popups** covering the composer | lessons 34, 45, 92 | dismiss via Cancel only (never "Switch to GLM-5.3-Flash", never captcha sliders), toggleable |
| **login death** (guest token) | lesson 114 | record + notify — authentication is always the human's action |
| **queued turn with no assistant placeholder** | lessons 48, 89(d) | never reload such a chat (a reload wedges it); report STALLED after a long quiet window |
| **chat id rolls** while the session lives | lessons 51, 76, 95 | track sessions by tab + URL, follow the roll |

## Alarms & email (v1.1)

When a session **returns** or the watchdog **fails to recover** it:

- an **OS notification** appears (on Ubuntu via the desktop notification
  stack — make sure Chrome notifications are allowed in the OS settings) —
  with a **Silence alarm** button;
- a **sound alarm** rings: failures loop a siren until you acknowledge it
  (notification button, popup, or the alarm page); relaunches chime once.
  Chrome/Opera play it through an offscreen document; Firefox opens a
  flashing alarm tab with a STOP button;
- an **email** can go to `team@payswap.org` (or any address) through the
  [Brevo](https://www.brevo.com) API (free tier): create an account,
  verify a sender (e.g. `watchdog@payswap.org`), then paste the API key
  (`xkeysib-…`) into Settings → *Alarms & email* → *Test email*. The key is
  stored locally only and is **redacted in every diagnostics export**;
- optional **ntfy.sh** topic (zero-setup push — install the ntfy app or
  open `https://ntfy.sh/<topic>` in a browser) and a **generic webhook**
  (JSON POST) for anything else.

## The sentinel runbook (v1.2)

Instead of watching a session and reacting, the sentinel **drives** it —
the extension in the operator's seat:

1. On any session card, click **sentinel…** and paste your prompts — one
   per line (e.g. `build the flange mount`, then `continue`, `continue`,
   `ship it and summarize`).
2. Click **start**. The card shows live progress (`▸ sentinel 2/4 · next:
   continue`).
3. The sentinel sends the next prompt whenever the composer is free
   past the turn-end grace — one prompt per turn, in order, exactly like
   you driving the session by hand. A runbook runs even when keep-going
   is OFF (you asked for these prompts); a half-typed human draft pauses
   it (never clobbered); the queue survives browser restarts and chat-id
   rolls.
4. When the last prompt is delivered: a **sentinel-complete** event + a
   short chime; the normal watchdog keeps watching the final turn.
5. If sends fail to reopen the turn past the relaunch cap: NEEDS_INPUT
   (siren + email) with the queue **kept** — fix the cause, hit
   *relaunch*, and the runbook resumes where it stuck. **stop** drops
   the queue on demand.

The diagnostics dump carries the runbook position (`sentinel: 2/4
delivered, 2 queued; next: …`).

## The keep-going loop (v1.3)

The runbook knows the list; the loop knows the GOAL. Pick **keep-going
loop (until a Yes)** in the sentinel editor, type ONE custom prompt
(e.g. `continue working on the roadmap`), and start:

1. Every send is your prompt + a fixed request: *"If the entirety of
   the roadmap is implemented, reply with just "Yes" and nothing
   else."* — the stop condition rides every message.
2. A reply that is anything other than a simple **Yes** (a progress
   report, "almost done", code, prose) means the work continues: your
   prompt is sent again next turn, for as long as it takes. A
   half-typed human draft still pauses it; the loop survives restarts
   and chat-id rolls.
3. The moment the session replies exactly **Yes** (wrapped at most in
   punctuation/emphasis), the loop STOPS: the record clears, a short
   chime + notification announces "replied a simple Yes — the roadmap
   is complete (N prompts delivered)", and nothing is ever sent
   after the Yes.
4. The card shows live state: `▸ sentinel loop · 3 sent · waiting for
   a simple Yes`. If sends fail past the relaunch cap: NEEDS_INPUT
   with the loop **kept** for a manual resume; **stop** drops it.

A simple Yes is strictly the word alone — "Yes", "yes.", "**YES**!"
count; "Yes, and here's the summary" does not (the loop keeps going).
The diagnostics dump carries the loop line (`sentinel: LOOP · 3 sent ·
waiting for a simple Yes; prompt: …`).

## Install

Requires [bun](https://bun.sh) (or node ≥ 20) to build.

```sh
cd session-watch
bun run build          # produces build/chrome, build/firefox, build/test + dist zips
```

- **Chrome**: `chrome://extensions` → Developer mode → *Load unpacked* →
  select `build/chrome`. (For a packed install: use `dist/session-watchdog-chrome.zip`.)
- **Opera**: `opera://extensions` → Developer mode → *Load unpacked* →
  select `build/chrome` (Opera is Chromium-based; the Chrome build runs
  unchanged).
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on…* → pick ANY file inside `build/firefox` (e.g. `manifest.json`).
  For a permanent install use `dist/session-watchdog-firefox.zip` via
  `about:addons` → *Install Add-on From File…` (or sign it with
  `web-ext sign` — the gecko id is `session-watchdog@payswap.org`).

## Use

1. Pin the extension (toolbar) and open its popup.
2. Any tab that lands on a `chat.z.ai/c/<session>` URL is armed
   automatically (auto-watch, toggleable); the popup lists every connected
   session with a live status chip and a per-session watch toggle — connect
   as many sessions as you like.
3. **Name your sessions**: each card has a name field (or use the automatic
   hint from the first message); notifications, alarms and the diagnostics
   are name-aware.
4. **Per-session relaunch message**: each card can inherit the global
   default (`continue`), use a custom message, or turn keep-going OFF.
5. **Sentinel runbooks**: each card runs a prompt list for you — see
   *The sentinel runbook* above.
6. **Keep-going loops**: each card can also run ONE custom prompt in a
   loop until the session replies a simple "Yes" — see *The keep-going
   loop* above.
7. Statuses: `LIVE` (streaming), `IDLE` (waiting for input), `FROZEN`,
   `RECOVERING`, `RETURNED`, `QUEUED`, `STALLED`, `NEEDS_INPUT` (relaunch
   budget exhausted — it needs a human), `DEAD`, `AUTH_REQUIRED`, `GONE`,
   `WEDGED`. The event log shows every automatic action with timestamps.
8. Settings (popup → gear): check cadence, freeze threshold, relaunch cap,
   keep-going (grace window + message), alarms & email, popup dismissal,
   reopen-on-close, notifications.
9. **Diagnostics**: footer → *copy diagnostics* — a redacted, paste-ready
   dump (version, settings, per-session verdicts and events) for bug
   reports.

## Development

```sh
bun run test          # unit tests (node --test) — the decision ladder
bun run build         # all three build variants + dist zips
python3 test/harness/server.py   # the deterministic chat.z.ai mock on :8099
python3 test/e2e/replay_e2e.py   # CDP-driven end-to-end suite (replay session)
```

See `DESIGN.md` for the full lesson→mechanism mapping and the decision
ladder specification.
