// Export check: names the task calls must be exported by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { exportNames, unexported } = await import('../src/gates.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { readLessons } = await import('../src/lessons.js');

test('which names need a named export: what the checks call, and what the plan says to export; not methods', () => {
  assert.deepEqual(exportNames('- New file `src/q.js` exporting `toQuery(params)`.\n- `keys()` is `[]`', ["slugify('x')", 'new LRUCache(0)']), ['slugify', 'LRUCache', 'toQuery']);
  assert.deepEqual(exportNames('`has()` does not change the order', []), [], 'a method is not required as an export');
});

test('named exports in every common form count; export default and plain functions do not', () => {
  const { dir } = makeRepo({ files: {
    'src/a.js': 'export function alpha() {}\nexport const beta = 1;\nexport class Gamma {}\n',
    'src/b.js': 'function delta() {}\nexport { delta, x as epsilon };\n',
    'src/c.cjs': 'exports.zeta = 1;\nmodule.exports.eta = 2;\n',
    'src/d.cjs': 'module.exports = { theta, iota };\n',
    'src/e.js': 'export default function kappa() {}\nfunction lambda() {}\n',
    'src/f.ts': 'export interface Mu {}\nexport async function nuu() {}\n',
  } });
  const sec = (names) => names.map((n) => `- exporting \`${n}(\``).join('\n');
  const all = ['alpha', 'beta', 'Gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'Mu', 'nuu'];
  assert.deepEqual(unexported(dir, sec(all), ['src/a.js']), ['kappa', 'lambda']);
  assert.deepEqual(unexported(dir, sec(['kappa']), ['lib/a.py']), [], 'not a JS/TS task: the export check does not apply');
});

const PLAN = `# Plan
## Open questions
- [x] none
## Design notes
- New file \`src/slugify.js\` exporting \`slugify(text)\`.
## Tasks
### T1: slugify
- **role:** build
- **files:** \`src/slugify.js\`
- **acceptance:**
  - [ ] \`slugify('A B')\` returns \`'a-b'\`
`;
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/slugify.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. ok — evidence: src/slugify.js:1\\n';
const worker = (code) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/slugify.js',${JSON.stringify(code)});fs.writeFileSync(o,'${REPORT}');});`;
fakeBins({
  'ex-default': worker("export default function slugify(t) { return t.toLowerCase().replace(/\\s+/g, '-'); }\n"),
  'ex-named': worker("export function slugify(t) { return t.toLowerCase().replace(/\\s+/g, '-'); }\n"),
});

test('an attempt that only default-exports the function is rejected at once; the next provider gets it right', async () => {
  clearCooldowns();
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
  const cfg = loadConfig(dir);
  cfg.providers.dflt = { type: 'cli', preset: 'codex', enabled: true, bin: 'ex-default' };
  cfg.providers.named = { type: 'cli', preset: 'codex', enabled: true, bin: 'ex-named' };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['dflt', 'named'], noReview: true });
  assert.equal(s.attempts[0].reason, 'not exported by name: slugify (the task needs `export` under exactly that name)');
  assert.ok(s.attempts[0].stashed);
  assert.deepEqual([s.winner, s.outcome], ['named', 'done']);
  assert.ok(s.warnings.some((w) => /slugify is not exported under that name \(an `export default`/.test(w)));
  assert.ok(readLessons(dir).some((l) => l.provider === 'dflt' && l.kind === 'missing-name' && l.text === 'slugify'), 'and it becomes a lesson');
  assert.match(fs.readFileSync(`${dir}/src/slugify.js`, 'utf8'), /^export function slugify/);
});

test('a task is held only to its own exports, not to every module the Design notes describe (the pilot bug)', async () => {
  const { notesForFiles, extractSection, extractTask, taskFiles } = await import('../src/core.js');
  const { parseChecks } = await import('../src/acceptcheck.js');
  const { taskAcceptance } = await import('../src/plancheck.js');
  const plan = fs.readFileSync(new URL('../bench/pilot/plan.md', import.meta.url), 'utf8');
  const notes = extractSection(plan, 'Design notes');
  const need = (t) => { const sec = extractTask(plan, t); return exportNames(`${notesForFiles(notes, taskFiles(sec))}\n${sec}`, parseChecks(taskAcceptance(sec)).map((c) => c.expr)); };
  assert.deepEqual(need('T4'), ['paginate', 'pageCount'], 'not slugify, parseDuration, LRUCache, slugPath');
  assert.deepEqual(need('T6'), ['formatDuration', 'parseDuration'], 'the file it shares with T2 keeps T2\'s export');
});
