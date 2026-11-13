# Pilot benchmark

Claude Code alone (condition **A**) against Claude Code as the controller with conductor (condition **C**), on the same fixed plan, scored by hidden tests that neither Claude nor the workers see.

- `pilot/plan.md`: 6 tasks in a small Node library (4 independent, 2 that depend on earlier ones), all passing `conductor plan check`.
- `pilot/repo/`: the starting project. `pilot/hidden/`: the hidden tests, one per task. `pilot/solution/`: a reference solution, used only by `check`.

```bash
node bench/run.mjs check                                    # fair? fails on the start, passes on the solution (no model)
node bench/run.mjs C --model sonnet                         # Claude as controller: /conduct-run on the whole plan
node bench/run.mjs A --model sonnet --max-cost 1.50         # Claude alone, one task at a time, stops at the cost limit
```

Every Claude call is `claude -p --output-format json`: the tokens (input, output, cache read and write) and the equivalent cost it reports are the measurement. Worker usage in C comes from conductor's run summaries. Results land in `bench/results/<date>-<condition>.json`.

Run C first (cheap on Claude), then A one task at a time. Note your plan's usage before and after. Label results "pilot": one repo and six tasks don't support general claims.
