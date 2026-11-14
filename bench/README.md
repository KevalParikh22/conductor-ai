# Benchmarks

Claude Code alone (condition **A**) against Claude Code as the controller with conductor (condition **C**), on the same fixed plan, scored by hidden tests that neither Claude nor the workers see.

| Suite | What | Tasks |
|---|---|---|
| `pilot` | a small Node utility library (slugs, durations, LRU cache, pagination) | 6 small tasks, 12–22 s each for Claude alone; 4 independent, 2 build on earlier ones |
| `b2` | the order side of a bookshop library: cart, discounts, CSV import, order lifecycle, checkout | 5 bigger, multi-file tasks (spec'd to the cent); 4 independent, T5 needs T1 and T2 |

Each suite has `plan.md` (passes `conductor plan check`), `repo/` (the starting project, its own tests pass), `hidden/<suite>.hidden.test.js` (one top-level test per task, written from the plan before any run) and `solution/` (a reference solution, used only by `check`).

```bash
node bench/run.mjs check --suite b2                         # fair? every task fails on the start, passes on the solution (no model)
node bench/run.mjs C --suite b2 --model sonnet              # Claude as controller: /conduct-run on the whole plan
node bench/run.mjs A --suite b2 --model sonnet --max-cost 3 # Claude alone, one task at a time, stops at the cost limit
```

`--suite` defaults to `pilot`. Every Claude call is `claude -p --output-format json`: the tokens (input, output, cache read and write) and the equivalent cost it reports are the measurement. Worker usage in C (now including Codex and OpenCode tokens) comes from conductor's run summaries. Results land in `bench/results/<date>-[<suite>-]<condition>.json`.

**Before spending quota:** run `check`, then C first (cheaper on Claude), then A one task at a time with `--max-cost`. A and C don't have to run in the same usage window. Note your plan's usage before and after. One repo per suite doesn't support general claims: label results as what they are.

**B2 estimate (from the pilot's measured numbers):** about $2–4 equivalent for one A and one C run; ×3 for repeated runs.
