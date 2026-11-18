// "Save to": Global applies to every project; This project overrides it. A key set in both: the project wins.
// A key set only in global applies here too. Routing rules add up: this project's first, then global ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, tmpdir } from './helpers.js';

const home = isolateHome();
const { loadConfig, scopeSave, writeScope, readScope } = await import('../src/config.js');

const project = () => { const d = tmpdir('conductor-scope-'); fs.mkdirSync(path.join(d, '.git')); return d; };
const save = (scope, root, edit) => { const eff = loadConfig(root); edit(eff); const { data, shadowed } = scopeSave(scope, root, eff); writeScope(scope, root, data); return shadowed; };
const reset = () => { for (const f of ['config.json']) fs.rmSync(path.join(home, f), { force: true }); };

test('global and project: project wins a conflict, global fills the rest, and a global save never copies project overrides', () => {
  reset();
  const a = project(), b = project();
  save('global', a, (c) => { c.settings.timeoutSec = 600; c.settings.cooldownMinutes = 10; });
  save('project', a, (c) => { c.settings.timeoutSec = 900; });
  assert.equal(loadConfig(a).settings.timeoutSec, 900, 'project wins in A');
  assert.equal(loadConfig(a).settings.cooldownMinutes, 10, 'global applies in A where the project says nothing');
  assert.equal(loadConfig(b).settings.timeoutSec, 600, 'B gets the global value');
  // a global save from project A: only the changed key goes to global, not A's timeoutSec 900
  const shadowed = save('global', a, (c) => { c.settings.maxDiffKB = 300; c.settings.timeoutSec = 1200; });
  assert.equal(readScope('global', a).settings.maxDiffKB, 300);
  assert.equal(loadConfig(b).settings.timeoutSec, 1200, 'B gets the new global value');
  assert.equal(loadConfig(a).settings.timeoutSec, 900, 'A still overrides it');
  assert.deepEqual(shadowed, ['settings.timeoutSec'], 'the save says the project overrides it here');
  // a project save keeps global values out of the project file
  save('project', a, (c) => { c.settings.verify = 'npm test'; });
  assert.deepEqual(Object.keys(readScope('project', a).settings).sort(), ['timeoutSec', 'verify']);
});

test('routing rules add up: the project\'s first (they win a match), then global ones; each file keeps its own', () => {
  reset();
  const a = project(), b = project();
  const g = { match: { files: ['docs/**'] }, provider: 'kilo-free' }, p = { match: { files: ['src/api/**'] }, provider: 'codex-cli' };
  save('global', a, (c) => { c.routes = [g]; });
  save('project', a, (c) => { c.routes = [p, ...c.routes]; });
  assert.deepEqual(loadConfig(a).routes, [p, g]);
  assert.deepEqual(loadConfig(b).routes, [g]);
  assert.deepEqual(readScope('project', a).routes, [p], 'the global rule is not copied into the project file');
  assert.deepEqual(readScope('global', a).routes, [g]);
});
