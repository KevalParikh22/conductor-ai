// V10: the npm package ships what users need and nothing that is for development only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { packageFiles, packageProblems } from '../scripts/check-package.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const allowed = pkg.files.filter((f) => !f.startsWith('!'));

test('npm pack ships only allowed files: no tests, benchmark, eval solutions, plans, state or secrets', () => {
  const files = packageFiles();
  assert.deepEqual(packageProblems(files, allowed), []);
  assert.ok(files.includes('bin/conductor.js') && files.includes('src/core.js'), 'the program itself is in');
  assert.ok(files.some((f) => /^evals\/[^/]+\/hidden\//.test(f)), 'eval tasks are in (conductor eval run needs them)');
  assert.ok(files.some((f) => /^evals\/[^/]+\/mutants\//.test(f)), 'mutants are in (they score a task)');
  assert.ok(!files.some((f) => /\/solution\//.test(f)), 'reference solutions are not');
});

test('the check catches what must not ship', () => {
  const p = packageProblems(['src/a.js', 'test/x.test.js', 'bench/run.mjs', 'evals/t/solution/a.js', 'docs/plan/p.md', 'ROADMAP.md', '.env', 'other/x.js'], allowed);
  assert.equal(p.length, 7);
  assert.match(p.join('\n'), /test\/x\.test\.js: tests[\s\S]*bench[\s\S]*solution[\s\S]*plans[\s\S]*planning notes[\s\S]*secrets[\s\S]*other\/x\.js: not under an entry/);
});
