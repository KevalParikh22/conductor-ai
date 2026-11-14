// conductor demo: see conductor work end to end in about 2 minutes, without touching your projects. It makes a
// throwaway project (a tiny Node library and a plan of two independent tasks), hands both tasks to your workers in
// parallel (each in its own worktree, every check applied), merges what passed, runs the project's tests, and
// removes the project unless you keep it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { initProject } from './init.js';
import { runBatch } from './batch.js';
import { run } from './util.js';
import { worktreesDir } from './worktree.js';

export const DEMO_PLAN = `# Plan: text helpers (conductor demo)

**Goal:** two small, independent helpers with tests.

## Open questions
- [x] none

## Design notes
- ES modules, no dependencies. Code in \`src/\`, tests in \`test/\` (node:test), run by \`npm test\`.
- \`src/titleCase.js\` exports \`titleCase(text)\`: the first letter of each word upper case, the rest lower case; words are separated by spaces, which are kept as they are. Not a string → \`TypeError\`.
- \`src/truncate.js\` exports \`truncate(text, max)\`: text longer than \`max\` characters is cut to \`max - 1\` characters plus \`…\`; shorter text is returned unchanged. \`max\` must be an integer ≥ 1 (else \`RangeError\`).

## Tasks

### T1: titleCase
- **role:** build
- **files:** \`src/titleCase.js\`, \`test/titleCase.test.js\`
- **acceptance:**
  - [ ] \`titleCase('hello wORLD')\` returns \`'Hello World'\`
  - [ ] \`titleCase('')\` returns \`''\`
  - [ ] \`titleCase(5)\` throws TypeError
- **verify:** \`npm test\`

### T2: truncate
- **role:** build
- **files:** \`src/truncate.js\`, \`test/truncate.test.js\`
- **acceptance:**
  - [ ] \`truncate('conductor', 5)\` returns \`'cond…'\`
  - [ ] \`truncate('abc', 5)\` returns \`'abc'\`
  - [ ] \`truncate('abc', 0)\` throws RangeError
- **verify:** \`npm test\`
`;

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Make the throwaway project. → its folder */
export function makeDemoProject(parent = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(parent, 'conductor-demo-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'conductor-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), "// the demo's helpers land next to this file\nexport const name = 'conductor-demo';\n");
  fs.writeFileSync(path.join(dir, 'test', 'index.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { name } from '../src/index.js';\n\ntest('the project loads', () => assert.equal(name, 'conductor-demo'));\n");
  fs.writeFileSync(path.join(dir, 'docs', 'plan', 'demo.md'), DEMO_PLAN);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'demo@conductor.local'); git(dir, 'config', 'user.name', 'conductor demo');
  initProject(dir, { controller: 'claude-code', mcp: false });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'demo start');
  git(dir, 'switch', '-qc', 'feat/demo');
  return dir;
}

/**
 * Run the demo. → { dir, batch, merged: [task ids], verify: { status, output }, kept }
 * say(text) prints a step; onEvent gets batch events (the CLI shows the live table).
 */
export async function runDemo({ keep = false, provider, say = () => {}, onEvent, parent } = {}) {
  const dir = makeDemoProject(parent);
  say(`1. A throwaway project: ${dir}\n   a tiny Node library and a plan with 2 independent tasks (docs/plan/demo.md)`);
  try {
    say(`2. Both tasks go to your workers in parallel, each in its own worktree; every check runs on each`);
    const cfg = loadConfig(dir);
    const batch = await runBatch(cfg, { planPath: 'docs/plan/demo.md', tasks: ['T1', 'T2'], provider, noReview: true, replace: true, onEvent });
    const merged = [];
    for (const r of batch.results) {
      const branch = r.summary?.worktree?.commit ? r.summary.worktree.branch : null;
      if (r.outcome !== 'done' || !branch) continue;
      try { git(dir, 'merge', '--no-ff', '-q', '-m', `merge ${r.task}`, branch); merged.push(r.task); } catch { try { git(dir, 'merge', '--abort'); } catch { /* nothing to abort */ } }
    }
    const t = await run(process.execPath, ['--test'], { cwd: dir, timeoutMs: 120_000, env: (() => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; })() });
    const verify = { status: t.code === 0 ? 'PASS' : 'FAIL', output: (t.stdout + t.stderr).split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join(' · ') };
    return { dir, batch, merged, verify, kept: keep };
  } finally {
    if (!keep) {
      // the task worktrees live in conductor's home, not in the project: remove them first, then the project
      try { for (const l of git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((x) => x.startsWith('worktree ')).map((x) => x.slice(9)).filter((p) => p !== fs.realpathSync(dir))) git(dir, 'worktree', 'remove', '--force', l); } catch { /* best effort */ }
      try { fs.rmSync(worktreesDir(dir), { recursive: true, force: true }); } catch { /* none */ } // conductor's notes on the demo's worktrees
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
