# Plan: <feature name>

**Goal:** <what the user can do when this ships>
**Branch:** feat/<slug>
**Out of scope:** <not now>

## Open questions
<!-- Anything the user must decide, or that the controller couldn't settle from the code. conductor refuses to
     hand out write tasks while an item is unchecked. Resolve each one as: - [x] question → answer -->
- [ ] <question>

## Design notes
<Concrete decisions by the controller: data shapes, function signatures, API contracts, file layout. Workers rely on these and must not make design decisions themselves.>

## Tasks

<!-- Tasks with no unmet `depends on` and no shared files can run in parallel (conductor batch). -->

### T1: <title>
- **role:** build | fix | test | docs | controller
- **provider:** (optional) who takes it first, e.g. `codex-cli`. Leave it out to let routing rules and the smart selector decide
- **status:** todo | done | failed
- **eta:** (optional) how long it should take, e.g. `1h`. The worker is stopped at 2× this and the next provider runs
- **depends on:** none
- **files:** `src/...`, `src/....test.ts`
- **steps:**
  1. ...
- **acceptance:** (things a check can confirm: a return value, an HTTP status, a command that passes. Not "works". Code in backticks with exact names, e.g. `cartTotal([])` returns `0`: conductor checks those names exist. Workers answer each one with evidence)
  - [ ] ...
- **verify:** `<command>`
- **repro:** (fix tasks, optional) a command that fails now because of the bug and must pass after the fix, e.g. `npm test -- -t "empty cart"`. Without it, the worker must add a test that fails on the original code; conductor checks both

### T2: <title>
- **role:** test
- **status:** todo
- **depends on:** T1
- **files:** `src/....test.ts`
- **steps:**
- **acceptance:**
- **verify:**
