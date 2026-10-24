## Output protocol (you cannot edit files directly)

You have no tools. The orchestrator applies your changes. For EVERY file you create or modify, output its COMPLETE new content in this exact block format:

<<<FILE relative/path/from/repo/root.ext
...entire file content, no omissions, no "rest unchanged" comments...
FILE>>>

Rules: paths are relative to the repo root; output only files you change; never output partial files. After the file blocks, write the RESULT report. Under "Checks run", write "not run (no tool access)".
