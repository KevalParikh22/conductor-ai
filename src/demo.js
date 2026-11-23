// conductor-ai demo: see conductor-ai work end to end in about 2 minutes, without touching your projects. It makes a
// throwaway project (a tiny Node library and a plan of two independent tasks), hands both tasks to your workers in
// parallel (each in its own worktree, every check applied), merges what passed, runs the project's tests, and
// removes the project unless you keep it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, providerReadiness } from './config.js';
import { isFree } from './selector.js';
import { initProject } from './init.js';
import { runBatch } from './batch.js';
import { run } from './util.js';
import { worktreesDir } from './worktree.js';

export const DEMO_PLAN = `# Plan: text helpers (conductor-ai demo)

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
  git(dir, 'config', 'user.email', 'demo@conductor-ai.local'); git(dir, 'config', 'user.name', 'conductor-ai demo');
  initProject(dir, { controller: 'claude-code', mcp: false });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'demo start');
  git(dir, 'switch', '-qc', 'feat/demo');
  return dir;
}

const ready = (cfg, n) => cfg.providers[n] && providerReadiness(n, cfg.providers[n]).ready;
const demoAgents = (cfg) => (cfg.roles.build || []);

/**
 * A stranger's first run (npx conductor-ai demo) has no coding agent installed, and the build chain is agents only.
 * Then the demo hands its two tasks to the free API models that are ready (kilo-free needs no key), so it still shows
 * conductor-ai working. With free: true (demo --free) it uses only those, even when an agent is installed, so the
 * demo costs nothing. → the free routes to use, or null when an agent in the build chain is ready and free is off.
 */
export function demoFallback(cfg, { free = false } = {}) {
  if (!free && demoAgents(cfg).some((n) => ready(cfg, n))) return null;
  const order = [...new Set([...Object.values(cfg.roles).flat(), ...Object.keys(cfg.providers)])];
  return order.filter((n) => isFree(cfg.providers[n]) && cfg.providers[n].type !== 'manual' && ready(cfg, n));
}

/**
 * The line that says, before anything runs, whose quota the demo uses. A stranger trying "npx conductor-ai demo"
 * shouldn't find out afterwards that it ran on their Codex plan or a paid key. → text, or '' when everything is free.
 */
export function demoUsageNotice(cfg, provider) {
  const names = provider ? [provider] : demoAgents(cfg).filter((n) => ready(cfg, n));
  const own = names.filter((n) => cfg.providers[n] && !isFree(cfg.providers[n]));
  if (!own.length) return '';
  return `   Workers: ${names.join(', ')}. ${own.join(' and ')} ${own.length > 1 ? 'use' : 'uses'} a little of your own plan, quota or key for these 2 small tasks (Claude is not called).\n` +
    '   To use free models only: conductor-ai demo --free';
}

export const DEMO_RETRIES = 2;

/** The first batch with the retried tasks' newest results in place, and its counts redone. */
export function combineBatches(first, retry, round) {
  const newer = new Map(retry.results.map((r) => [r.task, { ...r, retries: round }]));
  const results = first.results.map((r) => newer.get(r.task) || r);
  const n = (o) => results.filter((r) => r.outcome === o).length;
  const ok = n('done'), partial = n('partial'), unverified = n('unverified'), outOfScope = n('out-of-scope'), blocked = results.filter((r) => r.blocked).length;
  return { ...first, results, ok, partial, unverified, outOfScope, blocked, failed: results.length - ok - partial - unverified - outOfScope - blocked, exitCode: ok === results.length ? 0 : 3 };
}

/**
 * Run the demo. → { dir, batch, merged: [task ids], verify: { status, output }, kept }
 * say(text) prints a step; onEvent gets batch events (the CLI shows the live table).
 */
export async function runDemo({ keep = false, provider, free = false, say = () => {}, onEvent, parent } = {}) {
  const dir = makeDemoProject(parent);
  say(`1. A throwaway project: ${dir}\n   a tiny Node library and a plan with 2 independent tasks (docs/plan/demo.md)`);
  try {
    say(`2. Both tasks go to your workers in parallel, each in its own worktree; every check runs on each`);
    const cfg = loadConfig(dir);
    const fallback = provider ? null : demoFallback(cfg, { free });
    if (fallback?.length) {
      say(free ? `   Free models only (--free): ${fallback.join(', ')}. This uses none of your own quota.`
        : `   No coding agent is ready (${demoAgents(cfg).join(', ')}), so the demo uses free API models: ${fallback.join(', ')}. This uses none of your own quota.`);
      cfg.roles = { ...cfg.roles, build: fallback }; // this run only: nothing is written to your config
    } else if (fallback) {
      say(free ? '   --free: no free model is ready. Run: conductor-ai setup (or conductor-ai doctor to see why)'
        : '   No coding agent and no free API model is ready. Run: conductor-ai setup (or conductor-ai doctor to see why)');
      if (free) cfg.roles = { ...cfg.roles, build: [] }; // never fall through to a paid worker after --free
    } else {
      const notice = demoUsageNotice(cfg, provider);
      if (notice) say(notice);
    }
    const opts = { planPath: 'docs/plan/demo.md', provider, noReview: true, replace: true, onEvent };
    let batch = await runBatch(cfg, { ...opts, tasks: ['T1', 'T2'] });
    // free models vary from one call to the next (a 503, a weaker fallback model, half-done work): a task that didn't
    // pass every check gets a fresh attempt, so one bad reply doesn't fail a stranger's first look. Failed work is
    // never merged either way.
    for (let round = 1; round <= DEMO_RETRIES; round++) {
      const again = batch.results.filter((r) => r.outcome !== 'done').map((r) => r.task);
      if (!again.length) break;
      say(`   ${again.join(' and ')} didn't pass every check (free models vary): trying again, ${round} of ${DEMO_RETRIES}`);
      batch = combineBatches(batch, await runBatch(cfg, { ...opts, tasks: again }), round);
    }
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
      // the task worktrees live in conductor-ai's home, not in the project: remove them first, then the project
      try { for (const l of git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((x) => x.startsWith('worktree ')).map((x) => x.slice(9)).filter((p) => p !== fs.realpathSync(dir))) git(dir, 'worktree', 'remove', '--force', l); } catch { /* best effort */ }
      try { fs.rmSync(worktreesDir(dir), { recursive: true, force: true }); } catch { /* none */ } // conductor-ai's notes on the demo's worktrees
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
