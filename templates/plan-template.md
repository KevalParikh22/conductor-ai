# Plan: <feature name>

**Goal:** <what the user can do when this ships>
**Branch:** feat/<slug>
**Out of scope:** <not now>

## Design notes
<Concrete decisions by the controller: data shapes, function signatures, API contracts, file layout. Workers rely on these and must not make design decisions themselves.>

## Tasks

<!-- Tasks with no unmet `depends on` and no shared files can run in parallel (conductor batch). -->

### T1: <title>
- **role:** build | fix | test | docs | controller
- **status:** todo | done | failed
- **depends on:** none
- **files:** `src/...`, `src/....test.ts`
- **steps:**
  1. ...
- **acceptance:**
  - [ ] ...
- **verify:** `<command>`

### T2: <title>
- **role:** test
- **status:** todo
- **depends on:** T1
- **files:** `src/....test.ts`
- **steps:**
- **acceptance:**
- **verify:**
