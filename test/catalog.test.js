// Provider catalog, generated guides, and the add / keys / setup flows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

const home = isolateHome();
const { CATALOG, CATEGORIES, BUILTIN_ALIASES, urlFields } = await import('../src/catalog.js');
const { DEFAULT_PROVIDERS } = await import('../src/presets.js');
const { loadConfig, providerReadiness } = await import('../src/config.js');
const { addProvider, addProviderAuto, catalogStatus, detect, keyList, providerNameFor } = await import('../src/setup.js');
const { isPlaceholderKey } = await import('../src/util.js');
const { allDocs } = await import('../scripts/gen-provider-docs.mjs');

let server, port, lastModel;
before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; }).on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'safety-guard-8b' }, { id: 'big-paid' }, { id: 'small:free' }, { id: 'qwen-coder' }] }));
      lastModel = JSON.parse(raw).model;
      res.end(JSON.stringify({ choices: [{ message: { content: 'An answer with enough words in it.' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('every catalog entry is complete and safe', () => {
  const envs = new Map();
  for (const [id, e] of Object.entries(CATALOG)) {
    assert.match(id, /^[a-z0-9-]+$/, id);
    for (const k of ['label', 'category', 'baseUrl', 'keyUrl', 'docsUrl', 'about', 'verified']) assert.ok(e[k], `${id}.${k}`);
    assert.ok(CATEGORIES[e.category], `${id}: unknown category ${e.category}`);
    assert.ok(e.category === 'local' ? /^https?:\/\//.test(e.baseUrl) : e.baseUrl.startsWith('https://'), `${id}: cloud endpoints must use https`);
    assert.ok(!e.baseUrl.endsWith('/') && !e.baseUrl.endsWith('/chat/completions'), `${id}: baseUrl is the prefix before /chat/completions`);
    assert.ok(e.category === 'local' || e.apiKeyEnv, `${id}: cloud providers name a key env var`);
    if (e.apiKeyEnv) {
      assert.match(e.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/);
      assert.ok(!envs.has(e.apiKeyEnv), `${id} and ${envs.get(e.apiKeyEnv)} share ${e.apiKeyEnv}`);
      envs.set(e.apiKeyEnv, id);
    }
  }
  for (const [name, [id]] of Object.entries(BUILTIN_ALIASES)) assert.equal(DEFAULT_PROVIDERS[name].catalog, id, name);
  assert.deepEqual(urlFields({ baseUrl: 'https://x/{ACCOUNT_ID}/v1/{REGION}' }), ['ACCOUNT_ID', 'REGION']);
});

test('built-in providers keep their names and defaults', () => {
  for (const name of ['kilo-free', 'openrouter-free', 'gemini-api']) assert.equal(DEFAULT_PROVIDERS[name].enabled, true, name);
  assert.equal(DEFAULT_PROVIDERS['opencode-zen'].enabled, false, 'its free models only work inside the OpenCode app');
  assert.equal(DEFAULT_PROVIDERS['kilo-free'].apiKeyOptional, true);
  assert.equal(DEFAULT_PROVIDERS['claude-api'].type, 'anthropic');
});

test('docs/providers matches the catalog (run scripts/gen-provider-docs.mjs after editing it)', () => {
  const dir = new URL('../docs/providers/', import.meta.url);
  for (const [f, text] of Object.entries(allDocs())) assert.equal(fs.readFileSync(new URL(f, dir), 'utf8'), text, `docs/providers/${f} is stale`);
  const extra = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !allDocs()[f]);
  assert.deepEqual(extra, [], 'guides for providers no longer in the catalog');
});

test('placeholder keys count as not set', () => {
  for (const v of ['YOUR_API_KEY', 'your-key-here', '<key>', 'sk-xxxxxxxx', 'changeme', '', '  ']) assert.ok(isPlaceholderKey(v), v);
  for (const v of ['gsk_abc123', 'sk-or-v1-9f8e', 'AIzaSyD']) assert.ok(!isPlaceholderKey(v), v);
  process.env.GROQ_API_KEY = 'YOUR_GROQ_KEY';
  try {
    assert.match(providerReadiness('groq-api', { ...DEFAULT_PROVIDERS['groq-api'], enabled: true, model: 'm' }).reason, /placeholder/);
  } finally { delete process.env.GROQ_API_KEY; }
});

test('add: built-in name reused, key saved mode 600, only changed chains written, model picked live', async () => {
  const { dir } = makeRepo();
  assert.equal(providerNameFor(loadConfig(dir), 'groq'), 'groq-api');
  const r = addProvider(dir, 'groq', { key: 'gsk_real_looking_1', model: 'llama-x' });
  assert.equal(r.name, 'groq-api');
  assert.deepEqual(r.roles, ['docs', 'test', 'review', 'ask']);
  const secrets = path.join(home, 'secrets.env');
  assert.match(fs.readFileSync(secrets, 'utf8'), /^GROQ_API_KEY=gsk_real_looking_1$/m);
  if (process.platform !== 'win32') assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  const cfg = loadConfig(dir);
  assert.equal(cfg.providers['groq-api'].enabled, true);
  assert.equal(cfg.providers['groq-api'].model, 'llama-x');
  assert.ok(cfg.roles.docs.includes('groq-api'));

  // kilo-free is already on and in every chat role: adding it again changes nothing
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.deepEqual(addProvider(dir, 'kilo').roles, []);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);

  // a new entry without a model gets the first free one from GET /models
  const local = await addProviderAuto(dir, 'lmstudio', { baseUrl: `http://127.0.0.1:${port}/v1` });
  assert.equal(local.provider.model, 'qwen-coder', 'coding models first, guard models skipped');
  assert.equal(catalogStatus(loadConfig(dir)).find((c) => c.id === 'lmstudio').enabled, true);

  assert.throws(() => addProvider(dir, 'not-a-provider'), /unknown provider/);
  assert.ok(keyList(loadConfig(dir)).find((k) => k.name === 'GROQ_API_KEY').set);
  assert.ok(detect(loadConfig(dir)).keys.some((k) => k.id === 'groq'));
});

test('URL placeholders must be filled', () => {
  const id = Object.keys(CATALOG).find((k) => urlFields(CATALOG[k]).length);
  if (!id) return; // no entry needs one
  const { dir } = makeRepo();
  assert.throws(() => addProvider(dir, id), /needs/);
  const fields = Object.fromEntries(urlFields(CATALOG[id]).map((f) => [f, 'abc']));
  const r = addProvider(dir, id, { fields });
  assert.ok(!r.provider.baseUrl.includes('{'));
});

test('CLI: providers lists the catalog; keys set reads stdin; add --yes without a key explains what to do', () => {
  const { dir } = makeRepo();
  const bin = new URL('../bin/conductor.js', import.meta.url).pathname;
  const run = (args, input) => execFileSync(process.execPath, [bin, ...args], { cwd: dir, input, env: { ...process.env, CONDUCTOR_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const list = run(['providers', '--json']);
  assert.equal(JSON.parse(list).length, Object.keys(CATALOG).length);
  assert.match(run(['keys', 'set', 'CEREBRAS_API_KEY'], 'csk-test-123\n'), /saved CEREBRAS_API_KEY/);
  assert.match(fs.readFileSync(path.join(home, 'secrets.env'), 'utf8'), /^CEREBRAS_API_KEY=csk-test-123$/m);
  try { run(['add', 'mistral', '--yes']); assert.fail('should fail without a key'); } catch (e) { assert.match(e.stderr.toString(), /MISTRAL_API_KEY is not set.*conductor keys set MISTRAL_API_KEY/s); }
});

test('an API provider with no model gets one picked from its live list when it runs', async () => {
  const { dispatch, clearCooldowns } = await import('../src/core.js');
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.auto = { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: '', model: '' };
  assert.equal(providerReadiness('auto', cfg.providers.auto).ready, true);
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['auto'] });
  assert.equal(s.winner, 'auto');
  assert.equal(lastModel, 'qwen-coder');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'models-cache.json'), 'utf8')).auto.model, 'qwen-coder');
});
