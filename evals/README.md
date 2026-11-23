# conductor-ai eval tasks

Fixed tasks that measure conductor-ai itself: `conductor-ai eval run` hands each to workers the way a user would, then scores the result against tests the worker never saw.

## A task

```
<id>/
  eval.json    title, role (build | fix | test), difficulty, tags
               score: "hidden" (default) or "mutants"; protect: files the worker must not change
  plan.md      a plan with one task, T1 (must pass `conductor-ai plan check`)
  repo/        the starting project (Node, no dependencies, `npm test` = node --test)
  hidden/      tests copied in only after the worker finishes (score "hidden")
  mutants/<m>/ buggy versions of the code; the worker's tests must fail on each (score "mutants")
  solution/    the reference solution, used only by the self-check
```

## Rules for adding one

- **It must be fair:** `conductor-ai eval check --tasks <id>` must pass. That means the score fails on `repo/` and passes once `solution/` is copied over it.
- **The plan says everything the hidden tests check.** Hidden tests are there to catch work that looks right but isn't, not to test things the task never asked for.
- **Keep it small:** one task, 1–2 files, minutes for a capable model.
- **Cover what goes wrong in real runs:** off-by-one errors, edge cases, async mistakes, mutation, scope creep, tests that test nothing.

## Is a change real or noise?

One run per task can't tell a real gain from model randomness: the same worker passes a task on Monday and fails it on Tuesday. Run each task several times:

```bash
conductor-ai eval run --repeat 5 --label before
conductor-ai eval run --repeat 5 --label after --compare <before>
```

- `--repeat N` runs each task N **independent** times, each in a fresh copy. `--samples N` is different: N attempts on different providers inside **one** run, keeping the best (best-of-N). The two combine.
- Per task and overall the report shows passes/runs, the pass rate (pass@1) and its 95% Wilson interval, e.g. `7/10 = 70% [95% CI 40–89%]`. With `--repeat` above 1 it also shows pass@k (k = `--pass-k`, default N): the chance at least one of k runs passes, by the unbiased estimator 1 − C(n−c,k)/C(n,k).
- `--compare` adds **likely real** when each run's pass rate lies outside the other's interval, else **within noise**. Old saved reports still compare.
- Test-writing tasks also get a **mutation score**: planted bugs caught / planted, so a test suite that catches 4 of 5 shows progress even though it fails.
- With `--lessons <file>`, later repeats of a task see the lessons earlier repeats saved, so they are not fully independent; use the default per-task lessons or `--no-lessons` for clean error bars.

## Do lessons help? (A/B)

Each eval task runs in a fresh repo, so lessons would be lost between runs. A lesson store carries them over, task by task:

```bash
conductor-ai eval run --lessons /tmp/lessons.jsonl --label learn      # run 1: learns from its failures
conductor-ai eval run --lessons /tmp/lessons.jsonl --label with       # run 2: those lessons are in the prompts
conductor-ai eval run --no-lessons --label without --compare <with>   # control: no lessons at all
```

The report marks each task that had lessons in its prompt and compares those tasks with the same tasks in the compared run. Ten tasks on free models vary from run to run, so read one A/B as a hint, not proof; add `--repeat 5` and read the compare's "likely real" / "within noise".

