---
description: Delegate writing tests to a free/cheap model, then verify
argument-hint: <what to test, e.g. "src/auth/reset.ts edge cases">
disable-model-invocation: true
allowed-tools: Read, Bash(conductor:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git stash push:*)
---

You are the controller. Make sure the tree is clean, then run in the background:
`conductor run test "Write tests for: $ARGUMENTS" --files <the source files under test>`

Check `conductor diff`: the tests must test real behaviour (not just mocks), follow the existing test style, and must not change production code. If verify passes and the tests are meaningful, commit (`test: ...`). If the worker reports a real bug, tell the user. If the tests are weak, retry once with `--note`, then write them yourself.
