/**
 * The diagnostic dump (v1.1 — operator 2026-10-14): "when it failed to
 * recover a session I want to copy the logs and paste them back."
 *
 * PURE text assembly (no browser APIs) so it is unit-testable: the
 * background feeds it version/settings/sessions/globalEvents and hands
 * the string to the popup, which copies it to the clipboard.
 *
 * Law: SECRETS NEVER LEAVE. The email API key is redacted to its last
 * four characters; nothing else in the record is a credential.
 */

import { labelOf } from "./state.js";
import { NAME_MAX, MESSAGE_MAX } from "./protocol.js";

/**
 * Redact a settings object for export (pure).
 * @returns {object} a shallow copy with secrets masked
 */
export function redactSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const out = {};
  for (const k of Object.keys(s)) out[k] = s[k];
  if (typeof out.emailApiKey === "string" && out.emailApiKey.length > 0) {
    const tail = out.emailApiKey.slice(-4);
    out.emailApiKey = `••••••••${tail} (redacted, ${out.emailApiKey.length} chars)`;
  }
  return out;
}

function iso(ts) {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function trimTo(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * Build the copy-paste diagnostics dump (pure).
 * @param {{version:string, now:number, bootedAt?:number, settings:object,
 *          sessions:object[], globalEvents?:object[],
 *          alarmInfo?:object}} input
 * @returns {string}
 */
export function buildDiagDump(input) {
  const i = input || {};
  const settings = redactSettings(i.settings);
  const sessions = Array.isArray(i.sessions) ? i.sessions : [];
  const globalEvents = Array.isArray(i.globalEvents) ? i.globalEvents : [];
  const lines = [];

  lines.push("=== Session Watchdog diagnostics ===");
  lines.push(`version: ${i.version || "?"}`);
  lines.push(`generated: ${iso(i.now || 0)}`);
  if (i.bootedAt) lines.push(`background booted: ${iso(i.bootedAt)}`);
  if (i.alarmInfo) lines.push(`alarm: ${JSON.stringify(i.alarmInfo)}`);
  lines.push("");
  lines.push("--- settings (secrets redacted) ---");
  for (const k of Object.keys(settings).sort()) {
    lines.push(`${k}: ${JSON.stringify(settings[k])}`);
  }
  lines.push("");
  lines.push(`--- sessions (${sessions.length}) ---`);
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    lines.push(`## ${labelOf(s)}  [${s.status || "?"}]${s.armed === false ? " (DISARMED)" : ""}`);
    lines.push(`  sessionUrl: ${s.sessionUrl || "?"}`);
    lines.push(`  name: ${trimTo(String(s.name || ""), NAME_MAX)} | titleHint: ${trimTo(String(s.titleHint || ""), NAME_MAX)} | title: ${trimTo(String(s.title || ""), 120)}`);
    lines.push(`  tabId: ${s.tabId} turnOpen: ${JSON.stringify(s.turnOpen)} lastMutationAt: ${s.lastMutationAt ? iso(s.lastMutationAt) : 0}`);
    lines.push(`  idleSince: ${s.idleSince ? iso(s.idleSince) : 0} relaunchAttempts: ${s.relaunchAttempts || 0} (cap ${settings.relaunchCap})`);
    lines.push(`  counters: unreachable=${s.consecutiveUnreachable || 0} reloads(u/f)=${s.unreachableReloads || 0}/${s.freezeReloads || 0} freshTabs=${s.freshTabs || 0} returnDeferrals=${s.returnDeferrals || 0}`);
    lines.push(`  lastReason: ${s.lastReason || "?"}`);
    if (s.relaunchMessage !== null && s.relaunchMessage !== undefined) {
      lines.push(`  relaunchMessage(own): ${JSON.stringify(trimTo(String(s.relaunchMessage), MESSAGE_MAX))}`);
    }
    if (s.pendingMessage && typeof s.pendingMessage === "object") {
      lines.push(`  pendingMessage: ${JSON.stringify(trimTo(String(s.pendingMessage.text || ""), 80))} attempts=${s.pendingMessage.attempts || 0} setAt=${iso(s.pendingMessage.setAt || 0)}`);
    }
    const evts = Array.isArray(s.events) ? s.events.slice(-12) : [];
    if (evts.length > 0) {
      lines.push("  events (newest last):");
      for (const e of evts) {
        lines.push(`    ${iso(e.ts)} ${e.kind}: ${trimTo(String(e.detail || ""), 200)}`);
      }
    }
    lines.push("");
  }
  lines.push("--- global events (newest last, bounded) ---");
  for (const e of globalEvents.slice(-40)) {
    lines.push(`${iso(e.ts)} ${e.kind}: ${trimTo(String(e.detail || ""), 200)}`);
  }
  lines.push("");
  lines.push("=== paste this block into the CTRL issue to debug a failed recovery ===");
  return lines.join("\n");
}

function counters(s, key) {
  return s && typeof s[key] === "number" ? s[key] : 0;
}
