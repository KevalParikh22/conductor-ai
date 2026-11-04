// Routing (which provider takes which task), local model detection, and the tokens-saved estimate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({
  'agent-x': `console.log('## RESULT: DONE\\n## Files changed\\n- (none)\\n## Notes\\n- x');`,
  'agent-y': `console.log('tool call\\n'.repeat(3000) + '## RESULT: DONE\\n## Files changed\\n- (none)\\n## Notes\\n- y');`,
});

const { globToRegex, taskProviders, matchRoute, routeErrors } = await import('../src/routing.js');
const { chooseChain, dispatch, clearCooldowns } = await import('../src/core.js');
const { spreadChains, planBatch } = await import('../src/batch.js');
const { loadConfig, validateConfig } = await import('../src/config.js');
const { detectLocal } = await import('../src/local.js');
const { usageReport, recordSaving, USAGE_FILE } = await import('../src/usage.js');

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'llama3.2' }, { id: 'qwen3-coder:30b' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function cfgWith(dir, routes = []) {
  const cfg = loadConfig(dir);
  cfg.providers['agent-x'] = { type: 'cli', enabled: true, bin: 'agent-x', write: ['x'], read: ['x'] };
  cfg.providers['agent-y'] = { type: 'cli', enabled: true, bin: 'agent-y', write: ['x'], read: ['x'] };
  cfg.roles.build = ['agent-x', 'agent-y'];
  cfg.routes = routes;
  return cfg;
}
const names = (r) => r.chain.map((c) => c.name);

test('globs: ** spans folders, * stays in one, a bare name matches anywhere', () => {
  assert.ok(globToRegex('src/frontend/**').test('src/frontend/a/b.tsx'));
  assert.ok(!globToRegex('src/frontend/*').test('src/frontend/a/b.tsx'));
  assert.ok(globToRegex('*.sql').test('db/migrations/001.sql'));
  assert.ok(globToRegex('**/*.test.js').test('test/x.test.js'));
  assert.ok(!globToRegex('docs/**').test('src/docs.js'));
});

test('routes: first match wins; every named condition must hold; bad routes are config errors', () => {
  const routes = [{ role: 'docs', files: 'src/**', provider: 'a' }, { files: ['src/frontend/**', '*.css'], provider: 'b' }, { text: 'migration|schema', provider: ['c', 'd'] }];
  assert.equal(matchRoute(routes, { role: 'build', files: ['src/frontend/App.tsx'] }).providers[0], 'b');
  assert.equal(matchRoute(routes, { role: 'docs', files: ['src/x.js'] }).index, 0);
  assert.deepEqual(matchRoute(routes, { role: 'build', body: 'Add a Schema change', files: [] }).providers, ['c', 'd']);
  assert.equal(matchRoute(routes, { role: 'build', body: 'nothing', files: ['README.md'] }), null);
  assert.deepEqual(taskProviders('### T1: x\n- **provider:** `codex-cli`, kilo-free\n'), ['codex-cli', 'kilo-free']);
  const errs = routeErrors([{ provider: 'agent-x' }, { files: 'a/**', provider: 'nope' }, { text: '(', provider: 'agent-x' }], { 'agent-x': {} });
  assert.equal(errs.length, 3);
  const { dir } = makeRepo();
  const cfg = cfgWith(dir, [{ files: 'x/**', provider: 'ghost' }]);
  assert.ok(validateConfig(cfg).some((e) => /unknown provider "ghost"/.test(e)));
});

test('precedence: --chain > --provider > plan line > route > selector', () => {
  const { dir } = makeRepo();
  const cfg = cfgWith(dir, [{ files: 'web/**', provider: 'agent-y' }]);
  const ctx = { files: ['web/a.js'], body: 'x' };
  assert.deepEqual(names(chooseChain(cfg, 'build', ctx)), ['agent-y', 'agent-x']);
  assert.equal(chooseChain(cfg, 'build', ctx).how, 'route');
  const plan = chooseChain(cfg, 'build', { ...ctx, section: '### T1\n- **provider:** agent-x' });
  assert.equal(plan.how, 'plan');
  assert.deepEqual(names(plan), ['agent-x', 'agent-y']);
  assert.equal(chooseChain(cfg, 'build', { ...ctx, provider: 'agent-x' }).how, 'provider');
  assert.deepEqual(names(chooseChain(cfg, 'build', { ...ctx, chain: ['agent-x'] })), ['agent-x']);
  assert.notEqual(chooseChain(cfg, 'build', { files: ['other/a.js'], body: 'x' }).how, 'route');
});

test('a routed task runs on its provider and the summary says why; batch keeps routed tasks on theirs', async () => {
  clearCooldowns();
  const PLAN = '# Plan: x\n\n## Tasks\n\n### T1: a\n- **role:** build\n- **files:** `web/a.js`\n\n### T2: b\n- **role:** build\n- **files:** `lib/b.js`\n- **provider:** agent-y\n';
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const cfg = cfgWith(dir, [{ files: 'web/**', provider: 'agent-y' }]);
  const s = await dispatch(cfg, { role: 'build', task: 'do it', files: ['web/a.js'], noVerify: true });
  assert.equal(s.winner, 'agent-y');
  assert.match(s.route, /route 1: files web\/\*\* → agent-y/);
  const { items } = planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'] });
  const spread = spreadChains(cfg, items);
  assert.equal(spread[0].chain[0], 'agent-y', 'T1 matched the route');
  assert.equal(spread[1].chain[0], 'agent-y', 'T2 has a provider line');
  const bin = new URL('../bin/conductor.js', import.meta.url).pathname;
  fs.writeFileSync(path.join(dir, '.conductor', 'config.json'), JSON.stringify({ providers: { 'agent-x': cfg.providers['agent-x'], 'agent-y': cfg.providers['agent-y'] }, roles: { build: ['agent-x', 'agent-y'] }, routes: [{ files: 'web/**', provider: 'agent-y' }] }));
  const out = execFileSync(process.execPath, [bin, 'route', 'add a page', '--files', 'web/x.js'], { cwd: dir, env: { ...process.env, CONDUCTOR_HOME: home } }).toString();
  assert.match(out, /routing rule: route 1/);
  assert.match(out, /1\. agent-y/);
});

test('local models: running servers are found with their best coding model; non-chat models are not offered', async () => {
  const found = await detectLocal({ servers: [{ id: 'ollama', label: 'Ollama', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: '' }, { id: 'jan', label: 'Jan', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: '' }] });
  assert.equal(found[0].running, true);
  assert.equal(found[0].best, 'qwen3-coder:30b');
  assert.equal(found[1].running, false);
  const embedOnly = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'qwen3-embedding:0.6b' }] })); });
  await new Promise((r) => embedOnly.listen(0, '127.0.0.1', r));
  const [e] = await detectLocal({ servers: [{ id: 'ollama', label: 'Ollama', baseUrl: `http://127.0.0.1:${embedOnly.address().port}/v1`, apiKeyEnv: '' }] });
  embedOnly.close();
  assert.equal(e.best, '');
  assert.match(e.next, /only non-chat models.*ollama pull/);
});

test('tokens saved: trimmed reports are counted per run and in the usage report', async () => {
  clearCooldowns();
  fs.rmSync(USAGE_FILE(), { force: true });
  const { dir } = makeRepo();
  const cfg = cfgWith(dir);
  const s = await dispatch(cfg, { role: 'build', task: 'x', chain: ['agent-y'], noVerify: true });
  assert.ok(s.tokensSaved.report > 7000, JSON.stringify(s.tokensSaved));
  recordSaving({ source: 'diff', chars: 4000 });
  const u = usageReport(1);
  assert.equal(u.savings.by.diff, 1000);
  assert.equal(u.savings.controller, u.savings.by.diff + u.savings.by.report);
  assert.ok(!u.rows.some((r) => r.provider === undefined), 'savings are not counted as a provider');
});
