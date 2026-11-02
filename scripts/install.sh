#!/usr/bin/env bash
# conductor-ai installer: checks Node, installs conductor globally from GitHub, runs first-time setup.
#   curl -fsSL https://raw.githubusercontent.com/KevalParikh22/conductor-ai/main/scripts/install.sh | bash
# Options (environment): CONDUCTOR_REF=<branch|tag|commit> to install a specific version.
set -euo pipefail

REPO="KevalParikh22/conductor-ai"
REF="${CONDUCTOR_REF:-main}"
say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 20+ is required: https://nodejs.org (or: nvm install 22)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || die "Node.js 20+ is required (found $(node -v)). Upgrade, e.g.: nvm install 22"
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"
command -v git >/dev/null 2>&1 || die "git is required"

say "Installing conductor-ai ($REF) with npm"
if ! npm install -g "github:$REPO#$REF"; then
  die "npm install failed. If it was a permissions error, use a Node version manager (nvm, fnm) instead of sudo."
fi
command -v conductor >/dev/null 2>&1 || die "installed, but 'conductor' is not on your PATH. Add \"\$(npm prefix -g)/bin\" to PATH."

say "First-time setup"
conductor setup

cat <<'NEXT'

Done. Next:
  1. Install at least one worker agent and sign in, e.g.
       curl -fsSL https://antigravity.google/cli/install.sh | bash && agy
       npm install -g @openai/codex && codex login
     (free API providers like kilo-free need no install)
  2. In a project:   cd my-app && conductor init
  3. Check:          conductor doctor --live
  4. Settings page:  conductor ui
NEXT
