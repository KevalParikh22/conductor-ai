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
