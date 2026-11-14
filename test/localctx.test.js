// V13: local models that don't fail silently. A fake Ollama behaves like the real one (0.40, measured): a model runs
// with a 4,096-token window unless told otherwise, it is loaded by an empty generate, and a longer prompt is cut
// without an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { localWindow, estimateTokens } = await import('../src/local.js');
const { dispatch, clearCooldowns, formatSummary } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

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
const REPLY = '<<<FILE src/add.js\nexport const add = (a, b) => a + b;\nFILE>>>\n## RESULT: DONE\n## Files changed\n- src/add.js\n## Checks run\n- none\n## Acceptance\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1\n';

/** A fake Ollama: { window, numCtx, cutTo, loaded } can be changed between calls. */
async function fakeOllama(opts) {
  const st = { window: 4096, numCtx: 0, loaded: false, cutTo: 0, inFlight: 0, maxInFlight: 0, chats: [], ...opts };
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return send({ version: '0.40.13' });
    if (req.url === '/api/show') return send({ parameters: st.numCtx ? `num_ctx                        ${st.numCtx}\ntemperature 1` : 'temperature 1', model_info: { 'qwen35.context_length': 262144 } });
    if (req.url === '/api/ps') return send({ models: st.loaded ? [{ name: 'tiny:2b', model: 'tiny:2b', context_length: st.numCtx || st.window }] : [] });
    if (req.url === '/api/generate') { st.loaded = true; return send({ done: true }); }
    if (req.url === '/v1/models') return send({ data: [{ id: 'tiny:2b' }] });
    if (req.url === '/v1/chat/completions') {
      st.inFlight++; st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
      const prompt = j.messages.map((m) => m.content).join('\n');
      st.chats.push(prompt);
      await new Promise((r) => setTimeout(r, 150));
      st.inFlight--;
      return send({ model: 'tiny:2b', choices: [{ message: { content: REPLY } }], usage: { prompt_tokens: st.cutTo || estimateTokens(prompt), completion_tokens: 40 } });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.url = `http://localhost:${srv.address().port}/v1`;
  st.close = () => { srv.closeAllConnections(); srv.close(); };
  return st;
}
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir, url, extra = {}) => {
  const cfg = loadConfig(dir);
  cfg.providers = { local: { type: 'openai', enabled: true, baseUrl: url, apiKeyEnv: '', model: 'tiny:2b' }, ...extra };
  cfg.roles = { ...cfg.roles, build: ['local'] };
  cfg.settings = { ...cfg.settings, autoReview: false };
  return cfg;
};

test('the window comes from the server: a loaded model, num_ctx, or loading it first; null when the server cannot say', async () => {
  const o = await fakeOllama({ window: 4096 });
  try {
    const w = await localWindow({ baseUrl: o.url, model: 'tiny:2b' });
    assert.deepEqual(w, { window: 4096, trained: 262144, server: 'Ollama 0.40.13', source: 'loaded model' });
    assert.equal(o.loaded, true, 'it loaded the model to learn its window (and keeps it loaded for the task)');
  } finally { o.close(); }
  const o2 = await fakeOllama({ numCtx: 32768, loaded: true });
  try { assert.equal((await localWindow({ baseUrl: o2.url, model: 'tiny:2b' })).window, 32768); } finally { o2.close(); }
  assert.equal(await localWindow({ baseUrl: 'http://localhost:9/v1', model: 'x' }), null, 'nothing listening');
});

test('a prompt that will not fit is not sent: the attempt says why and how to fix it, and the next route runs', async () => {
  clearCooldowns();
  const small = await fakeOllama({ window: 512 });
  const big = await fakeOllama({ window: 32768 });
  try {
    const { dir } = repo();
    const cfg = cfgFor(dir, small.url, { local2: { type: 'openai', enabled: true, baseUrl: big.url, apiKeyEnv: '', model: 'tiny:2b' } });
    const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['local', 'local2'] });
    assert.match(s.attempts[0].reason, /^context too small: the prompt needs ~\d+ tokens with the answer, tiny:2b runs with 512 \(Ollama 0\.40\.13\)/);
    assert.match(s.attempts[0].next, /OLLAMA_CONTEXT_LENGTH=\d+/);
    assert.equal(small.chats.length, 0, 'nothing was sent to the small window');
    assert.equal(s.winner, 'local2');
    assert.match(formatSummary(s), /fix: +local: give tiny:2b a bigger window/);
  } finally { small.close(); big.close(); }
});

test('a cut the window check could not see is still caught from the token count; local models get the small prompt', async () => {
  clearCooldowns();
  const o = await fakeOllama({ window: 32768, cutTo: 50 });
  try {
    const { dir } = repo();
    const s = await dispatch(cfgFor(dir, o.url), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1' });
    assert.ok(s.warnings.some((w) => /saw only 50 prompt tokens of about \d+: the local server cut the prompt/.test(w)));
    assert.ok(!o.chats[0].includes('# Project map'), 'no project map for a local model');
    assert.ok(o.chats[0].includes('# TASK'), 'the task itself is there');
  } finally { o.close(); }
});

test('one call at a time per local server, even from parallel tasks', async () => {
  clearCooldowns();
  const o = await fakeOllama({ window: 32768, loaded: true });
  try {
    const runs = [repo(), repo()].map(({ dir }) => dispatch(cfgFor(dir, o.url), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1' }));
    const out = await Promise.all(runs);
    assert.ok(out.every((s) => s.winner === 'local'));
    assert.equal(o.maxInFlight, 1, 'the server never had two prompts at once');
  } finally { o.close(); }
});

test('adding a local provider checks its model is installed: it switches to a usable one, or says what to pull', async () => {
  const { checkLocalModel } = await import('../src/setup.js');
  const o = await fakeOllama({}); // serves tiny:2b only
  try {
    const { dir } = makeRepo();
    const r = await checkLocalModel(dir, 'ollama', { name: 'ollama', provider: { type: 'openai', baseUrl: o.url, model: 'qwen3-coder' }, roles: [] });
    assert.match(r.warning, /qwen3-coder isn't installed on this server yet \(it has tiny:2b, too small for coding tasks\): ollama pull qwen3-coder/);
    const ok = await checkLocalModel(dir, 'ollama', { name: 'ollama', provider: { type: 'openai', baseUrl: o.url, model: 'tiny:2b' }, roles: [] });
    assert.equal(ok.warning, undefined, 'an installed model is kept as it is');
    const cloud = await checkLocalModel(dir, 'groq', { name: 'groq', provider: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'x' }, roles: [] });
    assert.equal(cloud.warning, undefined, 'cloud providers are not checked');
    const down = await checkLocalModel(dir, 'ollama', { name: 'ollama', provider: { type: 'openai', baseUrl: 'http://localhost:9/v1', model: 'm' }, roles: [] });
    assert.match(down.warning, /didn't answer/);
  } finally { o.close(); }
});
