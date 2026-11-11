# conductor eval tasks

Fixed tasks that measure conductor itself: `conductor eval run` hands each to workers the way a user would, then scores the result against tests the worker never saw.

## A task

```
<id>/
  eval.json    title, role (build | fix | test), difficulty, tags
               score: "hidden" (default) or "mutants"; protect: files the worker must not change
  plan.md      a plan with one task, T1 (must pass `conductor plan check`)
  repo/        the starting project (Node, no dependencies, `npm test` = node --test)
  hidden/      tests copied in only after the worker finishes (score "hidden")
  mutants/<m>/ buggy versions of the code; the worker's tests must fail on each (score "mutants")
  solution/    the reference solution, used only by the self-check
```

## Rules for adding one

- **It must be fair:** `conductor eval check --tasks <id>` must pass. That means the score fails on `repo/` and passes once `solution/` is copied over it.
- **The plan says everything the hidden tests check.** Hidden tests are there to catch work that looks right but isn't, not to test things the task never asked for.
- **Keep it small:** one task, 1–2 files, minutes for a capable model.
- **Cover what goes wrong in real runs:** off-by-one errors, edge cases, async mistakes, mutation, scope creep, tests that test nothing.
