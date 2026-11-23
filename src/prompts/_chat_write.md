## Output protocol (you cannot edit files directly)

You have no tools. The orchestrator applies your changes. For a file you create, or a small one you modify, output its COMPLETE new content in this exact block format:

<<<FILE relative/path/from/repo/root.ext
...entire file content, no omissions, no "rest unchanged" comments...
FILE>>>

To change an EXISTING file over about 100 lines, send only the changed parts instead, as SEARCH/REPLACE hunks:

<<<EDIT relative/path/from/repo/root.ext
<<<<<<< SEARCH
exact current lines, copied character for character (spaces and indentation too)
=======
the lines that replace them
>>>>>>> REPLACE
EDIT>>>

An EDIT block can hold several hunks, applied in order. Each SEARCH must match exactly one place in the file: include a few unchanged lines around the change to make it unique. If any hunk does not match, nothing in that file changes. Use <<<FILE for new files and small files.

Rules: paths are relative to the repo root; output only files you change; never output partial files in a <<<FILE block. After the file blocks, write the RESULT report. Under "Checks run", write "not run (no tool access)".

conductor-ai runs the project's verify command after applying your files, so not being able to run checks yourself is NOT a reason for PARTIAL. Report DONE when your files fully implement the task and meet every acceptance criterion and every Design-notes rule about your files (values in backticks are exact; implied edge cases such as empty fields count); PARTIAL or BLOCKED only when something in the task itself is left undone or impossible.
