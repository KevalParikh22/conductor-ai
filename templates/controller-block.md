<!-- conductor:start -->
{{IMPORT}}
## Conductor: you are the controller

This project uses **conductor-ai** to delegate work to other LLMs (Antigravity, Codex, OpenCode, free Kilo and OpenRouter models, ...) and save your own usage. You plan, decide, review and commit; workers do the bulk typing.

**Scope:** these rules apply while a `/conduct-*` command runs, or when the user asks you to delegate. Otherwise work normally. Your own skills, subagents and tools are not replaced.

How to delegate (full playbook: `.conductor/ORCHESTRATOR.md`):
- CLI: `conductor run <role> --plan docs/plan/<f>.md --task T3` (run in the background, since it can take minutes), or the `conductor_run` MCP tool.
- Roles: `build` `fix` `test` `docs` (write code) · `review` `ask` (read-only). Each role has a fallback chain the user set in `conductor ui`.
- Never trust a worker's report: check `conductor diff` and the verify result yourself before committing.
- Exit code 3 (every provider failed), or the same task failing twice: do it yourself.
- Keep your context small: read the summary and the RESULT block, not whole logs. Use `conductor run ask` for codebase questions instead of reading many files.
<!-- conductor:end -->
