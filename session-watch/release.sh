#!/usr/bin/env bash
# release.sh — push the watchdog and publish the GitHub release with the
# packed installers (the v1.0.7/v1.1.0 flow, scripted so it is ONE
# command once the PAT is in place).
#
# Credentials: $OPERATOR_PAT (or $GITHUB_TOKEN), falling back to
#   /home/z/my-project/scripts/env.sh  (export OPERATOR_PAT=…)
# The token is never echoed. Repo: payswapdotorg/ctrl.
#
# Usage:  bash release.sh          # push main + tags, create the release
set -euo pipefail

REPO="payswapdotorg/ctrl"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── the PAT (never printed) ──────────────────────────────────────────
PAT="${OPERATOR_PAT:-${GITHUB_TOKEN:-}}"
if [ -z "$PAT" ] && [ -f /home/z/my-project/scripts/env.sh ]; then
  PAT="$(sed -n 's/^\s*\(export\s\)\?\(OPERATOR_PAT\|GITHUB_TOKEN\)=//p' /home/z/my-project/scripts/env.sh | tail -1 | tr -d '"' | tr -d "'")"
fi
if [ -z "$PAT" ]; then
  echo "ERROR: no PAT. Re-issue one (repo: read/write + contents) and either:"
  echo "  export OPERATOR_PAT=ghp_…                       (this shell)"
  echo "  echo 'export OPERATOR_PAT=ghp_…' >> /home/z/my-project/scripts/env.sh"
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo "releasing ${REPO} ${TAG}"

# sanity: the version must be built and the zips must exist
bash -c '[ -d build/chrome ] && [ -d build/firefox ] && [ -f dist/session-watchdog-chrome.zip ] && [ -f dist/session-watchdog-firefox.zip ]' \
  || { echo "ERROR: run 'bun run build' first (dist zips missing)"; exit 1; }

AUTH="Authorization: Bearer ${PAT}"

# ── verify the token works (prints only the login) ───────────────────
LOGIN="$(curl -sf -m 15 -H "$AUTH" https://api.github.com/user | python3 -c 'import json,sys; print(json.load(sys.stdin).get("login") or "")')"
if [ -z "$LOGIN" ]; then
  echo "ERROR: the PAT is not valid (github.com/user answered without a login)"
  exit 1
fi
echo "authenticated as: ${LOGIN}"

# ── push main + the tag through the tokened remote ───────────────────
PUSH_URL="https://${PAT}@github.com/${REPO}.git"
git push "${PUSH_URL}" main
git push "${PUSH_URL}" "refs/tags/${TAG}"

# ── the release with both installers ─────────────────────────────────
NOTES="$(cat <<EOF
Session Watchdog v${VERSION} — the sentinel runbook

**The sentinel (v1.2):** the extension now runs the prompts for you —
"just like we've been doing." Each session card takes a runbook (one
prompt per line); the sentinel sends them one per turn, in order, to
the end, then chimes. Same laws as keep-going: never over a human
draft, same quiet grace, bounded budget (a reopened turn resets it);
a stuck runbook keeps its queue for a manual relaunch to resume, and
the queue survives browser restarts and chat-id rolls. Also in v1.2:
the popup no longer wipes half-typed input on its 2s refresh.

Install: Chrome/Opera — load \`build/chrome\` unpacked (or the chrome
zip); Firefox — temporary add-on from \`build/firefox\` (or the firefox
zip). Full notes: session-watch/DESIGN.md §11.
EOF
)"
PAYLOAD="$(python3 - "$TAG" "$NOTES" <<'PYEOF'
import json, sys
print(json.dumps({
    "tag_name": sys.argv[1],
    "name": f"Session Watchdog {sys.argv[1]}",
    "body": sys.argv[2],
    "draft": False,
    "prerelease": False,
}))
PYEOF
)"
REL="$(curl -sf -m 20 -X POST -H "$AUTH" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/${REPO}/releases -d "$PAYLOAD")"
REL_ID="$(echo "$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

for Z in dist/session-watchdog-chrome.zip dist/session-watchdog-firefox.zip; do
  curl -sf -m 120 -X POST \
    -H "$AUTH" -H "Content-Type: application/zip" \
    --data-binary "@${Z}" \
    "https://uploads.github.com/repos/${REPO}/releases/${REL_ID}/assets?name=$(basename "$Z")" > /dev/null
  echo "attached ${Z}"
done

echo "released ${TAG}: https://github.com/${REPO}/releases/tag/${TAG}"
