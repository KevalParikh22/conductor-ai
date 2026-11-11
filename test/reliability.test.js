// Sandbox access to linked dependency folders, honest batch counts, report parsing, review findings, read-only overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, tmpdir, fakeBins } from './helpers.js';

isolateHome();
const { withLinkedFolders } = await import('../src/providers.js');
const { claimedFiles, checkEvidence, trimReport, outcome, expandBraces } = await import('../src/core.js');
const { formatBatch } = await import('../src/batch.js');
const { readOnlyEnforced, readOverrideMissing } = await import('../src/config.js');
const { CLI_PRESETS } = await import('../src/presets.js');

test('linked node_modules outside the worker folder becomes readable in the agy sandbox', () => {
  const work = fs.realpathSync(tmpdir('wt-'));
  const deps = fs.realpathSync(tmpdir('deps-'));
  fs.symlinkSync(deps, path.join(work, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(work, 'vendor')); // a real folder needs nothing
  const s = withLinkedFolders({ toolPermission: 'x', permissions: { deny: ['write_file(x)'] } }, work);
  assert.deepEqual(s.permissions.allow, [`read_file(${deps})`]);
  assert.deepEqual(s.permissions.deny, ['write_file(x)'], 'deny rules untouched');
  assert.ok(!JSON.stringify(s).includes('write_file(' + deps), 'read only');
  const none = { permissions: { deny: [] } };
  assert.equal(withLinkedFolders(none, fs.realpathSync(tmpdir('plain-'))), none);
});

test('outcome: verify failures and PARTIAL results are not done; batch counts them so', () => {
  const base = { winner: 'codex-cli', changed: ['a.js'], warnings: [], worktree: { commit: 'abc1234', branch: 'conductor/T1' } };
  assert.equal(outcome({ ...base, status: '## RESULT: DONE', verify: { status: 'PASS' } }), 'done');
  assert.equal(outcome({ ...base, status: '## RESULT: DONE', verify: { status: 'FAIL' } }), 'verify-failed');
  assert.equal(outcome({ ...base, status: '## RESULT: PARTIAL', verify: { status: 'PASS' } }), 'partial');
  assert.equal(outcome({ ...base, status: '## VERDICT: CHANGES_REQUESTED' }), 'done', 'a review that asks for changes still finished');
  assert.equal(outcome({ winner: null }), 'failed');
  const results = [
    { task: 'T1', summary: { ...base, status: '## RESULT: DONE', verify: { status: 'PASS' } } },
    { task: 'T2', summary: { ...base, status: '## RESULT: DONE', verify: { status: 'FAIL', scope: 'task' } } },
    { task: 'T3', summary: { ...base, status: '## RESULT: PARTIAL', verify: { status: 'PASS' } } },
  ].map((r) => ({ ...r, outcome: outcome(r.summary) }));
  const out = formatBatch({ plan: 'p.md', warnings: [], results, ok: 1, partial: 1, failed: 1 });
  assert.match(out, /T2 +✗ codex-cli · verify FAIL/);
  assert.match(out, /T3 +⚠ codex-cli .*RESULT: PARTIAL/);
  assert.match(out, /result: +1 done, 1 partial, 1 failed/);
});

test('report paths: links, braces, absolute paths and prose', () => {
  const wt = '/home/u/.conductor/worktrees/app/T3';
  const r = [
    '## Files changed',
    `- [src/food/types.ts](file://${wt}/src/food/types.ts) — new type`,
    '- `src/lib/{fasting,history}.test.ts`: tests',
    '- No changes to the API',
    '- Tabs were reorganised',
    `- ${wt}/src/app.tsx`,
    '- src/a.js:12 — fix',
    '- `c.ts`, `d.ts`: both',
    '- /etc/passwd',
    '## Notes', '- x.js',
  ].join('\n');
  assert.deepEqual(claimedFiles(r, { roots: [wt] }), ['src/food/types.ts', 'src/lib/fasting.test.ts', 'src/lib/history.test.ts', 'src/app.tsx', 'src/a.js', 'c.ts', 'd.ts']);
  assert.deepEqual(expandBraces('a/{b,c{1,2}}.js'), ['a/b.js', 'a/c1.js', 'a/c2.js']);
  const ev = checkEvidence(r, ['src/food/types.ts', 'src/lib/fasting.test.ts', 'src/lib/history.test.ts', 'src/app.tsx', 'src/a.js', 'c.ts', 'd.ts'], '## RESULT: DONE', new Set(), [wt]);
  assert.deepEqual(ev.warnings, [], 'no false mismatch warnings');
  assert.deepEqual(claimedFiles('## Files changed\n- Makefile\n- Root\n', { known: ['Root'] }), ['Makefile', 'Root'], 'a bare name counts when git changed it');
});

test('review findings written before the verdict stay in report.md', () => {
  const r = trimReport('reading files…\n## Findings\n1. **High** null check missing in a.js:10\n2. no test\n\n## VERDICT: CHANGES_REQUESTED\n');
  assert.match(r, /^## VERDICT: CHANGES_REQUESTED/);
  assert.match(r, /null check missing/);
  const bare = trimReport('long transcript\nthe bug is in parse()\n## VERDICT: CHANGES_REQUESTED');
  assert.match(bare, /Output before the verdict[\s\S]*the bug is in parse\(\)/);
  assert.equal(trimReport('x\n## RESULT: DONE\n## Notes\n- ok\n'), '## RESULT: DONE\n## Notes\n- ok\n', 'unchanged when nothing is missing');
});

test('overriding only the time limit keeps read-only enforced; dropping --sandbox does not', () => {
  const read = CLI_PRESETS.antigravity.read;
  const onlyTimeout = { type: 'cli', preset: 'antigravity', read: read.map((t) => (t === '{timeout}' ? '20m' : t)) };
  assert.deepEqual(readOverrideMissing(onlyTimeout), []);
  assert.equal(readOnlyEnforced(onlyTimeout), true);
  const noSandbox = { type: 'cli', preset: 'antigravity', read: read.filter((t) => t !== '--sandbox') };
  assert.deepEqual(readOverrideMissing(noSandbox), ['--sandbox']);
  assert.equal(readOnlyEnforced(noSandbox), false);
  const custom = { type: 'cli', bin: 'mine', read: ['x'] };
  assert.equal(readOnlyEnforced(custom), false);
});

test('batch: unverified results are counted, marked "?" and fail the batch unless allowed', () => {
  const base = { winner: 'codex-cli', mode: 'write', changed: ['a.js'], warnings: [], worktree: { commit: 'abc1234', branch: 'conductor/T1' } };
  const results = [
    { task: 'T1', summary: { ...base, status: '## RESULT: DONE', verify: { status: 'PASS' } } },
    { task: 'T2', summary: { ...base, status: '## RESULT: DONE', verify: { status: 'SKIPPED', cmd: '' } } },
  ].map((r) => ({ ...r, outcome: outcome(r.summary) }));
  assert.deepEqual(results.map((r) => r.outcome), ['done', 'unverified']);
  const out = formatBatch({ plan: 'p.md', warnings: [], results, ok: 1, partial: 0, unverified: 1, failed: 0 });
  assert.match(out, /T2 +\? codex-cli · verify SKIPPED/);
  assert.match(out, /result: +1 done, 1 unverified, 0 failed/);
  assert.match(out, /For each \?: no verify ran/);
});
