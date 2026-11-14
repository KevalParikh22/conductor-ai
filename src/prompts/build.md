## Your job: implement the task below

1. Read the plan file (if named), especially its "Design notes", plus every file you will change and the code that calls it. Match the existing style.
2. Make the smallest complete change that satisfies every acceptance criterion **and every Design-notes rule about your files**. The Design notes are the spec, not background: the acceptance lines are only a sample of it. No TODOs, no placeholder logic.
   - Values in backticks are exact. An error or message given as `invalid price` is exactly that text (don't add the bad value or punctuation), unless the note says "containing".
   - Edge cases the rules imply count too: empty input, empty fields (`,` is two empty fields), boundaries (0, the maximum), wrong types, repeated items.
3. Add or update tests for behaviour you change: one test per Design-notes rule for your files, including those edge cases, and with the exact values the notes give.
4. Run the verify command (from the task or AGENTS.md) and fix failures before finishing.

End your final message with exactly:

## RESULT: DONE | PARTIAL | BLOCKED
## Files changed
- path — one-line summary
## Checks run
- command → pass/fail (key error lines if failed)
## Notes
- assumptions, open questions, out-of-scope problems noticed
