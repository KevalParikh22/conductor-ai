// Q7: lessons from earlier work, in prompts and in provider order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const L = await import('../src/lessons.js');
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

test('lessons: repeats are counted, matched by role and folder, and turned into a short prompt section', () => {
  const { dir } = makeRepo();
  L.addLesson(dir, { source: 'auto', provider: 'p1', role: 'build', kind: 'missing-name', files: ['src/cart/a.js'] });
  const again = L.addLesson(dir, { source: 'auto', provider: 'p1', role: 'build', kind: 'missing-name', files: ['src/cart/b.js'] });
  assert.equal(again.count, 2, 'same folder, same kind: one lesson, counted twice');
  L.addLesson(dir, { source: 'note', role: 'build', files: ['src/cart/a.js'], text: 'Use cents, never floats, for money' });
  L.addLesson(dir, { source: 'auto', provider: 'p2', role: 'build', kind: 'scope', files: ['src/other/x.js'] });
  assert.equal(L.readLessons(dir).length, 3);
  const p = L.lessonsPrompt(dir, { role: 'build', files: ['src/cart/c.js'] });
  assert.match(p.text, /^\n## Lessons from earlier work in this project\n- Use cents, never floats, for money\n- Define \(and export\) functions and classes under exactly the names the task gives/);
  assert.ok(!p.text.includes('outside the task'), 'another folder\'s lesson is left out');
  assert.equal(L.lessonsPrompt(dir, { role: 'docs', files: ['src/cart/c.js'] }).text, '', 'another role');
});

test('a provider that failed this kind of work twice moves to the back, keeping order; never all of them', () => {
  const { dir } = makeRepo();
  L.addLesson(dir, { source: 'auto', provider: 'bad', role: 'build', kind: 'verify', files: ['src/a.js'] });
  assert.deepEqual(L.demoteByLessons(dir, ['bad', 'x', 'y'], { role: 'build', files: ['src/b.js'] }).chain, ['bad', 'x', 'y'], 'once is not enough');
  L.addLesson(dir, { source: 'auto', provider: 'bad', role: 'build', kind: 'syntax', files: ['src/a.js'] });
  const d = L.demoteByLessons(dir, ['bad', 'x', 'y'], { role: 'build', files: ['src/b.js'] });
  assert.deepEqual([d.chain, d.demoted], [['x', 'y', 'bad'], ['bad (2 failures)']]);
  assert.deepEqual(L.demoteByLessons(dir, ['bad'], { role: 'build', files: ['src/b.js'] }).chain, ['bad'], 'never every provider');
});

test('what a run teaches: each diagnosed failure, attributed to the provider that made it', () => {
  const s = { role: 'build', mode: 'write', winner: 'w', attempts: [
    { provider: 'a', reason: 'syntax error in x.js', guard: { syntax: [{ file: 'x.js' }], missing: [] } },
    { provider: 'b', reason: 'missing from the code: toQuery', guard: { syntax: [], missing: ['toQuery'] } },
    { provider: 'c', reason: 'no file blocks in reply' },
    { provider: 'w', reason: 'ok' }],
    checks: { failed: [{ expr: 'add(2, 3)', kind: 'returns', expected: '5', got: 'returned -1' }] },
    verify: { status: 'FAIL', suspectTests: ['t.js'] }, scope: { outside: ['z.js'] }, repro: { ok: false } };
  assert.deepEqual(L.lessonsFromRun(s).map((l) => [l.provider, l.kind]), [['a', 'syntax'], ['b', 'missing-name'], ['c', 'no-files'], ['w', 'acceptance-check'], ['w', 'wrong-test'], ['w', 'scope'], ['w', 'regression-test']]);
});

const PLAN = `# Plan
## Open questions
- [x] none
## Tasks
### T1: add
- **role:** build
- **files:** \`src/add.js\`
- **acceptance:**
  - [ ] \`add(2, 3)\` returns 5
`;
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. add — evidence: src/add.js:1\\n';
const worker = (code) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];if(process.env.LS_PROMPT)fs.writeFileSync(process.env.LS_PROMPT,p);fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js',${JSON.stringify(code)});fs.writeFileSync(o,'${REPORT}');});`;
fakeBins({ 'ls-misnamer': worker('export const sum = (a, b) => a + b;\n'), 'ls-good': worker('export const add = (a, b) => a + b;\n') });

test('end to end: failures become lessons, the next prompt carries them, and the repeat offender moves back', async () => {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  // like init --share: conductor's folder is in git, so its own files must never make the tree look changed
  fs.mkdirSync(path.join(dir, '.conductor'), { recursive: true }); fs.writeFileSync(path.join(dir, '.conductor', '.gitignore'), 'runs/\n');
  git('add', '-A'); git('commit', '-qm', 'share conductor folder');
  const cfg = loadConfig(dir);
  cfg.providers.misnamer = { type: 'cli', preset: 'codex', enabled: true, bin: 'ls-misnamer' };
  cfg.providers.good = { type: 'cli', preset: 'codex', enabled: true, bin: 'ls-good' };
  cfg.roles.build = ['misnamer', 'good'];
  cfg.settings = { ...cfg.settings, smartSelect: false, autoReview: false };
  process.env.LS_PROMPT = path.join(dir, '.git', 'LS_PROMPT.txt');
  const go = (o = {}) => dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', ...o });
  let s = await go();
  assert.deepEqual(s.attempts.map((a) => a.provider), ['misnamer', 'good']);
  assert.ok(L.readLessons(dir).some((l) => l.provider === 'misnamer' && l.kind === 'missing-name'));
  git('checkout', '-q', '--', '.'); git('clean', '-qfd', 'src'); git('stash', 'clear');
  s = await go({ note: 'Export add exactly as named' });
  assert.match(fs.readFileSync(process.env.LS_PROMPT, 'utf8'), /## Lessons from earlier work in this project\n[\s\S]*exactly the names the task gives/);
  assert.equal(s.lessons.length >= 1, true);
  assert.ok(L.readLessons(dir).some((l) => l.source === 'note' && l.text === 'Export add exactly as named'));
  git('checkout', '-q', '--', '.'); git('clean', '-qfd', 'src'); git('stash', 'clear');
  s = await go();
  assert.deepEqual(s.attempts.map((a) => a.provider), ['good'], 'misnamer failed twice: good goes first, and succeeds');
  assert.match(formatSummary(s), /order: +moved to the back: misnamer \(2 failures\)/);
  s = await go({ chain: ['misnamer', 'good'], allowDirty: true });
  assert.equal(s.attempts[0].provider, 'misnamer', 'an explicit chain is respected');
});

test('promote turns a lesson into a rule in AGENTS.md; the CLI lists, adds and removes', () => {
  const { dir } = makeRepo({ files: { 'AGENTS.md': '# AGENTS\n' } });
  const l = L.addLesson(dir, { source: 'manual', text: 'Prices are integer cents', files: ['src/money.js'] });
  const r = L.promoteLesson(dir, l.id);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /## Lessons \(promoted by conductor\)\n- Prices are integer cents\. \(in src\)/);
  assert.equal(r.lesson.promoted, true);
  assert.equal(L.lessonsPrompt(dir, { role: 'build', files: ['src/x.js'] }).text, '', 'a rule is in AGENTS.md now, not repeated in prompts');
  const bin = path.resolve('bin/conductor.js');
  const cli = (...a) => execFileSync('node', [bin, 'lessons', ...a], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.match(cli('add', 'Never', 'log', 'tokens', '--files', 'src/auth.js'), /^added (\w+): Never log tokens/);
  const id = cli('list').match(/^(\w{6}) +manual .*Never log tokens/m)[1];
  assert.match(cli('rm', id), new RegExp(`removed ${id}`));
});
