# AGENTS.md: rules for every AI working in this repo

Claude Code, Gemini CLI, Codex CLI, OpenCode, Kimi and API models all follow this file. It is the single source of truth.

## 1. Project facts (fill in once)

- **What this is:** <one or two sentences>
- **Stack:** <e.g. Next.js + TypeScript, Postgres via Prisma>
- **Run locally:** `<command>`
- **Verify (must pass before any task is "done"):** `<e.g. npm run lint && npm test>`
- **Architecture:** see `docs/architecture.md`
- **Never touch:** <e.g. applied migrations, .env*, vendor/>

## 2. Conventions

- <naming, folder layout, error handling, logging, testing conventions>

<!-- conductor:rules:start -->
## 3. How to work (the quality bar)

1. **Read before you write.** Open the files you change and their callers. Match existing patterns. Never guess at an API, file or function you have not seen.
2. **Stay in scope.** Only the assigned task. No drive-by refactors, renames or reformatting. Report other problems instead of fixing them.
3. **Small, complete diffs.** No TODO stubs, placeholder logic or commented-out code.
4. **No new dependencies** unless the task says so.
5. **Handle the unhappy path.** Validate at boundaries; handle empty, null, large and error cases explicitly.
6. **Tests prove it.** Add or update tests for changed behaviour, and run the Verify command. Not done until it passes.
7. **Never fake success.** If checks fail or you could not finish, say so with the error output.
8. **Security.** No hard-coded secrets, no logging of tokens, parameterised queries, escaped output.
9. **Comments explain why, not what.**

## 4. Team protocol

One AI is the **controller** (default: Claude Code). It plans, delegates, reviews and commits. The others are **workers**, called through `conductor`.

Workers:
- Do only the task id you were given; read its plan file in `docs/plan/` first.
- Never `git commit`/`push`/`checkout`/`stash`/`reset`.
- Never edit `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `HANDOFF.md`, `docs/plan/*`, `.claude/`, `.gemini/`, `.agents/`, `.conductor/`.
- End with the report format given in your prompt (`## RESULT: DONE | PARTIAL | BLOCKED` …).

Shared state: `docs/plan/<feature>.md` (plan, owned by the controller) · `HANDOFF.md` (current state; read it first) · `docs/architecture.md` (codebase map).
<!-- conductor:rules:end -->
