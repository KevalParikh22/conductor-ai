import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpdir(prefix = 'conductor-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Isolated CONDUCTOR_HOME. Call before importing src modules. */
export function isolateHome() {
  const home = tmpdir('conductor-home-');
  process.env.CONDUCTOR_HOME = home;
  for (const k of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'ANTHROPIC_API_KEY', 'MOCK_API_KEY', 'KILO_API_KEY', 'OPENCODE_API_KEY']) delete process.env[k];
  return home;
}

export function makeRepo({ branch = 'feat/x', files = {} } = {}) {
  const dir = tmpdir('conductor-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node -e "process.exit(0)"' } }));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git('add', '-A'); git('commit', '-qm', 'init');
  if (branch) git('switch', '-qc', branch);
  return { dir, git };
}

/** Create fake CLI binaries (node scripts) and prepend them to PATH. */
export function fakeBins(scripts) {
  const bin = tmpdir('conductor-bin-');
  for (const [name, body] of Object.entries(scripts)) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);\n${body}\n`);
    fs.chmodSync(p, 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return bin;
}

export const PLAN = `# Plan: demo

## Design notes
- add() lives in src/add.js

## Tasks

### T1: add function
- **role:** build
- **files:** \`src/add.js\`
- **steps:** implement

### T2: docs
- **role:** docs
- **files:** \`README.md\`
`;
