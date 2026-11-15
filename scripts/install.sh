#!/usr/bin/env bash
# conductor-ai installer: checks Node, installs conductor globally from npm (or GitHub), runs first-time setup.
#   curl -fsSL https://raw.githubusercontent.com/KevalParikh22/conductor-ai/main/scripts/install.sh | bash
# Options (environment): CONDUCTOR_REF=<branch|tag|commit> installs that version from GitHub instead of npm.
set -euo pipefail

REPO="KevalParikh22/conductor-ai"
REF="${CONDUCTOR_REF:-}"
say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 20+ is required: https://nodejs.org (or: nvm install 22)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || die "Node.js 20+ is required (found $(node -v)). Upgrade, e.g.: nvm install 22"
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"
command -v git >/dev/null 2>&1 || die "git is required"

if [ -n "$REF" ]; then SRC="github:$REPO#$REF"
elif npm view conductor-ai version >/dev/null 2>&1; then SRC="conductor-ai"
else SRC="github:$REPO#main"; fi   # before the first npm release
say "Installing conductor-ai ($SRC) with npm"
if ! npm install -g "$SRC"; then
  die "npm install failed. If it was a permissions error, use a Node version manager (nvm, fnm) instead of sudo."
fi
command -v conductor >/dev/null 2>&1 || die "installed, but 'conductor' is not on your PATH. Add \"\$(npm prefix -g)/bin\" to PATH."

say "First-time setup"
conductor setup

cat <<'NEXT'

Done. Next:
  conductor providers --free     free chat APIs you can add (kilo-free already works, no key)
  conductor add <name>           add one: key, model, test, roles (guides: docs/providers/)
  cd my-app && conductor init    set up a project
  conductor doctor --live        check everything
  conductor ui                   settings page
Coding agents (optional): see docs/providers/README.md (Antigravity, Codex, OpenCode, Copilot, Grok, Kiro, Aider, Goose, Kimi, Claude Code).
NEXT
