---
name: conduct-plan
description: "Controller plans a feature into small delegable tasks (writes docs/plan/<slug>.md)"
argument-hint: "<what to build>"
disable-model-invocation: true
allowed-tools: "Read, Write, Edit, Glob, Grep, Bash(conductor run ask:*), Bash(conductor status:*), Bash(conductor plan check:*), Bash(git status:*), Bash(git switch -c:*), Bash(git branch:*)"
---

You are the controller (see `.conductor/ORCHESTRATOR.md`). Plan: **the arguments the user gave**

Use as few of your own tokens as possible:
1. Read `HANDOFF.md` and `docs/architecture.md`. If architecture.md is empty, don't explore the repo yourself. Run this in the background and read the result:
   `conductor run ask "Map this codebase for other engineers: purpose, folder layout, data flow, key modules and public functions, how to run and test. Max 150 lines." --save docs/architecture.md`
2. For specific facts, use `conductor run ask "<question>"` instead of reading many files. Open individual files only for the decisions that need them.
3. **Clarity first.** Before designing, list what is still ambiguous: behaviour the request doesn't pin down, choices with real trade-offs, missing facts about the code. Settle what you can from the code (via `conductor run ask`). Ask the user the rest in one short batch of questions and wait for the answers. Record every item under `## Open questions` as `- [x] question → answer`. conductor refuses to hand out write tasks while any item is still `- [ ]`. If nothing was ambiguous, write `- [x] none`.
4. Copy `docs/plan/_TEMPLATE.md` to `docs/plan/<slug>.md` and fill it in: concrete Design notes (names, types, signatures, file locations), then tasks T1…Tn, each about 1–3 files and under ~200 lines, with role (build/fix/test/docs/controller), `depends on`, files, steps, acceptance criteria and verify. Avoid giving two independent tasks the same file, so they can run in parallel. Give tests and docs their own tasks (roles `test`/`docs`, which go to free models).
5. Run `conductor plan check docs/plan/<slug>.md` and fix every ✗ it reports. conductor refuses to hand out a task that fails it. Each write task needs: `files:`, acceptance criteria a check can confirm (a return value, an HTTP status, a command that passes; never "works" or "done"), a verify command, and at most 4 files besides tests. Workers repeat the criteria back with evidence, so write them precisely.
6. If on main/master, create the branch named in the plan.
7. Update `HANDOFF.md`.

Show the user the task table (id, title, role, depends on), which tasks can run in parallel, and offer `/conduct-run docs/plan/<slug>.md`.
