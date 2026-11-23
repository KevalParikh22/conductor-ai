// conductor-ai demo: a throwaway project, both tasks handed out in parallel, merged when they pass, tested, removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins, tmpdir } from './helpers.js';

const home = isolateHome();
const { runDemo, DEMO_PLAN, demoFallback, demoUsageNotice } = await import('../src/demo.js');
const { checkPlan } = await import('../src/plancheck.js');

// a fake worker that solves whichever demo task it is given, with a test
fakeBins({
  'demo-worker': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
    const t=(p.match(/Your task id: (T\\d)/)||[])[1];
    const files = t==='T1'
      ? { 'src/titleCase.js': "export function titleCase(text) { if (typeof text !== 'string') throw new TypeError('text'); return text.split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' '); }\\n",
          'test/titleCase.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { titleCase } from '../src/titleCase.js'; test('t', () => assert.equal(titleCase('hello wORLD'), 'Hello World'));\\n" }
      : { 'src/truncate.js': "export function truncate(text, max) { if (!Number.isInteger(max) || max < 1) throw new RangeError('max'); return text.length > max ? text.slice(0, max - 1) + '…' : text; }\\n",
          'test/truncate.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { truncate } from '../src/truncate.js'; test('t', () => assert.equal(truncate('conductor', 5), 'cond…'));\\n" };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(f, c);
    fs.writeFileSync(o, '## RESULT: DONE\\n## Files changed\\n' + Object.keys(files).map((f) => '- ' + f).join('\\n') + '\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 2. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 3. ok — evidence: ' + Object.keys(files)[0] + ':1\\n## Notes\\n- none\\n');});`,
});
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, providers: { good: { type: 'cli', preset: 'codex', enabled: true, bin: 'demo-worker' } }, roles: { build: ['good'] }, settings: { autoReview: false } }));

test('the demo plan is ready to hand out', () => {
  assert.ok(checkPlan(DEMO_PLAN, { verifyCmd: 'npm test' }).every((r) => !r.problems.length));
});

test('demo: both tasks run in parallel, pass every check, merge, the tests pass, and the project is removed', async () => {
  const parent = tmpdir('conductor-demo-parent-');
  const steps = [];
  const d = await runDemo({ provider: 'good', parent, say: (m) => steps.push(m) });
  assert.deepEqual(d.batch.results.map((r) => [r.task, r.outcome]), [['T1', 'done'], ['T2', 'done']]);
  assert.deepEqual(d.merged, ['T1', 'T2']);
  assert.equal(d.verify.status, 'PASS');
  assert.match(steps[0], /A throwaway project/);
  assert.ok(!fs.existsSync(d.dir), 'removed');
  assert.deepEqual(fs.existsSync(path.join(home, 'worktrees')) ? fs.readdirSync(path.join(home, 'worktrees')) : [], [], 'nothing left in conductor\'s worktree folder');
});

test('demo --keep leaves the project, with both helpers merged', async () => {
  const d = await runDemo({ provider: 'good', keep: true, parent: tmpdir('conductor-demo-parent-') });
  assert.ok(fs.existsSync(path.join(d.dir, 'src', 'titleCase.js')) && fs.existsSync(path.join(d.dir, 'src', 'truncate.js')));
});

test('demo without a coding agent: falls back to the free API models that are ready, never paid or unready ones', () => {
  const providers = {
    agent: { type: 'cli', preset: 'codex', enabled: true, bin: 'no-such-agent-bin' },
    freeapi: { type: 'openai', baseUrl: 'https://free.example', free: true, enabled: true },
    paid: { type: 'openai', baseUrl: 'https://paid.example', enabled: true },
    nokey: { type: 'openai', baseUrl: 'https://z.example', free: true, apiKeyEnv: 'NO_SUCH_KEY_XYZ', enabled: true },
    off: { type: 'openai', baseUrl: 'https://off.example', free: true, enabled: false },
  };
  assert.deepEqual(demoFallback({ roles: { build: ['agent'], test: ['freeapi', 'paid'] }, providers }), ['freeapi']);
  // an agent that is installed keeps the normal build chain
  assert.equal(demoFallback({ roles: { build: ['good'] }, providers: { ...providers, good: { type: 'cli', preset: 'codex', enabled: true, bin: 'demo-worker' } } }), null);
  // nothing ready at all: an empty list, so the demo says to run conductor-ai setup
  assert.deepEqual(demoFallback({ roles: { build: ['agent'] }, providers: { agent: providers.agent, nokey: providers.nokey } }), []);
});

test('demo --free uses only free models, even with an agent installed', () => {
  const providers = {
    good: { type: 'cli', preset: 'codex', enabled: true, bin: 'demo-worker' },
    freeapi: { type: 'openai', baseUrl: 'https://free.example', free: true, enabled: true },
    paid: { type: 'openai', baseUrl: 'https://paid.example', enabled: true },
  };
  assert.deepEqual(demoFallback({ roles: { build: ['good', 'paid'], test: ['freeapi'] }, providers }, { free: true }), ['freeapi']);
});

test('the demo says before it runs whose quota it uses', () => {
  const providers = {
    good: { type: 'cli', preset: 'codex', enabled: true, bin: 'demo-worker' },
    gone: { type: 'cli', preset: 'codex', enabled: true, bin: 'no-such-agent-bin' },
    freeapi: { type: 'openai', baseUrl: 'https://free.example', free: true, enabled: true },
  };
  const notice = demoUsageNotice({ roles: { build: ['gone', 'good'] }, providers });
  assert.match(notice, /Workers: good\. good uses a little of your own plan, quota or key/);
  assert.match(notice, /Claude is not called/);
  assert.match(notice, /conductor-ai demo --free/);
  assert.equal(demoUsageNotice({ roles: { build: ['good'] }, providers }, 'freeapi'), '', 'a free worker needs no notice');
});

test('demo --free with no free model ready never falls back to the installed agent', async () => {
  // switch off every built-in free model for this test, so it stays offline
  const cfgFile = path.join(home, 'config.json');
  const saved = fs.readFileSync(cfgFile, 'utf8');
  const { loadConfig } = await import('../src/config.js');
  const off = Object.fromEntries(Object.entries(loadConfig(tmpdir('conductor-demo-cfg-')).providers).filter(([, p]) => p.free).map(([n]) => [n, { enabled: false }]));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(saved), providers: { ...JSON.parse(saved).providers, ...off } }));
  const steps = [];
  let d;
  try { d = await runDemo({ free: true, parent: tmpdir('conductor-demo-parent-'), say: (m) => steps.push(m) }); } finally { fs.writeFileSync(cfgFile, saved); }
  assert.ok(steps.some((m) => /--free: no free model is ready/.test(m)), steps.join('\n'));
  assert.deepEqual(d.merged, []);
  assert.ok(d.batch.results.every((r) => !r.provider || r.provider !== 'good'));
});

test('soft-launch defaults: beta agents are marked and not turned on by setup, the web bridge is off, paid APIs stop at $2 a day', async () => {
  const { CLI_PRESETS, DEFAULT_CONFIG } = await import('../src/presets.js');
  const { enableDetected } = await import('../src/setup.js');
  assert.deepEqual(Object.keys(CLI_PRESETS).filter((k) => CLI_PRESETS[k].beta).sort(), ['aider', 'copilot', 'goose', 'grok', 'kimi', 'kiro']);
  assert.equal(DEFAULT_CONFIG.providers.manual.enabled, false);
  assert.equal(DEFAULT_CONFIG.settings.dailyBudgetUSD, 2);
  const root = tmpdir('conductor-setup-');
  const on = enableDetected(root, { agents: [{ name: 'goose', installed: true, enabled: false, beta: true }, { name: 'codex-cli', installed: true, enabled: false }], keys: [] });
  assert.deepEqual(on, ['codex-cli']);
});

test('demo: a task that fails its checks gets a fresh attempt, and passes on the retry', async () => {
  const counter = path.join(tmpdir('conductor-flaky-'), 'n');
  // the same fake worker, but its first answer to T2 is wrong (truncate never cuts)
  fakeBins({
    'flaky-worker': `const c=${JSON.stringify(counter)};let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
      const t=(p.match(/Your task id: (T\\d)/)||[])[1];
      const n = t==='T2' ? (fs.existsSync(c) ? 2 : (fs.writeFileSync(c,'1'), 1)) : 0;
      const files = t==='T1'
        ? { 'src/titleCase.js': "export function titleCase(text) { if (typeof text !== 'string') throw new TypeError('text'); return text.split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' '); }\\n",
            'test/titleCase.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { titleCase } from '../src/titleCase.js'; test('t', () => assert.equal(titleCase('hello wORLD'), 'Hello World'));\\n" }
        : { 'src/truncate.js': n===1 ? "export function truncate(text) { return text; }\\n" : "export function truncate(text, max) { if (!Number.isInteger(max) || max < 1) throw new RangeError('max'); return text.length > max ? text.slice(0, max - 1) + '…' : text; }\\n",
            'test/truncate.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { truncate } from '../src/truncate.js'; test('t', () => assert.equal(truncate('conductor', 5), 'cond…'));\\n" };
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(f, c);
      fs.writeFileSync(o, '## RESULT: DONE\\n## Files changed\\n' + Object.keys(files).map((f) => '- ' + f).join('\\n') + '\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 2. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 3. ok — evidence: ' + Object.keys(files)[0] + ':1\\n## Notes\\n- none\\n');});`,
  });
  const cfgFile = path.join(home, 'config.json');
  const saved = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, providers: { flaky: { type: 'cli', preset: 'codex', enabled: true, bin: 'flaky-worker' } }, roles: { build: ['flaky'] }, settings: { autoReview: false } }));
  try {
    const steps = [];
    const d = await runDemo({ provider: 'flaky', parent: tmpdir('conductor-demo-parent-'), say: (m) => steps.push(m) });
    assert.ok(steps.some((m) => /T2 didn't pass every check \(free models vary\): trying again, 1 of 2/.test(m)), steps.join('\n'));
    assert.deepEqual(d.batch.results.map((r) => [r.task, r.outcome]), [['T1', 'done'], ['T2', 'done']]);
    assert.equal(d.batch.results[1].retries, 1);
    assert.deepEqual([d.batch.ok, d.batch.failed, d.batch.exitCode], [2, 0, 0]);
    assert.deepEqual(d.merged, ['T1', 'T2']);
    assert.equal(d.verify.status, 'PASS');
  } finally { fs.writeFileSync(cfgFile, saved); }
});
