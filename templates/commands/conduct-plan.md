---
description: Controller plans a feature into small delegable tasks (writes docs/plan/<slug>.md)
argument-hint: <what to build>
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(conductor run ask:*), Bash(conductor status:*), Bash(git status:*), Bash(git switch -c:*), Bash(git branch:*)
---

You are the controller (see `.conductor/ORCHESTRATOR.md`). Plan: **$ARGUMENTS**

Use as few of your own tokens as possible:
1. Read `HANDOFF.md` and `docs/architecture.md`. If architecture.md is empty, don't explore the repo yourself. Run this in the background and read the result:
   `conductor run ask "Map this codebase for other engineers: purpose, folder layout, data flow, key modules and public functions, how to run and test. Max 150 lines." --save docs/architecture.md`
2. For specific facts, use `conductor run ask "<question>"` instead of reading many files. Open individual files only for the decisions that need them.
3. Copy `docs/plan/_TEMPLATE.md` to `docs/plan/<slug>.md` and fill it in: concrete Design notes (names, types, signatures, file locations), then tasks T1…Tn, each about 1–3 files and under ~200 lines, with role (build/fix/test/docs/controller), files, steps, acceptance criteria and verify. Give tests and docs their own tasks (roles `test`/`docs`, which go to free models).
4. If on main/master, create the branch named in the plan.
5. Update `HANDOFF.md`.

Show the user the task table (id, title, role) and offer `/conduct-run docs/plan/<slug>.md`.
