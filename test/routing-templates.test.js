// Routing rule library: templates, filling in providers, ordering, the CLI and the docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { ROUTE_TEMPLATES, resolveTemplate, addTemplates, starterIds, wantProviders, matchRoute, routeErrors } = await import('../src/routing.js');
const { DEFAULT_CONFIG } = await import('../src/presets.js');
const P = DEFAULT_CONFIG.providers;
const root = new URL('..', import.meta.url).pathname;

test('every template resolves to enabled providers of the right kind and passes validation', () => {
  for (const t of ROUTE_TEMPLATES) {
    const r = resolveTemplate(t, P);
    assert.equal(r.missing, null, t.id);
    for (const n of [].concat(r.route.provider)) {
      assert.ok(P[n].enabled, `${t.id}: ${n} enabled`);
      assert.equal(P[n].type === 'cli', !['cheap', 'local'].includes(t.want), `${t.id}: ${n} is the right kind`);
    }
  }
  assert.deepEqual(routeErrors(addTemplates([], ROUTE_TEMPLATES.map((t) => t.id), P).routes, P), []);
});

test('providers: local models first for cheap work; a missing kind says what to enable', () => {
  const withOllama = { ...P, ollama: { ...P.ollama, enabled: true } };
  assert.equal(wantProviders('local', withOllama)[0], 'ollama');
  const agentsOnly = Object.fromEntries(Object.entries(P).map(([n, p]) => [n, { ...p, enabled: p.type === 'cli' && p.enabled }]));
  assert.match(resolveTemplate(ROUTE_TEMPLATES.find((t) => t.id === 'docs-files'), agentsOnly).missing, /free or local model/);
});

test('adding keeps library order, skips duplicates and unknown ids, leaves your own rules in place', () => {
  const mine = { files: 'src/x/**', provider: 'opencode' };
  const a = addTemplates([mine], ['docs-role', 'security', 'database'], P);
  assert.deepEqual(a.routes.map((r) => r.from || 'mine'), ['mine', 'security', 'database', 'docs-role']);
  const b = addTemplates(a.routes, ['security', 'nope'], P);
  assert.deepEqual(b.added, []);
  assert.deepEqual(b.skipped.map((s) => s.why), ['already added', 'no such template']);
  assert.deepEqual(starterIds(), ['security', 'database', 'infra', 'small-edits', 'docs-files', 'docs-role']);
});

test('starter rules match the tasks they are meant for', () => {
  const { routes } = addTemplates([], [...starterIds(), 'tests', 'frontend'], P);
  const hit = (t) => matchRoute(routes, { role: 'build', body: '', files: [], ...t })?.route.from;
  assert.equal(hit({ body: 'Fix the login redirect', files: ['src/Login.tsx'] }), 'security');
  assert.equal(hit({ files: ['db/migrations/001_users.sql'] }), 'database');
  assert.equal(hit({ files: ['.github/workflows/ci.yml'] }), 'infra');
  assert.equal(hit({ body: 'fix a typo in the footer', files: ['src/Footer.tsx'] }), 'small-edits');
  assert.equal(hit({ files: ['src/Button.test.tsx'] }), 'tests');
  assert.equal(hit({ files: ['src/Button.tsx'] }), 'frontend');
  assert.equal(hit({ role: 'docs', body: 'explain setup' }), 'docs-role');
  assert.equal(hit({ body: 'add a cache layer', files: ['src/cache.go'] }), undefined);
});

test('CLI: --add starter, --rules, --rm, --templates write the project config', () => {
  const { dir } = makeRepo();
  const run = (...a) => execFileSync(process.execPath, [path.join(root, 'bin/conductor.js'), 'route', ...a], { cwd: dir }).toString();
  assert.match(run('--rules'), /No routing rules/);
  assert.match(run('--add', 'starter'), /added security/);
  const cfg = () => JSON.parse(fs.readFileSync(path.join(dir, '.conductor/config.json'), 'utf8'));
  assert.equal(cfg().routes.length, 6);
  assert.match(run('--rules'), /1\. text .*\(security\)/);
  assert.match(run('--rm', '1'), /removed rule 1/);
  assert.equal(cfg().routes[0].from, 'database');
  assert.match(run('--templates'), /\[added\]/);
  assert.match(run('add a column', '--files', 'db/002.sql'), /routing rule/);
});

test('docs and the example file cover every template', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/ROUTING.md'), 'utf8');
  for (const t of ROUTE_TEMPLATES) assert.ok(doc.includes('`' + t.id + '`'), `docs/ROUTING.md lists ${t.id}`);
  const example = JSON.parse(fs.readFileSync(path.join(root, 'templates/routes.example.json'), 'utf8'));
  assert.deepEqual(example.routes, addTemplates([], ROUTE_TEMPLATES.map((t) => t.id), P).routes, 'regenerate templates/routes.example.json');
});
