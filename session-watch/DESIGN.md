# Session Watchdog — Design

The operator's problem, in their words: *"I have to keep watch on my
sessions myself or they die or freeze or just return."* This document maps
every field-proven chat.z.ai failure mode (the replay2 campaign's
`AGENT_BOOT_PROMPT.md`, lessons 1–122, plus the CTRL-014 live-observed DOM
surface) onto one extension architecture, then specifies the exact decision
ladder the extension executes.

## 1. Shape

A Manifest V3 WebExtension, one source tree, three build variants:

| variant | background | manifest deltas | install |
| --- | --- | --- | --- |
| `build/chrome` | service worker (classic bundle) | — | Chrome + Opera (load unpacked / zip) |
| `build/firefox` | event page (`background.scripts`) | `browser_specific_settings.gecko` | Firefox (temporary add-on / zip / signed) |
| `build/test` | service worker | adds `http://127.0.0.1:8099/*` (the harness origin) to matches/host permissions | loaded into the replay Chrome for E2E |

Source is ES modules (repo convention, `node --test` unit-testable); the
bundler emits single-file classic IIFE bundles so the same code runs in a
non-module Chrome service worker and a Firefox event page without any
namespace polyfill (a small promise wrapper around `chrome.*`, which all
three browsers implement, replaces the heavyweight webextension-polyfill).

Components:

- **content script** (`src/content/content.js`) — the page sensor: DOM
  liveness, dialog facts, auth facts, and the same-origin server-side probe
  (chats API). Read-only except the explicitly bounded Cancel-only dialog
  dismissal. No provider knowledge beyond the LIVE-OBSERVED locator table.
- **background** (`src/background/`) — the watcher brain: a per-session
  decision ladder (pure, unit-tested) executed on a 60 s alarm and on
  tab events; typed recovery actions; persisted state (`storage.local`);
  notifications; badge.
- **popup** — the operator surface: session list with per-session watch
  toggles (this is how sessions are "connected"), statuses, event log,
  settings.

## 2. Ground-truth laws (each one is a lesson)

1. **The tab URL is the provider's routing state** (CTRL-014 continuation
   16): a tab on `/c/<uuid>` holds that session; a redirect to
   `https://chat.z.ai/` is the **server's death/return certificate**
   (lessons 31, 51, 111) — but chat **ids roll** (lessons 51, 76, 95), so
   sessions are tracked by tab + last-known-good session URL, and an
   id change that stays on `/c/` is a ROLL to follow, never a death.
2. **`GET /api/v1/chats/list` is the existence truth** (lessons 97, 99):
   the detail endpoint flaps 500 under strain; the LIST (raw array,
   string-searchable, Bearer auth from `localStorage.token` — lesson 46:
   the raw JWT, never `JSON.parse`) decides whether a returned session is
   alive (navigate back) or destroyed (bounded relaunch, then DEAD).
3. **Liveness during an open turn** (lessons 36, 106): DOM mutation
   activity says "the renderer streams"; the chat's server-side
   `updated_at` movement says "the worker works". A **freeze verdict needs
   BOTH frozen**: open turn (the Stop control — CTRL-014's live-observed
   `div[data-tooltip-trigger][aria-label="Stop"]` family) + no DOM
   mutations for the freeze window + server `updated_at` unchanged across
   two samples. Silent stretches of minutes are NORMAL (lesson 106) —
   which is exactly why the server-side signal is required.
4. **Reloads are safe; fresh tabs recover wedged renderers** (lessons
   3.19b, 37, 52, 54, 67, 105): a reload never disturbs the server-side
   turn and resyncs the UI to server truth; a renderer that stops
   answering (content-channel timeout) is recovered by reload, then by a
   fresh tab at the SAME session URL (the conversation persists
   server-side).
5. **Never reload a chat whose server tree has NO assistant placeholder**
   (lesson 48): a queued/placeholder-less chat is client-unrenderable after
   a reload — the watchdog reports QUEUED and, after a long quiet window,
   STALLED, but never touches such a tab.
6. **Dialogs: Cancel only, never their instructions** (operator rules
   2026-09-12; lessons 34, 45, 92): a visible `role="dialog"` on a watched
   tab is dismissed by clicking its Cancel-labelled control — never
   "Switch to GLM-5.3-Flash", never OK/Continue on model-switch dialogs,
   never the Aliyun captcha slider (that is the human's gate, CTRL-014
   continuation 23). Undismissable dialogs are reported, not pressed.
7. **Authentication is out of band** (CTRL-014 boundary; lesson 114): a
   guest token (`guest-…@guest.com` in the JWT payload) or a visible
   "Sign in" surface means AUTH_REQUIRED — record + notify, never act.
8. **Bounded recovery, never grinding** (lessons 40, 61, 71, 89): every
   automatic action has a cap with backoff; a session that exceeds its
   relaunch budget goes to a terminal status with one notification. The
   anti-treadmill doctrine — retries re-arm provider limits — applies to
   page-level relaunches too.
9. **Sessions survive browser restarts** (lessons 52, 105): arm records
   persist in `storage.local`, keyed by session URL; on startup the
   watcher rebinds tabs by URL and (if reopen-on-close is enabled)
   reopens missing ones.
10. **`body.innerText` lies on virtualized transcripts** (lesson 5): the
    sensor uses a MutationObserver (childList + characterData) and control
    facts (Stop control, composer, send control), not absolute text
    length; the mid-generation DOM-length collapse (lesson 84) is normal
    and never a death signal.

## 3. The decision ladder (per armed session, per tick)

Executed by `planAction()` — a PURE function (unit-tested with injected
facts), called by the background up to twice per tick (phase 2 only when
the ladder asks for a server probe).

```
tick(session S):
  T = tabs.get(S.tabId)
  ── T missing ──────────────────────────────────────────────────────────
    settings.relaunchOnTabClose && S.relaunchAttempts < cap
      → REOPEN: create tab at S.sessionUrl (background index), rebind,
        event "tab-closed → reopened", notify (throttled)
    else → status GONE (or DEAD if budget exhausted), event
  ── T exists: classify T.url ──────────────────────────────────────────
    net-error / chrome-error://            → NAVIGATE back to S.sessionUrl
    off-site (not chat.z.ai)               → status GONE + notify
                                              (never hijack the user's tab)
    session URL /c/<id>:
      id ≠ S.sessionId                     → ROLL: follow (update record),
                                              event "chat-id rolled"
    home / sign-in / other on-site URL     → RETURNED path (see §4)
  ── on a session URL: ping the content sensor (8 s timeout) ───────────
    no answer (timeout/error):
      S.consecutiveUnreachable++
      ≥ threshold (default 3):
        unreachableReloads < 2   → RELOAD (lesson 37), event, reset counter
        else if freshTabs < 2    → FRESH TAB (close + create at sessionUrl,
                                    lesson 52/54), rebind, event
        else                     → status WEDGED + notify, stop acting
      else → record only
    answer (snapshot):
      S.consecutiveUnreachable = 0
      auth signed-out            → status AUTH_REQUIRED, notify (30 min
                                    cooldown), NO recovery actions
      human-verification popup   → event + notify-once (human gate)
      dialog.present && dismissPopups
                                  → DISMISS (Cancel-only, §2 law 6)
      turnOpen:
        DOM mutations within freeze window        → LIVE (reset incident)
        else ask phase-2 probe:
          server updated_at moved                → LIVE (silent generation,
                                                    lesson 106)
          frozen && assistant placeholder exists  → FROZEN:
              freezeReloads < 2                  → RELOAD (lesson 37)
              else if freshTabs < 2              → FRESH TAB
              else                               → status FROZEN + notify
                                                    (needs a human message)
          frozen && NO assistant placeholder     → QUEUED (lesson 48: never
                                                    reload); quiet past the
                                                    stall window → STALLED +
                                                    notify
      no open turn                          → IDLE (reset incident
                                                    counters)
  persist + badge
```

Tab events sharpen the loop in real time: `tabs.onUpdated` runs the URL
classification immediately (a ROLL or RETURNED is detected within seconds,
not at the next tick); `tabs.onRemoved` runs the tab-closed path; the
content script announces itself on every page load (`content-ready`) which
confirms recovery after every reload/relaunch (event "recovered",
counters reset).

## 4. The RETURNED path (the operator's "just return")

1. Classify: watched tab now on a non-session chat.z.ai URL (home,
   sign-in, …) while its record holds a session URL.
2. Server probe through the SAME tab (it is still on the chat.z.ai
   origin, so the in-page fetch carries the account token):
   `GET /api/v1/chats/list?limit=100` → does the session id exist?
   - **exists** → the chat lives server-side: NAVIGATE the tab back to the
     session URL (the relaunch). Event + notification. Bounded by the
     relaunch cap; a session that keeps bouncing home past the cap goes
     DEAD.
   - **absent** → retry once next tick (the API flaps — lesson 97);
     still absent → status DEAD + notification. The popup keeps a manual
     "Relaunch anyway" affordance (the list can lag).
   - **probe failed / auth gone** → no verdict this tick; repeated failure
     → AUTH_REQUIRED + notify.

## 5. The sensor (content script)

LIVE-OBSERVED locators (CTRL-014 `ZAI_LOCATORS`, verified live on
2026-09-16 against the authenticated surface):

- composer `#chat-input`, send `#send-message-button`
- Stop control family: `[data-tooltip-trigger][aria-label="Stop"] button`,
  `[data-tooltip-trigger][aria-label^="The current task is in progress"] button`,
  `button[aria-label="Stop"]`, `button[title="Stop"]`
- dialog channel `[role="dialog"], dialog`, alerts `[role="alert"]`
- assistant rows `.chat-assistant`; user rows
  `[class*="user"][class*="message"]`-family
- human-verification popup `#aliyunCaptcha-window-popup` (report only)
- auth: `localStorage.getItem('token')` raw JWT → payload email;
  `guest-*@guest.com` or absent → signed-out

Every fact degrades explicitly (`turnOpen: null` = unknown) — a rotted
selector can only lose sensitivity, never manufacture a freeze verdict
(fail-safe). The snapshot answers the background's `snapshot` command;
`serverProbe` fetches the chats LIST (+ detail best-effort for the
placeholder fact); `dismissDialog` clicks ONLY a cancel-vocabulary control
(`Cancel`, `取消`, `Dismiss`, `Close`, `×`) inside the topmost visible
dialog — a dialog without a cancel-vocabulary control is reported
undismissable and never pressed.

The mutation sensor: a `MutationObserver` on `document.body`
(childList + characterData, throttled 250 ms) maintaining
`lastMutationAt` — cheap, virtualization-proof, and the exact "DOM growth"
signal the replay monitors used (lesson 36).

## 6. State & settings

`storage.local` keys: `watchdog.settings`, `watchdog.sessions` (arm records
keyed by session URL; bounded 50-event ring each), `watchdog.events`
(global bounded ring, 200). Defaults: tick 60 s, freeze window 6 min,
unreachable threshold 3, stall window 30 min, relaunch cap 3, autoWatch
ON, reopen-on-close ON, popup dismissal ON, notifications ON. Every
setting is validated + clamped on write (never trusted from storage).

## 7. Testing strategy

1. **Unit** (`node --test`): the pure ladder — verdicts, roll following,
   return classification, the placeholder law, Cancel-vocabulary law, auth
   gating, bounded budgets, event-ring bounds, settings clamping, restart
   rebinding. Injected fakes, zero network (repo convention).
2. **Harness** (`test/harness/`): a deterministic chat.z.ai mock on
   `127.0.0.1:8099` reproducing the REAL DOM shapes (the same locator
   family, a streaming transcript, Stop/send slot swap, a bits-ui-style
   dialog with Cancel, the token-bearing chats LIST API) plus controls to
   trigger every failure mode: freeze, return, die server-side, wedge the
   renderer, popup, login death, chat-id roll, tab close.
3. **E2E in the replay session** (`test/e2e/replay_e2e.py`): CDP-driven —
   loads `build/test` into the replay Chrome (unpacked, login preserved per
   lesson 114), arms sessions through the real popup surface (opened as a
   tab, CTRL-014 lesson 50/72 style), triggers every harness failure mode,
   and asserts the watchdog's recovery end-to-end. A final pass runs the
   sensor against the real authenticated `https://chat.z.ai` surface.

"Works perfectly" = every failure mode in §2 recovers (or reports, when
the law forbids action) in the E2E run, with zero false positives on the
live surface.

## 8. The keep-going ladder (v1.1 — the 2026-10-14 live failure)

The operator's live report: *"it returned without finishing and the watcher
didn't do anything to relaunch it."* Post-mortem: a turn that dies mid-task
(the provider's stream just ends — no error banner, the composer quietly
re-enables) is DOM-identical to a finished turn. v1.0.7's ladder called
that state IDLE — healthy by definition — and stayed silent. §3's ladder
only knew two incidents: frozen OPEN turns and tabs that rolled home.

**The v1.1 law: an idle composer on an armed session is a QUESTION, not a
verdict.** After a quiet grace window the relaunch message is SENT
(per-session override → global default → `"continue"`). The send is a
bounded actuation, not a fact:

- **Guards, in order** (recovery.js `keepGoingPlan`):
  1. a pending (in-flight/failed) send owns the window — no double queue;
  2. keep-going OFF (setting off, or the resolved message is "") → IDLE;
  3. a human draft in the composer → IDLE, paused — we never clobber text;
  4. inside the grace (`turnEndGraceSeconds`, default 90) → IDLE, waiting.
- **Transition-independence**: `idleSince` is set at the FIRST observation
  of a free composer, not at an observed generating→idle EDGE — a
  service-worker restart or a throttled tab must never hide the incident
  (the exact shape of the live failure). The DOM-mutation clock backs the
  grace up: a mutating page (someone typing, something streaming) waits.
- **The actuation** (content.js `sw-send-message`): re-checks turn-closed,
  no-dialog, no-draft at send time; types React-safely (native value setter
  + input event); clicks the observed send control; verifies the turn
  actually opened; on a failed submit clears OUR text back out (a leftover
  draft would stall the ladder). Never mid-generation, never through a
  dialog, never over a captcha.
- **The budget**: sends are counted; the budget resets ONLY on an observed
  OPEN turn (LIVE) — productive continues are infinite by design, and a
  blocked-send loop accumulates to the cap and terminates in
  **NEEDS_INPUT** ("it needs a human"), with transport retries bounded
  (3 attempts / 10 min TTL) by the pendingMessage record.
- The RETURNED path (§4) queues the same message via `pendingMessage`
  once the tab is back on its session URL — one queue, two entry points.

## 9. The alert engine (v1.1 — "ring an alarm on my Ubuntu laptop")

Kinds map to channels (protocol.js `ALARM_SIREN_KINDS` / `ALARM_CHIME_KINDS`):

- **failure kinds** (dead, gone, wedged, frozen, auth, stalled,
  humanVerification, needsInput) → OS notification (with a Silence button)
  + a **looping synthesized siren** + email/webhook/ntfy, re-ringing every
  `alarmRepeatMinutes` until a human acknowledges (or 30 min hard stop);
- **relaunched** (the watchdog acted: turn-end send, return recovery…) →
  a short chime + the same async channels.

Laws: the engine never throws into the ladder (fire-and-forget, outcomes
logged); the siren plays through a `chrome.offscreen` AUDIO_PLAYBACK
document (Firefox: a visible flashing alarm tab with the same sound and a
STOP button); email goes through the Brevo API with the operator's own key
(stored locally, **redacted in every diagnostic export** — `src/diag.js`);
ntfy.sh and a generic webhook are optional zero/low-setup push channels.

## 10. Naming + diagnostics (v1.1)

- `labelOf(session)`: operator name → first-user-message hint → short id.
  Every notification, alarm banner and the popup is name-aware.
- The diagnostic dump (`sw-export-diag` → popup "copy diagnostics"):
  version, redacted settings, per-session verdicts/counters/pending
  messages + bounded event trails, global events. Paste-ready for an
  issue; secrets never leave the machine.

## 11. The sentinel runbook (v1.2 — the 2026-10-15 operator direction)

The operator's words: *"I think a better idea would be to have the
extension setup a sentinel that runs the prompts just like we've been
doing."* v1.1's keep-going answers "a turn ended, what do I say?" with
ONE repeated message. The sentinel upgrades the operator's seat: hand
the extension the whole list of prompts — the runbook — and it drives
the session the way the operator would by hand: prompt, wait for the
turn to complete, next prompt, in order, to the end.

**The record** (state.js, pure helpers): `session.sentinel` is `null`
or `{queue, total, sentCount, startedAt}`. The queue holds the REMAINING
prompts (front = next); it rides `storage.local`, so a runbook survives
browser restarts (law 9) and chat-id rolls (the record follows the
roll). `sanitizeSentinelPrompts` never trusts input: trim, drop blanks,
cap each prompt at MESSAGE_MAX, cap the count at SENTINEL_MAX_PROMPTS.

**The ladder** (recovery.js `sentinelPlan`, reached from keep-going
guard 2 — BEFORE the keep-going OFF switches): a live runbook OVERRIDES
`relaunchOnTurnEnd=false` and any per-session keep-going message — the
operator explicitly asked for THESE prompts. Everything else is the same
law as keep-going:

- a pending (in-flight/failed) send still owns the window — one queue,
  two entry points (idle composer, RETURNED navigate-back);
- a human draft PAUSES the runbook (never clobber — the sentinel waits);
- the same quiet grace (`turnEndGraceSeconds` — one clock, one knob);
- the same bounded budget: a turn reopening RESETS it (productive
  runbooks are infinite by design); a blocked-send loop terminates in
  NEEDS_INPUT with the queue **INTACT** — the operator's manual
  relaunch (which resets the budget) resumes the runbook where it
  stuck; the notification names the position ("sentinel stuck at 3/7").

**The actuation** is the v1.1 `sw-send-message` path unchanged — free
composer only, React-safe typing, verified turn-open. On a CONFIRMED
delivery the queue advances (`advanceSentinel` — a text that is not the
queue head never consumes a prompt, so a manual relaunch message cannot
eat the runbook). The LAST prompt's delivery completes the runbook:
`sentinel-complete` event + a "sentinel" CHIME (the watchdog acted, it
did not cry for help) through the same throttled notify path (cooldown
5 min). Afterwards the normal ladder keeps watching the final turn
(freeze detection, and keep-going if the last response stops early).

**The surfaces**: the popup card carries a "sentinel…" editor (one
prompt per line — the exact shape the E2E drives) with a live
"3/7 · next: …" progress line and a stop button; the diagnostics dump
carries the runbook position; `sw-sentinel-start` / `sw-sentinel-stop`
are the typed popup→background events. A fresh runbook supersedes any
stale pending send and opens a fresh budget.
