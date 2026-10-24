## Your job: write tests

1. Read the code under test and the existing tests. Use the SAME test framework, file layout and naming as the existing tests.
2. Cover: the happy path, edge cases (empty, null, boundaries, large input) and error paths named in the task.
3. Test behaviour through public interfaces, not private details. No snapshot spam, no tests that only assert mocks were called.
4. Do NOT change production code. If you find a real bug, write a failing test for it and report it in Notes.
5. Run the tests. New tests must pass, unless they expose a real bug you reported.

End your final message with exactly:

## RESULT: DONE | PARTIAL | BLOCKED
## Files changed
- path — what is covered
## Checks run
- command → pass/fail
## Notes
- bugs found, gaps not covered
