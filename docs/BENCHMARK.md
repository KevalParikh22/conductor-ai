# Benchmark: pilot (2026-11-13)

**A pilot, not a general claim:** one small Node library, six tasks, one run per condition. The full benchmark (three repos, three stacks, three runs each) is still to come. The raw data is in [`bench/results/`](../bench/results/), and anyone can rerun it with [`bench/run.mjs`](../bench/run.mjs).

## Setup

- **Tasks:** [`bench/pilot/plan.md`](../bench/pilot/plan.md). Six tasks in a small ES-module library: slugify, a duration parser, an LRU cache, a pagination bug fix, and two tasks that build on earlier ones. Four are independent and two depend on earlier tasks.
- **Scoring:** hidden tests that neither Claude nor the workers see, written before the run (`node bench/run.mjs check` proves each fails on the starting code and passes with the reference solution).
- **A, Claude alone:** Claude Code does each task itself, one call per task.
- **C, Claude + conductor:** Claude Code is the controller and runs `/conduct-run` on the same fixed plan. Workers do the tasks in parallel worktrees, and Claude reviews, merges and runs the final verify.
- **Measured** with `claude -p --output-format json`, which reports tokens and an equivalent cost per call.
- **Versions:** Claude Code 2.1.317 (Sonnet); workers Antigravity CLI 1.5.8 and OpenCode 2.0.32 (free model); conductor at this commit.

## Results

| Claude (Sonnet) | A: Claude alone | C: Claude + conductor | Change |
|---|---|---|---|
| Equivalent cost | $0.625 | **$0.272** | **−56%** |
| Output tokens | 9,932 | **2,060** | **−79%** |
| Cache read | 1,276,765 | **352,365** | **−72%** |
| Cache write | 99,529 | **5,645** | **−94%** |
| Wall-clock | **107 s** | 623 s | 5.8× slower |
| Hidden tests passed | 6/6 | 6/6 | same |
| Human interventions | 0 | 0 | |

**In C, the workers did the coding:**
- **Antigravity:** T1, T3 and T4.
- **OpenCode (free):** T2, T5 and T6. Antigravity hit its quota on T5, and conductor moved the task to OpenCode on its own.

Five of six tasks were accepted on the first try. Worker tokens totalled 669k, on plans that cost nothing extra here. The final independent review found no free reviewer available (two timeouts, one 503), so Claude reviewed the diffs itself.

## After the speed fixes (same day, same plan)

The first C run spent its time in two places: **agy took up to 299 s on a small task** that OpenCode's free model did in 35 s, and **185 s went to dead free reviewers** (two timeouts and a 503). Four changes followed:
1. **Speed-aware routing:** for small tasks, conductor's measured run times now order the workers: fastest *and* reliable first. In this history, OpenCode ~38 s vs agy ~253 s on `build`. Big tasks keep the order you chose.
2. **Batch spreads a wave** by expected finish time, with at most 2 tasks per provider.
3. **`/conduct-run` skips the extra end-of-plan review** when every task passed its checks the first time (risky work is still reviewed per task).
4. **A free route that times out twice cools down,** so the next call doesn't wait on it again.

| C: Claude + conductor | First run | After the fixes | **Codex back** | A: Claude alone |
|---|---|---|---|---|
| Wall-clock | 623 s | 137 s | **151 s** | 107 s |
| Claude cost | $0.272 | $0.276 | **$0.293** | $0.625 |
| Hidden tests | 6/6 | 6/6 | **6/6** | 6/6 |
| Workers | agy ×3, OpenCode ×3 (+ agy quota hit) | OpenCode ×6 | **OpenCode ×3, Codex ×3** (agy quota hit, Codex took over) | — |

**Read with care:**
- **"After the fixes"** ran with agy and Codex both out of quota, so OpenCode did everything.
- **"Codex back"** ran after the cold-start fix, with Codex on a fresh account. Codex had no history yet, so it counted as average, got real work (three tasks in 26–47 s), and the wave was split between two fast providers.
- **The speed gain held either way:** 137–151 s against 623 s.
- **The Claude saving held at 53–56%,** with 6/6 every time.
- **On tasks this small, Claude alone is still about 1.4× faster.**
- **Not measured yet:** Codex and OpenCode don't report their token counts to conductor, so the workers' share is known only for agy.

## What it means

- **Claude quota: the claim holds on this pilot.** Claude spent 56% less (72% fewer tokens), and the result was equally correct. Most of the saving is Claude Code's fixed overhead: each call reads about 150–235k tokens of its own context, and A made six calls where C made one.
- **Time: close, after the speed fixes.** The first run was 5.8× slower than Claude alone. After routing small tasks to the fastest reliable worker and skipping dead reviewers, it was 1.3–1.4× slower (137–151 s vs 107 s) in two runs with different workers available. On small tasks, expect conductor to save quota, not minutes.
- **Quality held,** and the work was checked rather than assumed: every task passed verify, and conductor proved each regression test against the original code.

## Not yet shown

- Larger tasks, where Claude's own time per task grows and parallel workers may win on time.
- Other stacks (Python, PHP), repeated runs, and the spread between runs.
- Condition B (conductor one task at a time).

## How the run went

Two earlier attempts at C stopped because of the harness, not conductor:
- The temporary repository had no git identity, so every merge failed. Claude asked instead of guessing, which was correct. The harness now sets an identity, as any real project has.
- The second attempt is the one that showed what was going on: the harness now records any tool call Claude was refused.

Both are excluded. A dry run before the pilot also found and fixed a conductor bug: the export check held a task to other tasks' exports.
