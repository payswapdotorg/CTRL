/**
 * The decision ladder (DESIGN.md §3) — a PURE function from observed
 * facts to a typed plan. No browser APIs here; the background executes
 * the plan. Every branch cites the lesson it encodes.
 *
 * planAction() runs in up to two phases per tick:
 *   phase 1: facts = {tab, snapshot|null}          -> may request "probe"
 *   phase 2: facts = {...phase1, serverProbe}      -> final action
 */

import { STATUS, classifyUrl } from "./protocol.js";
import { resetIncident } from "./state.js";

/** Typed plan action kinds. */
export const ACTION = Object.freeze({
  NONE: "none",
  PROBE: "server-probe",        // ask the content sensor for the chats-API probe
  RELOAD: "reload",             // tabs.reload (safe — never disturbs the turn)
  NAVIGATE_BACK: "navigate-back", // tabs.update back to the session URL
  FRESH_TAB: "fresh-tab",       // close + create at the session URL (lesson 52/54)
  REOPEN: "reopen-tab",         // tab gone -> create at the session URL
  DISMISS: "dismiss-dialog",    // Cancel-only (operator rule)
  NOTIFY: "notify",
  EVENT_ONLY: "event-only",
});

/**
 * @typedef {Object} PlanInput
 * @property {number} now
 * @property {object} settings          normalized settings
 * @property {object} session           the record (mutated by applyPlan upstream)
 * @property {{exists:boolean,url?:string,title?:string,id?:number}|null} tab
 *                                      null = tabs.get failed/missing
 * @property {object|null} snapshot     content-sensor snapshot; null = no answer
 * @property {string|null} snapshotError 'timeout'|'error'|null
 * @property {object|null} serverProbe  phase-2 probe result:
 *   {ok:true, exists:boolean, updatedAt:number|null,
 *    hasAssistantPlaceholder:boolean|null} | {ok:false} | null
 */

/**
 * Compute the plan for one tick of one session.
 * @param {PlanInput} input
 * @returns {{action:string, reason:string, status?:string,
 *            notify?:{kind:string,message:string},
 *            events?:Array<{ts:number,kind:string,detail?:string}>,
 *            resetIncident?:boolean, probe?:boolean}}
 */
export function planAction(input) {
  const { now, settings, session, tab, snapshot, snapshotError, serverProbe } =
    input || {};
  const providerOrigin =
    input && typeof input.providerOrigin === "string"
      ? input.providerOrigin
      : "https://chat.z.ai";
  if (!now || !settings || !session) {
    return { action: ACTION.NONE, reason: "malformed-input" };
  }
  if (session.armed !== true) {
    return { action: ACTION.NONE, reason: "not-armed" };
  }

  // ── 1. TAB GONE ────────────────────────────────────────────────────
  if (!tab || !tab.exists) {
    if (settings.relaunchOnTabClose) {
      if (session.relaunchAttempts < settings.relaunchCap) {
        return plan(STATUS.RECOVERING, ACTION.REOPEN, "tab-closed", {
          relaunchAttempt: true,
          notify: {
            kind: "relaunched",
            message: `Session ${short(session.sessionId)} was closed — reopening it`,
          },
          events: [ev(now, "reopen", "tab closed; reopening at the session URL")],
        });
      }
      return plan(STATUS.GONE, ACTION.EVENT_ONLY, "tab-closed-budget", {
        notify: {
          kind: "gone",
          message: `Session ${short(session.sessionId)} was closed and its relaunch budget is exhausted`,
        },
        events: [ev(now, "gone", "tab closed; relaunch budget exhausted")],
      });
    }
    return plan(STATUS.GONE, ACTION.EVENT_ONLY, "tab-closed-no-reopen", {
      events: [ev(now, "gone", "tab closed; reopen-on-close disabled")],
    });
  }

  // ── 2. URL CLASSIFICATION ──────────────────────────────────────────────
  const cls = classifyUrl(tab.url || "", providerOrigin);

  if (cls.kind === "neterror") {
    return plan(STATUS.RECOVERING, ACTION.NAVIGATE_BACK, "net-error", {
      events: [ev(now, "net-error", "tab on a network-error page; navigating back")],
    });
  }

  if (cls.kind === "offsite") {
    // The user navigated this tab elsewhere deliberately — never hijack it.
    return plan(STATUS.GONE, ACTION.EVENT_ONLY, "offsite", {
      notify: {
        kind: "gone",
        message: `Session ${short(session.sessionId)}: its tab moved off chat.z.ai`,
      },
      events: [ev(now, "gone", "tab navigated off-site; not hijacking it")],
    });
  }

  if (cls.kind === "session") {
    if (cls.sessionId !== session.sessionId) {
      // Chat-id ROLL — the session lives, the provider re-keyed it
      // (lessons 51, 76, 95). Follow it; never treat as death.
      return plan(session.status, ACTION.EVENT_ONLY, "roll", {
        events: [ev(now, "roll", `chat id rolled ${short(session.sessionId)} -> ${short(cls.sessionId)}`)],
        roll: { sessionId: cls.sessionId, sessionUrl: `${settings.providerOrigin}/c/${cls.sessionId}` },
      });
    }
    // fall through to the liveness ladder
  } else {
    // home / sign-in / other on-site URL: the RETURNED path (DESIGN §4).
    return returnedPlan(input);
  }

  // ── 3. LIVENESS LADDER (tab is on its session URL) ─────────────────
  const freezeMs = settings.freezeSeconds * 1000;
  if (!snapshot) {
    // No content answer: count it. A renderer that answers nothing is the
    // wedged-renderer signature (lessons 3.19b, 52, 54, 105).
    session.consecutiveUnreachable = (session.consecutiveUnreachable || 0) + 1;
    if (session.consecutiveUnreachable >= settings.unreachableThreshold) {
      if ((session.unreachableReloads || 0) < 2) {
        return plan(STATUS.RECOVERING, ACTION.RELOAD, "unreachable", {
          unreachableReload: true,
          notify: {
            kind: "relaunched",
            message: `Session ${short(session.sessionId)} stopped responding — reloading`,
          },
          events: [ev(now, "unreachable-reload", `content channel silent x${session.consecutiveUnreachable}; reloading`)],
        });
      }
      if ((session.freshTabs || 0) < 2) {
        return plan(STATUS.RECOVERING, ACTION.FRESH_TAB, "unreachable", {
          freshTab: true,
          notify: {
            kind: "relaunched",
            message: `Session ${short(session.sessionId)} is wedged — opening a fresh tab`,
          },
          events: [ev(now, "unreachable-fresh-tab", "still silent after reloads; fresh tab")],
        });
      }
      return plan(STATUS.WEDGED, ACTION.EVENT_ONLY, "unreachable-budget", {
        notify: {
          kind: "wedged",
          message: `Session ${short(session.sessionId)} is wedged beyond recovery — needs your attention`,
        },
        events: [ev(now, "wedged", "unreachable past reload+fresh-tab budgets")],
      });
    }
    return plan(session.status, ACTION.EVENT_ONLY, "unreachable-count", {
      events: [ev(now, "unreachable", `content channel silent (${snapshotError || "no-answer"}), ${session.consecutiveUnreachable}/${settings.unreachableThreshold}`)],
    });
  }

  // The page answers. Reset the unreachable counter; classify honestly.
  session.consecutiveUnreachable = 0;

  // AUTH law: authentication is out of band (lesson 114, CTRL-014).
  if (snapshot.auth && snapshot.auth.state === "signed-out") {
    return plan(STATUS.AUTH_REQUIRED, ACTION.EVENT_ONLY, "auth", {
      notify: {
        kind: "auth",
        message: "chat.z.ai is signed out — sessions cannot be kept alive until you sign in again",
      },
      events: [ev(now, "auth", "signed-out (guest or no token); no recovery actions")],
    });
  }

  // Human verification is the human's gate (CTRL-014 continuation 23).
  const humanVerification = snapshot.humanVerification === true;
  if (humanVerification) {
    return plan(session.status, ACTION.EVENT_ONLY, "human-verification", {
      notify: {
        kind: "humanVerification",
        message: `Session ${short(session.sessionId)} is waiting on a human verification (captcha)`,
      },
      events: [ev(now, "human-verification", "Aliyun captcha popup present; left for the operator")],
    });
  }

  // Dialog law: Cancel-only dismissal (operator rules 2026-09-12).
  if (snapshot.dialog && snapshot.dialog.present && settings.dismissPopups) {
    if (snapshot.dialog.dismissible) {
      return plan(session.status, ACTION.DISMISS, "dialog", {
        events: [ev(now, "dialog-dismiss", `dialog present ("${trimTo(snapshot.dialog.text, 80)}"); clicking Cancel`)],
      });
    }
    return plan(session.status, ACTION.EVENT_ONLY, "dialog-undismissable", {
      notify: {
        kind: "stalled",
        message: `Session ${short(session.sessionId)} has a dialog without a Cancel control — needs your attention`,
      },
      events: [ev(now, "dialog", `dialog present, no cancel-vocabulary control ("${trimTo(snapshot.dialog.text, 80)}")`)],
    });
  }

  // Open-turn liveness (lesson 36 + 106).
  if (snapshot.turnOpen === true) {
    const sinceMutation = now - (snapshot.lastMutationAt || 0);
    if (sinceMutation < freezeMs) {
      // DOM activity within the window: LIVE, reset the incident.
      return plan(STATUS.LIVE, ACTION.EVENT_ONLY, "live", { resetIncident: true });
    }
    // DOM quiet — need the SERVER-side truth before any verdict.
    if (!serverProbe) {
      return plan(session.status, ACTION.PROBE, "dom-quiet", { probe: true });
    }
    if (serverProbe && serverProbe.ok === true) {
      // The placeholder law first — it is a STATE fact (single sample
      // decides; lesson 48): no assistant placeholder anywhere = queued,
      // NEVER a reload target.
      if (serverProbe.hasAssistantPlaceholder === false) {
        const queuedSince =
          typeof session.queuedSince === "number" && session.queuedSince > 0
            ? session.queuedSince
            : now;
        const quietMs = now - queuedSince;
        if (quietMs >= settings.stallSeconds * 1000) {
          return plan(STATUS.STALLED, ACTION.EVENT_ONLY, "queued-stalled", {
            notify: {
              kind: "stalled",
              message: `Session ${short(session.sessionId)} has been queued without starting for ${Math.round(quietMs / 60000)} min`,
            },
            events: [ev(now, "stalled", "queued (no assistant placeholder) past the stall window; not reloading (lesson 48)")],
          });
        }
        return plan(STATUS.QUEUED, ACTION.EVENT_ONLY, "queued", {
          observeServer: serverProbe.updatedAt || undefined,
          setQueuedSince: session.queuedSince ? undefined : now,
          events: [ev(now, "queued", "open turn with no assistant placeholder; waiting (never reload — lesson 48)")],
        });
      }
      const hadBaseline =
        typeof session.observedServerUpdatedAt === "number" &&
        session.observedServerUpdatedAt > 0;
      const serverMoved =
        hadBaseline &&
        typeof serverProbe.updatedAt === "number" &&
        serverProbe.updatedAt > session.observedServerUpdatedAt;
      if (!hadBaseline) {
        // FIRST probe: record the baseline, defer the verdict — a single
        // sample cannot distinguish silent generation from a freeze
        // (lesson 106 + the two-sample law, DESIGN §2.3).
        return plan(session.status, ACTION.EVENT_ONLY, "baseline", {
          observeServer: typeof serverProbe.updatedAt === "number" ? serverProbe.updatedAt : undefined,
          events: [ev(now, "baseline", "DOM quiet; server baseline recorded; verdict deferred to the next check")],
        });
      }
      if (serverMoved) {
        // Silent generation — minutes of DOM silence are NORMAL while the
        // worker works server-side (lesson 106).
        return plan(STATUS.LIVE, ACTION.EVENT_ONLY, "live-silent", {
          resetIncident: true,
          observeServer: serverProbe.updatedAt,
        });
      }
      // FROZEN with a placeholder: the lesson-37 ladder.
      if ((session.freezeReloads || 0) < 2) {
        return plan(STATUS.RECOVERING, ACTION.RELOAD, "frozen", {
          freezeReload: true,
          notify: {
            kind: "frozen",
            message: `Session ${short(session.sessionId)} froze mid-turn — reloading it`,
          },
          events: [ev(now, "freeze-reload", "open turn, DOM quiet, server updated_at frozen; reloading (lesson 37)")],
        });
      }
      if ((session.freshTabs || 0) < 2) {
        return plan(STATUS.RECOVERING, ACTION.FRESH_TAB, "frozen", {
          freshTab: true,
          notify: {
            kind: "frozen",
            message: `Session ${short(session.sessionId)} is still frozen — opening a fresh tab`,
          },
          events: [ev(now, "freeze-fresh-tab", "frozen after reloads; fresh tab (lesson 52/54)")],
        });
      }
      return plan(STATUS.FROZEN, ACTION.EVENT_ONLY, "frozen-budget", {
        notify: {
          kind: "frozen",
          message: `Session ${short(session.sessionId)} is frozen beyond page-level recovery — it needs a message from you`,
        },
        events: [ev(now, "frozen", "frozen past reload+fresh-tab budgets; needs a human continuation")],
      });
    }
    // Probe failed (API flap or auth) — record only, decide next tick.
    return plan(session.status, ACTION.EVENT_ONLY, "probe-failed", {
      events: [ev(now, "probe-failed", "server probe unavailable; deferring the verdict")],
    });
  }

  if (snapshot.turnOpen === false) {
    // No open turn: a session waiting for input is NOT frozen.
    return plan(STATUS.IDLE, ACTION.EVENT_ONLY, "idle", { resetIncident: true });
  }

  // turnOpen === null: unknown control shape — record only (fail-safe).
  return plan(session.status, ACTION.EVENT_ONLY, "unknown-turn-state", {
    events: [ev(now, "unknown", "turn state unknown (control locators matched nothing); no verdict")],
  });
}

/**
 * The RETURNED path (DESIGN §4) — the tab is on the provider origin but
 * NOT on a session URL.
 */
function returnedPlan(input) {
  const { now, settings, session, tab, snapshot, serverProbe } = input;
  // Phase 1: request the probe through the same tab (still on-origin).
  if (!serverProbe) {
    return plan(STATUS.RETURNED, ACTION.PROBE, "returned", { probe: true });
  }
  if (serverProbe && serverProbe.ok === true) {
    if (serverProbe.exists) {
      if (session.relaunchAttempts < settings.relaunchCap) {
        return plan(STATUS.RECOVERING, ACTION.NAVIGATE_BACK, "returned-alive", {
          relaunchAttempt: true,
          notify: {
            kind: "relaunched",
            message: `Session ${short(session.sessionId)} returned to the home page — taking it back`,
          },
          events: [ev(now, "returned-relaunch", "tab rolled off the session URL; chat alive in the chats list; navigating back")],
        });
      }
      return plan(STATUS.DEAD, ACTION.EVENT_ONLY, "returned-budget", {
        notify: {
          kind: "dead",
          message: `Session ${short(session.sessionId)} keeps rolling home — marked DEAD`,
        },
        events: [ev(now, "dead", "returned repeatedly past the relaunch cap")],
      });
    }
    // Absent from the LIST = destroyed server-side (lesson 97: the LIST
    // is truth). One deferral absorbs API lag/flap, then DEAD.
    const defer = (session.returnDeferrals || 0) + 1;
    if (defer <= 1) {
      return plan(STATUS.RETURNED, ACTION.EVENT_ONLY, "returned-absent-defer", {
        returnDeferral: true,
        events: [ev(now, "returned-absent", "absent from the chats list; one deferral for API lag")],
      });
    }
    return plan(STATUS.DEAD, ACTION.EVENT_ONLY, "returned-dead", {
      notify: {
        kind: "dead",
        message: `Session ${short(session.sessionId)} died server-side (absent from the chats list)`,
      },
      events: [ev(now, "dead", "absent from the chats list across two probes; DEAD")],
    });
  }
  // Probe failed: auth may be gone or the API flapped — no verdict.
  const authGone = snapshot && snapshot.auth && snapshot.auth.state === "signed-out";
  if (authGone) {
    return plan(STATUS.AUTH_REQUIRED, ACTION.EVENT_ONLY, "auth", {
      notify: {
        kind: "auth",
        message: "chat.z.ai is signed out — sign in to keep sessions alive",
      },
      events: [ev(now, "auth", "signed-out on return verification")],
    });
  }
  return plan(STATUS.RETURNED, ACTION.EVENT_ONLY, "returned-probe-failed", {
    events: [ev(now, "probe-failed", "return verification unavailable; deferring")],
  });
}

/** helpers */
function plan(status, action, reason, extra) {
  return Object.assign(
    { action, reason, status: typeof status === "string" ? status : undefined },
    extra || {}
  );
}
function ev(ts, kind, detail) {
  return { ts, kind, detail };
}
function short(id) {
  return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id || "?";
}
function trimTo(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
