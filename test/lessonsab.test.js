// V1: lessons that provably help: stale failures are resolved, repeats are offered as rules, and the eval can
// compare lessons on and off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins, tmpdir, PLAN } from './helpers.js';

isolateHome();
const L = await import('../src/lessons.js');
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { runEvals, formatEvals } = await import('../src/evals.js');

const GOOD = `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
  fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js','export const add=(a,b)=>a+b;\\n');
  fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- none\\n## Acceptance\\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1\\n## Notes\\n- none\\n');});`;

test('a provider that passes this kind of work here again stops being demoted; its guidance stays in prompts', async () => {
  fakeBins({ 'v1-good': GOOD });
  clearCooldowns();
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  for (let i = 0; i < 2; i++) L.addLesson(dir, { source: 'auto', provider: 'cx', role: 'build', kind: 'syntax', files: ['src/add.js'], text: '' });
  L.addLesson(dir, { source: 'auto', provider: 'other', role: 'build', kind: 'scope', files: ['src/add.js'], text: '' });
  assert.deepEqual(L.demoteByLessons(dir, ['cx', 'b'], { role: 'build', files: ['src/add.js'] }).chain, ['b', 'cx']);

  const cfg = loadConfig(dir);
  cfg.providers = { cx: { type: 'cli', preset: 'codex', enabled: true, bin: 'v1-good' } };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['cx'] });
  assert.equal(s.outcome ?? 'done', 'done');
  assert.equal(s.lessonsResolved, 1, 'its one (counted twice) syntax lesson');
  assert.match(formatSummary(s), /lessons: +cx passed this kind of work here, so 1 earlier failure\(s\) of its no longer move it back/);
  assert.deepEqual(L.demoteByLessons(dir, ['cx', 'b'], { role: 'build', files: ['src/add.js'] }).chain, ['cx', 'b'], 'no longer demoted');
  assert.ok(!L.readLessons(dir).find((l) => l.provider === 'other').resolvedAt, "another provider's failures are untouched");
  assert.match(L.lessonsPrompt(dir, { role: 'build', files: ['src/add.js'] }).text, /every file you write parses/, 'the guidance itself is still true here');
});

test('a lesson seen 3 times is offered as a rule (the user promotes it), in the run summary and the lessons list', async () => {
  fakeBins({ 'v1-good2': GOOD });
  clearCooldowns();
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  let l;
  for (let i = 0; i < 3; i++) l = L.addLesson(dir, { source: 'note', role: 'build', files: ['src/add.js'], text: 'Use the existing helpers in src/' });
  L.addLesson(dir, { source: 'note', role: 'build', files: ['src/add.js'], text: 'Only once' });
  assert.deepEqual(L.promotable(L.readLessons(dir)).map((x) => x.id), [l.id]);
  const cfg = loadConfig(dir);
  cfg.providers = { cx: { type: 'cli', preset: 'codex', enabled: true, bin: 'v1-good2' } };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['cx'] });
  assert.deepEqual(s.promotable.map((x) => x.id), [l.id]);
  assert.match(formatSummary(s), new RegExp(`promote\\?: +seen 3×: "Use the existing helpers in src/" → make it a rule: conductor lessons promote ${l.id}`));
  L.promoteLesson(dir, l.id);
  assert.deepEqual(L.promotable(L.readLessons(dir)), [], 'once promoted, not offered again');
});

test('eval: a lesson store carries lessons from one run to the next, task by task; --no-lessons is the control', async () => {
  // a worker that writes a file that doesn't parse: the guard rejects it and records a syntax lesson
  fakeBins({
    'v1-broken': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{fs.appendFileSync(process.env.V1_PROMPTS, p.includes('## Lessons from earlier work') ? 'L\\n' : '-\\n');
      const o=args[args.indexOf('-o')+1];fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/slugify.js','export const slugify = (;\\n');
      fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/slugify.js\\n## Notes\\n- none\\n');});`,
  });
  clearCooldowns();
  const store = path.join(tmpdir(), 'lessons.jsonl');
  process.env.V1_PROMPTS = path.join(tmpdir(), 'prompts.txt');
  const providers = { bad: { type: 'cli', preset: 'codex', enabled: true, bin: 'v1-broken' } };
  // the eval loads the config of its own temp repo: put the fake provider in the global config
  fs.mkdirSync(process.env.CONDUCTOR_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CONDUCTOR_HOME, 'config.json'), JSON.stringify({ version: 1, providers }));
  const run = (o) => runEvals({ ids: ['build-slugify'], chain: ['bad'], label: o.label, lessons: o.lessons });

  const r1 = await run({ label: 'learn', lessons: store });
  assert.equal(r1.lessons, 'store');
  assert.equal(r1.results[0].lessonsSeeded, 0);
  assert.ok(fs.readFileSync(store, 'utf8').includes('"evalTask":"build-slugify"'), 'what the run taught is kept, per task');
  const r2 = await run({ label: 'with', lessons: store });
  assert.ok(r2.results[0].lessonsSeeded >= 1);
  assert.ok(r2.results[0].lessonsInPrompt >= 1, 'the second run has them in its prompt');
  const r3 = await run({ label: 'without', lessons: 'off' });
  assert.equal(r3.lessons, 'off');
  assert.equal(r3.results[0].lessonsInPrompt, 0);
  assert.deepEqual(fs.readFileSync(process.env.V1_PROMPTS, 'utf8').trim().split('\n'), ['-', 'L', '-'], 'what the worker saw each time');
  assert.match(formatEvals(r2, r3), /lessons: +1 task\(s\) had lessons in their prompt: 0\/1 passed; the same tasks in without \(lessons off\): 0\/1/);
});

test('lesson quality (found by the first A/B): a module that would not load is a "load" lesson, and a hand-off names the failed check', () => {
  const f = { expr: "parseDuration('1h30m')", kind: 'returns', expected: '5400000' };
  const base = { mode: 'write', role: 'build', winner: 'w', attempts: [{ provider: 'w', ok: true }] };
  // the module didn't load, so every check "failed" with the same error: one load lesson, not a wrong-value lesson
  let ls = L.lessonsFromRun({ ...base, checks: { failed: [{ ...f, got: 'ReferenceError: Cannot determine intended module format', load: true }] } });
  assert.deepEqual(ls.map((l) => [l.kind, l.text]), [['load', 'ReferenceError: Cannot determine intended module format']]);
  ls = L.lessonsFromRun({ ...base, checks: { failed: [{ ...f, got: 'returned 90' }] } });
  assert.deepEqual(ls.map((l) => l.kind), ['acceptance-check']);
  assert.match(ls[0].text, /should return `5400000` \(a worker's version returned 90\)/);
  // handed on: the concrete check, never the empty "its acceptance checks failed"
  ls = L.lessonsFromRun({ ...base, escalated: [{ from: 'kilo', checksFailed: 1, check: { ...f, got: 'returned 90' } }] });
  assert.deepEqual(ls.map((l) => [l.provider, l.kind]), [['kilo', 'acceptance-check']]);
  assert.ok(!ls.some((l) => /its acceptance checks failed/.test(l.text)));
  ls = L.lessonsFromRun({ ...base, escalated: [{ from: 'kilo', checksFailed: 2 }] });
  assert.deepEqual(ls.map((l) => [l.kind, l.text]), [['verify', '']], 'an old record without the check: only the generic lesson');

  const { dir } = makeRepo();
  L.addLesson(dir, { source: 'auto', provider: 'kilo', role: 'build', kind: 'load', files: ['src/a.js'], text: 'SyntaxError: Cannot use import statement outside a module' });
  assert.match(L.lessonsPrompt(dir, { role: 'build', files: ['src/a.js'] }).text, /loads in this project's module system[^\n]*\(SyntaxError: Cannot use import statement outside a module\)/);
});
