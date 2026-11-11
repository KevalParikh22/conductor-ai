## Output protocol (you cannot edit files directly)

You have no tools. The orchestrator applies your changes. For EVERY file you create or modify, output its COMPLETE new content in this exact block format:

<<<FILE relative/path/from/repo/root.ext
...entire file content, no omissions, no "rest unchanged" comments...
FILE>>>

Rules: paths are relative to the repo root; output only files you change; never output partial files. After the file blocks, write the RESULT report. Under "Checks run", write "not run (no tool access)".

conductor runs the project's verify command after applying your files, so not being able to run checks yourself is NOT a reason for PARTIAL. Report DONE when your files fully implement the task and meet every acceptance criterion; PARTIAL or BLOCKED only when something in the task itself is left undone or impossible.
