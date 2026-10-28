import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, makeRepo, fakeBins, PLAN } from './helpers.js';

isolateHome();
fakeBins({
  // Antigravity CLI: records its argv, then fails on quota after leaving partial work behind
  agy: `fs.writeFileSync(process.env.AGY_ARGS_LOG, JSON.stringify(args)); fs.writeFileSync('src/partial.js','half'); console.error('Error: RESOURCE_EXHAUSTED quota exceeded'); process.exit(1);`,
  // succeeds: reads prompt from stdin, writes -o file
  codex: `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
    if(p.includes('code review')){fs.writeFileSync(o,'## Findings\\nnone\\n## VERDICT: APPROVE\\n');return;}
    fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js','export const add=(a,b)=>a+b;\\n');
    fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- none\\n## Notes\\n- none\\n');});`,
  // read-only offender
  sneaky: `fs.writeFileSync('sneaky.txt','x'); console.log('## Findings\\nnone\\n## VERDICT: APPROVE padding padding');`,
  // exits 0 but only prints a usage-limit message
  limited: `console.log("You've hit your usage limit. Try again later.");`,
});

let server, port;
const calls = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => body += d).on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      if (req.url.startsWith('/limited/')) { res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' }); return res.end('{"error":{"message":"rate limited"}}'); }
      const content = req.url.startsWith('/nofiles/') ? 'I cannot do that.\n## RESULT: BLOCKED'
        : '<<<FILE README.md\n# Demo\nadd(a,b) adds numbers.\nFILE>>>\n<<<FILE AGENTS.md\nhacked\nFILE>>>\n## RESULT: DONE';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const { loadConfig } = await import('../src/config.js');
const { dispatch, getCooldowns, clearCooldowns, UsageError } = await import('../src/core.js');
const { runOpenAI } = await import('../src/providers.js');
process.env.AGY_ARGS_LOG = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.CONDUCTOR_HOME), 'agy-')), 'args.json');

function cfgFor(dir, extraProviders = {}) {
  const cfg = loadConfig(dir);
  cfg.providers = {
    ...cfg.providers,
    sneaky: { type: 'cli', enabled: true, bin: 'sneaky', write: ['x'], read: ['x'] },
    limited: { type: 'cli', enabled: true, bin: 'limited', write: ['x'], read: ['x'] },
    'mock-api': { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/ok`, apiKeyEnv: 'MOCK_API_KEY', model: 'm' },
    'mock-nofiles': { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/nofiles`, apiKeyEnv: '', model: 'm' },
    'mock-429': { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/limited`, apiKeyEnv: '', model: 'm' },
    ...extraProviders,
  };
  return cfg;
}

test('build falls back from a rate-limited agent to the next, stashing partial work', async () => {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['antigravity-cli', 'codex-cli'] });
  const agyArgs = JSON.parse(fs.readFileSync(process.env.AGY_ARGS_LOG, 'utf8'));
  assert.ok(agyArgs.includes('--dangerously-skip-permissions'), 'write mode skips permission prompts');
  assert.match(agyArgs[agyArgs.indexOf('-p') + 1], /add function/, 'the prompt is passed with -p');
  assert.equal(s.exitCode, 0);
  assert.equal(s.winner, 'codex-cli');
  assert.equal(s.attempts[0].stashed, true);
  assert.match(s.attempts[0].reason, /^quota \(cooldown 30m\)/);
  assert.match(s.status, /RESULT: DONE/);
  assert.deepEqual(s.changed, ['src/add.js']);
  assert.equal(s.verify.status, 'PASS');
  assert.ok(!fs.existsSync(path.join(dir, 'src/partial.js')), 'partial work must be stashed, not left in the tree');
  assert.match(git('stash', 'list'), /conductor: failed attempt by antigravity-cli T1/);
  assert.ok(getCooldowns()['antigravity-cli'], 'rate-limited provider cools down');

  // second run skips the cooling-down provider without calling it
  git('add', '-A'); git('commit', '-qm', 't1');
  const s2 = await dispatch(cfgFor(dir), { role: 'build', task: 'tweak', chain: ['antigravity-cli', 'codex-cli'], noVerify: true });
  assert.equal(s2.attempts[0].skipped, true);
  assert.match(s2.attempts[0].reason, /cooling down/);
});

test('exit 3 when every provider fails; exit-0 usage-limit message counts as quota', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(cfgFor(dir), { role: 'build', task: 'x', chain: ['limited', 'not-a-provider'] });
  assert.equal(s.exitCode, 3);
  assert.equal(s.winner, null);
  assert.match(s.attempts[0].reason, /^quota/);
  assert.equal(s.attempts[1].reason, 'unknown provider');
});

test('chat provider: file blocks applied, protected files rejected, key sent', async () => {
  clearCooldowns();
  process.env.MOCK_API_KEY = 'sk-test';
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const s = await dispatch(cfgFor(dir), { role: 'docs', planPath: 'docs/plan/p.md', taskId: 'T2', chain: ['mock-nofiles', 'mock-api'] });
  assert.equal(s.winner, 'mock-api');
  assert.equal(s.attempts[0].reason, 'no file blocks in reply');
  assert.deepEqual(s.applied, ['README.md']);
  assert.deepEqual(s.rejected, ['AGENTS.md (protected)']);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# Demo\nadd(a,b) adds numbers.\n');
  const call = calls.find((c) => c.url === '/ok/chat/completions');
  assert.equal(call.auth, 'Bearer sk-test');
  assert.match(call.body.messages[0].content, /<<<FILE/, 'system prompt explains the file protocol');
  assert.match(call.body.messages[1].content, /add\(\) lives in src\/add\.js/, 'design notes are included for chat models');
});

test('HTTP 429 sets a cooldown from Retry-After', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(cfgFor(dir), { role: 'ask', task: 'what is this?', chain: ['mock-429'] });
  assert.equal(s.exitCode, 3);
  assert.match(s.attempts[0].reason, /quota \(cooldown 2m\)/);
  assert.ok(getCooldowns()['mock-429']);
});

test('read-only roles warn when a worker modifies files', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'x.js'), 'changed');
  const s = await dispatch(cfgFor(dir), { role: 'review', chain: ['sneaky'] });
  assert.equal(s.winner, 'sneaky');
  assert.ok(s.warnings.some((w) => w.includes('read-only')));
});

test('review sends the diff and returns the verdict', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'new.js'), 'export const x = 1;\n');
  const s = await dispatch(cfgFor(dir), { role: 'review', chain: ['codex-cli'] });
  assert.match(s.status, /VERDICT: APPROVE/);
  const task = fs.readFileSync(path.join(dir, s.runDir, 'task.md'), 'utf8');
  assert.match(task, /new\.js/, 'untracked files are part of the reviewed diff');
});

test('safety: protected branch, dirty tree and missing task are usage errors', async () => {
  clearCooldowns();
  const main = makeRepo({ branch: null });
  await assert.rejects(dispatch(cfgFor(main.dir), { role: 'build', task: 'x' }), (e) => e instanceof UsageError && /protected branch/.test(e.message));
  const dirty = makeRepo();
  fs.writeFileSync(path.join(dirty.dir, 'wip.js'), 'x');
  await assert.rejects(dispatch(cfgFor(dirty.dir), { role: 'build', task: 'x' }), /dirty/);
  const plan = makeRepo({ files: { 'p.md': PLAN } });
  await assert.rejects(dispatch(cfgFor(plan.dir), { role: 'build', planPath: 'p.md', taskId: 'T9' }), /T9.*not found/);
  await assert.rejects(dispatch(cfgFor(plan.dir), { role: 'nope', task: 'x' }), /unknown role/);
});

test('antigravity read mode uses plan mode; huge prompts go through the prompt file', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const big = 'x'.repeat(150_000);
  await dispatch(cfgFor(dir), { role: 'ask', task: 'what does add do? ' + big, chain: ['antigravity-cli'] });
  const args = JSON.parse(fs.readFileSync(process.env.AGY_ARGS_LOG, 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2), ['--mode', 'plan']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.match(args[args.indexOf('-p') + 1], /^Read the file .*antigravity-cli\.prompt\.md/);
});

test('apiKeyOptional: runs without a key and sends one when present', async () => {
  const p = { type: 'openai', baseUrl: `http://127.0.0.1:${port}/ok`, apiKeyEnv: 'OPTIONAL_TEST_KEY', apiKeyOptional: true, model: 'm' };
  delete process.env.OPTIONAL_TEST_KEY;
  const r1 = await runOpenAI('opt', p, { system: 's', prompt: 'p1', timeoutMs: 5000 });
  assert.equal(r1.ok, true);
  assert.equal(calls.at(-1).auth, undefined);
  process.env.OPTIONAL_TEST_KEY = 'k1';
  await runOpenAI('opt', p, { system: 's', prompt: 'p2', timeoutMs: 5000 });
  assert.equal(calls.at(-1).auth, 'Bearer k1');
  const r3 = await runOpenAI('req', { ...p, apiKeyOptional: false, apiKeyEnv: 'MISSING_TEST_KEY' }, { system: 's', prompt: 'p3', timeoutMs: 5000 });
  assert.equal(r3.reason, 'MISSING_TEST_KEY not set');
});
