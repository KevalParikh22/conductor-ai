// First-run defaults: the controller's own CLI is never turned on as a worker, tiny local models aren't picked,
// and a fresh doctor isn't red for providers that simply have no key yet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({ claude: 'console.log("x")', codex: 'console.log("x")' });
const { loadConfig } = await import('../src/config.js');
const { detect, enableDetected } = await import('../src/setup.js');
const { wantProviders, ROUTE_TEMPLATES, resolveTemplate } = await import('../src/routing.js');
const { controllerWorker } = await import('../src/presets.js');
const { modelSizeB } = await import('../src/models.js');
const { detectLocal } = await import('../src/local.js');
const bin = new URL('../bin/conductor.js', import.meta.url).pathname;

test('setup never turns on the controller\'s own CLI as a worker', () => {
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  assert.equal(controllerWorker(cfg.controller), 'claude-cli');
  const found = detect(cfg);
  assert.equal(found.agents.find((a) => a.name === 'claude-cli').controller, true);
  const on = enableDetected(dir, found);
  assert.ok(!on.includes('claude-cli'));
  assert.ok(!loadConfig(dir).providers['claude-cli'].enabled);
});

test('routing rules never pick the controller\'s own CLI, even when it is enabled', () => {
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['claude-cli'].enabled = true;
  assert.equal(wantProviders('strong', cfg.providers)[0], 'claude-cli', 'without exclude it would be first');
  const r = resolveTemplate(ROUTE_TEMPLATES.find((t) => t.id === 'security'), cfg.providers, { exclude: ['claude-cli'] });
  assert.ok(![].concat(r.route.provider).includes('claude-cli'));
});

test('model size is read from the id; local models under 7B are not picked', async () => {
  assert.equal(modelSizeB('qwen3.5:2b'), 2);
  assert.equal(modelSizeB('mixtral:8x7b'), 56);
  assert.equal(modelSizeB('qwen3-coder:30b-a3b'), 30);
  assert.equal(modelSizeB('qwen3-coder'), null);
  const serve = (ids) => new Promise((resolve) => {
    const s = http.createServer((q, r) => r.end(JSON.stringify({ data: ids.map((id) => ({ id })) })));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const small = await serve(['qwen3.5:2b', 'nomic-embed-text']);
  const mixed = await serve(['gemma3:1b', 'qwen3-coder:30b-a3b']);
  after(() => { small.close(); mixed.close(); });
  const [a, b] = await detectLocal({ servers: [
    { id: 'ollama', label: 'Ollama', baseUrl: `http://127.0.0.1:${small.address().port}/v1` },
    { id: 'lmstudio', label: 'LM Studio', baseUrl: `http://127.0.0.1:${mixed.address().port}/v1` },
  ] });
  assert.equal(a.best, '');
  assert.match(a.next, /only small models \(qwen3\.5:2b, 2B\).*too small.*ollama pull qwen3-coder/);
  assert.equal(b.best, 'qwen3-coder:30b-a3b');
});

test('doctor: a default provider with no key is optional (○), one you turned on is a problem (✗)', () => {
  const { dir } = makeRepo();
  const doctor = () => {
    try { return { code: 0, out: execFileSync(process.execPath, [bin, 'doctor'], { cwd: dir, env: { ...process.env, GEMINI_API_KEY: '' } }).toString() }; } catch (e) { return { code: e.status, out: e.stdout.toString() }; }
  };
  let r = doctor();
  assert.match(r.out, /○ gemini-api +optional: add a key/);
  assert.doesNotMatch(r.out, /✗ gemini-api/);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: { 'gemini-api': { enabled: true } } }));
  r = doctor();
  assert.match(r.out, /✗ gemini-api +GEMINI_API_KEY not set/);
  fs.rmSync(path.join(home, 'config.json'));
});

test('a hanging free route: one more model after a timeout, then the chain moves on; an old model list is reused', async () => {
  const { dispatch, clearCooldowns } = await import('../src/core.js');
  const { GLOBAL_DIR } = await import('../src/util.js');
  let listing = true;
  const calls = [];
  const s = http.createServer((q, r) => {
    if (q.url.endsWith('/models')) { if (!listing) { r.statusCode = 503; return r.end('{}'); } return r.end(JSON.stringify({ data: [{ id: 'a:free' }, { id: 'b:free' }, { id: 'c:free' }] })); }
    let b = ''; q.on('data', (d) => { b += d; }).on('end', () => calls.push(JSON.parse(b).model)); // never answers
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  after(() => { s.closeAllConnections(); s.close(); });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.settings.freeApiTimeoutSec = 1;
  cfg.providers.hang = { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${s.address().port}/v1`, apiKeyEnv: '', model: 'a:free', free: true };
  const t0 = Date.now();
  const r = await dispatch(cfg, { role: 'ask', task: 'hi', chain: ['hang'] });
  assert.deepEqual(r.attempts.map((x) => x.model), ['a:free', 'b:free'], 'stops after the second timeout');
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0}ms`); // seconds, not the 5 minutes it used to wait (slow CI runners need room)
  // the provider can't list its models now: the expired list from before is used
  const cacheFile = path.join(GLOBAL_DIR, 'models-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache['hang#fallbacks'].at = 0;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  listing = false; calls.length = 0;
  await dispatch(cfg, { role: 'ask', task: 'hi', chain: ['hang'] });
  assert.deepEqual(calls, ['a:free', 'b:free']);
});

test('init writes the detected verify command into AGENTS.md (Node and PHP)', async () => {
  const { initProject } = await import('../src/init.js');
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { lint: 'eslint .', test: 'node --test' } }));
  initProject(dir, {});
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /\*\*Verify[^\n]*`npm run lint && npm run test`/);
  const php = makeRepo().dir;
  fs.rmSync(path.join(php, 'package.json'));
  fs.writeFileSync(path.join(php, 'composer.json'), '{"name":"a/b"}');
  fs.writeFileSync(path.join(php, 'phpunit.xml.dist'), '<phpunit/>');
  initProject(php, {});
  assert.match(fs.readFileSync(path.join(php, 'AGENTS.md'), 'utf8'), /`vendor\/bin\/phpunit`/);
});

test('runs list shows verify failures and partial results, not just "done"', async () => {
  const { listRuns } = await import('../src/runs.js');
  const { dir } = makeRepo();
  const put = (id, s) => { const d = path.join(dir, '.conductor', 'runs', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role: 'build', attempts: [], ...s })); };
  put('20261107-000001-build', { winner: 'x', status: '## RESULT: DONE', verify: { status: 'FAIL' } });
  put('20261107-000002-build', { winner: 'x', status: '## RESULT: PARTIAL' });
  put('20261107-000003-build', { winner: 'x', status: '## RESULT: DONE', verify: { status: 'PASS' } });
  put('20261107-000004-build', { winner: null });
  const states = Object.fromEntries(listRuns(dir).map((r) => [r.id.slice(-12), r.state]));
  assert.deepEqual(states, { '000004-build': 'failed', '000003-build': 'done', '000002-build': 'partial', '000001-build': 'verify-failed' });
});

test('status, doctor and the UI data agree: a default provider with no key is optional, not broken', async () => {
  const { statusData, statusReport } = await import('../src/status.js');
  const { dir } = makeRepo();
  const saved = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = '';
  try {
    const cfg = loadConfig(dir);
    const g = statusData(cfg).providers.find((p) => p.name === 'gemini-api');
    assert.equal(g.optional, true);
    assert.match(g.reason, /optional: add GEMINI_API_KEY/);
    assert.match(statusReport(cfg), /○ gemini-api/);
    assert.doesNotMatch(statusReport(cfg), /✗ gemini-api/);
  } finally { if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved; }
});

test('CLI: a typo gets a suggestion; piped output has no colour codes; long descriptions are cut at a word', () => {
  const run = (...a) => { try { return execFileSync(process.execPath, [bin, ...a], { stdio: 'pipe', env: { ...process.env, FORCE_COLOR: '' } }).toString(); } catch (e) { return e.stderr.toString() + e.stdout.toString(); } };
  assert.match(run('bulid'), /Did you mean: conductor build\?/);
  assert.doesNotMatch(run('xyzzy'), /Did you mean/);
  const list = run('providers');
  assert.doesNotMatch(list, /\x1b\[/, 'no ANSI codes when piped');
  assert.doesNotMatch(list, /limits, e$/m, 'not cut mid-word');
  const colored = execFileSync(process.execPath, [bin, 'providers', '--json'], { env: { ...process.env, FORCE_COLOR: '1' } }).toString();
  assert.doesNotMatch(colored, /\x1b\[/, '--json is never coloured');
});

test('UI: the open page lives in the address, and links never drop the token', () => {
  const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /function pageFromHash\(\)/);
  assert.match(html, /history\.pushState/);
  assert.match(html, /addEventListener\('popstate'/);
  assert.match(html, /\[data-goto\][^\n]*preventDefault/);
});

test('switching to Antigravity says how to register conductor with agy, unless it already is', async () => {
  const { initProject, agyHasConductor } = await import('../src/init.js');
  const cfgFile = path.join(home, 'agy-mcp.json');
  assert.equal(agyHasConductor(cfgFile), false, 'missing file');
  fs.writeFileSync(cfgFile, '');
  assert.equal(agyHasConductor(cfgFile), false, 'empty file');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { conductor: { command: 'conductor', args: ['mcp'] } } }));
  assert.equal(agyHasConductor(cfgFile), true);
  const { dir } = makeRepo();
  const r = initProject(dir, { controller: 'antigravity' });
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-plan/SKILL.md')), 'skills written where agy reads them');
  assert.ok(r.notes.some((n) => /agy mcp add conductor conductor mcp/.test(n)) || agyHasConductor(), 'register hint unless already registered');
});

test('UI: picking a controller is a project action, not part of Save (Save to global used to be silently overridden)', () => {
  const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /input\[name=ctrl\]'\)\.forEach\(\(r\) => r\.onchange = \(\) => \{ ctrlPick = r\.value; render\(\); \}\)/);
  assert.doesNotMatch(html, /W\.controller = r\.value; markDirty\(\)/);
  assert.match(html, /Switch this project to/);
});

test('init --verify sets the Verify line; without any verify command init says results will be unverified', async () => {
  const { initProject } = await import('../src/init.js');
  const { dir, git } = makeRepo();
  git('rm', '-q', 'package.json'); git('commit', '-qm', 'no scripts');
  let r = initProject(dir, {});
  assert.ok(r.notes.some((n) => /No verify command found[\s\S]*unverified[\s\S]*conductor init --verify/.test(n)));
  r = initProject(dir, { verify: 'make check' });
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /^- \*\*Verify \(must pass before any task is "done"\):\*\* `make check`$/m);
  assert.ok(r.lines.some((l) => /updated +AGENTS\.md \(Verify: make check\)/.test(l)));
  assert.ok(!r.notes.some((n) => /No verify command/.test(n)));
  r = initProject(dir, { verify: 'make check' });
  assert.ok(r.lines.some((l) => /kept +AGENTS\.md \(Verify: make check\)/.test(l)), 'running it again changes nothing');
  const fresh = makeRepo().dir;
  initProject(fresh, { verify: 'npm run ci' });
  assert.match(fs.readFileSync(path.join(fresh, 'AGENTS.md'), 'utf8'), /`npm run ci`/, 'beats the detected command');
});

test('runs list shows unverified work', async () => {
  const { listRuns, formatRuns } = await import('../src/runs.js');
  const { dir } = makeRepo();
  const d = path.join(dir, '.conductor', 'runs', '20261111-000001-build'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role: 'build', mode: 'write', attempts: [], winner: 'x', status: '## RESULT: DONE', verify: { status: 'SKIPPED' }, changed: [] }));
  const rows = listRuns(dir);
  assert.equal(rows[0].state, 'unverified');
  assert.match(formatRuns(rows), /\? unverif/);
});
