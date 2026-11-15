// S0/S1: priority and hedging. In a batch, once a task has finished, a task still running well past the others gets a
// second attempt on an idle route its priority allows; the first attempt that passes every check wins, the other is
// stopped and its worktree removed. `save` never hedges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins, tmpdir } from './helpers.js';

isolateHome();
const { clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { runBatch, formatBatch, hedgeAllowed } = await import('../src/batch.js');
const { listWorktrees } = await import('../src/worktree.js');

const task = (id) => `### ${id}: make ${id}
- **role:** build
- **files:** \`src/${id}.js\`
- **acceptance:**
  - [ ] \`src/${id}.js\` exists
`;
const PLAN = `# Plan\n## Open questions\n- [x] none\n## Tasks\n${task('T1')}\n${task('T2')}`;
// the worktree's folder names the task: T2 is slow in its own worktree (…/T2) and fast in the hedge's (…/T2-h); everything else is fast.
// HEDGE_LOG records each attempt that finished (a stopped one never does).
const worker = `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const w=require('path').basename(process.cwd());const id=w.replace(/-h$/,'');
  const slow=w==='T2';setTimeout(()=>{const o=args[args.indexOf('-o')+1];
  fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/'+id+'.js','export default 1;\\n');
  fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/'+id+'.js\\n## Checks run\\n- none\\n## Acceptance\\n- [x] 1. exists — evidence: src/'+id+'.js:1\\n');
  fs.appendFileSync(process.env.HEDGE_LOG,id+(slow?'-slow':'')+'\\n');},slow?(+process.env.SLOW_MS||20000):200);});`;
fakeBins({ 'h-a': worker, 'h-b': worker });
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
const cfgFor = (dir, settings = {}) => {
  const cfg = loadConfig(dir);
  cfg.providers = Object.fromEntries(['h-a', 'h-b'].map((b) => [b, { type: 'cli', preset: 'codex', enabled: true, bin: b, free: true }]));
  cfg.roles = { ...cfg.roles, build: ['h-a', 'h-b'] };
  cfg.settings = { ...cfg.settings, autoReview: false, verify: '', hedgeAfterSec: 0.5, hedgeCheckMs: 100, ...settings };
  return cfg;
};
const log = (name) => { process.env.HEDGE_LOG = path.join(tmpdir(), name); fs.writeFileSync(process.env.HEDGE_LOG, ''); };

test('hedging: a straggler gets a second attempt on the idle route; the first to pass wins and the other is stopped', async () => {
  clearCooldowns(); log('hedge1.log');
  const { dir } = repo();
  const t0 = Date.now();
  const b = await runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'], allowUnverified: true });
  const took = Date.now() - t0;
  const t2 = b.results.find((r) => r.task === 'T2');
  assert.ok(took < 15_000, `done in ${took} ms: did not wait for the 20 s attempt`);
  assert.ok(t2.summary.hedged, 'T2 was hedged');
  assert.equal(t2.summary.hedged.won, t2.summary.hedged.to, 'the hedge won');
  assert.notEqual(t2.summary.hedged.from, t2.summary.hedged.to);
  assert.match(formatBatch(b), /hedged: h-\w was slow, so h-\w \(after \d+ s\) also tried it; h-\w won/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.readFileSync(process.env.HEDGE_LOG, 'utf8').includes('T2-slow'), 'the slow attempt was stopped');
  assert.deepEqual(listWorktrees(dir).map((w) => w.id).sort(), ['T1', 'T2-h'], "the loser's worktree is gone");
});

test('priority save never hedges; the batch waits for the slow attempt', async () => {
  clearCooldowns(); log('hedge2.log');
  process.env.SLOW_MS = '2500';
  try {
    const { dir } = repo();
    const b = await runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'], allowUnverified: true, priority: 'save' });
    assert.ok(b.results.every((r) => !r.summary.hedged));
    assert.ok(fs.readFileSync(process.env.HEDGE_LOG, 'utf8').includes('T2-slow'));
  } finally { delete process.env.SLOW_MS; }
});

test('hedgeAllowed: by priority; never a paid route, manual, or the controller\'s own CLI', () => {
  const { dir } = repo();
  const cfg = cfgFor(dir);
  cfg.providers.sub = { type: 'cli', preset: 'codex', enabled: true, bin: 'h-a' }; // a subscription agent: no price, not free
  cfg.providers.paid = { type: 'cli', preset: 'codex', enabled: true, bin: 'h-a', price: { input: 1, output: 1 } };
  cfg.providers.man = { type: 'manual', enabled: true };
  assert.equal(hedgeAllowed(cfg, 'h-a', 'balanced'), true, 'free route under balanced');
  assert.equal(hedgeAllowed(cfg, 'sub', 'balanced'), false, 'subscription quota: only under speed');
  assert.equal(hedgeAllowed(cfg, 'sub', 'speed'), true);
  assert.equal(hedgeAllowed(cfg, 'h-a', 'save'), false);
  assert.equal(hedgeAllowed(cfg, 'paid', 'speed'), false);
  assert.equal(hedgeAllowed(cfg, 'man', 'speed'), false);
  cfg.controller = 'claude-code';
  cfg.providers['claude-cli'] = { type: 'cli', preset: 'claude', enabled: true, bin: 'h-a' };
  assert.equal(hedgeAllowed(cfg, 'claude-cli', 'speed'), false, "the controller's own CLI");
});

test('re-hedge: the first hedge takes the only idle route; a route expected to be much faster that frees up later gets one more, and wins', async () => {
  clearCooldowns(); log('hedge3.log');
  const { USAGE_FILE } = await import('../src/usage.js');
  // history: rh-c is fast (5 s), rh-a and rh-b slow (100 s)
  const hist = (p, sec) => Array.from({ length: 3 }, () => JSON.stringify({ ts: new Date().toISOString(), provider: p, role: 'build', ok: true, seconds: sec })).join('\n');
  fs.mkdirSync(path.dirname(USAGE_FILE()), { recursive: true });
  fs.writeFileSync(USAGE_FILE(), [hist('rh-a', 100), hist('rh-b', 100), hist('rh-c', 5)].join('\n') + '\n');
  // the worktree folder names the attempt: T2 and T2-h are slow, T2-h2 fast; T3 takes 1.5 s; T1 0.2 s
  const w = `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const f=require('path').basename(process.cwd());const id=f.replace(/-h\\d*$/,'');
    const ms={T2:20000,'T2-h':20000,T3:1500}[f]||200;setTimeout(()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('src',{recursive:true});
    fs.writeFileSync('src/'+id+'.js','export default 1;\\n');fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/'+id+'.js\\n## Checks run\\n- none\\n## Acceptance\\n- [x] 1. exists — evidence: src/'+id+'.js:1\\n');
    fs.appendFileSync(process.env.HEDGE_LOG,f+'\\n');},ms);});`;
  fakeBins({ 'rh-a': w, 'rh-b': w, 'rh-c': w });
  const pin = (id, p) => task(id).replace('- **role:** build', `- **role:** build\n- **provider:** ${p}`);
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': `# Plan\n## Open questions\n- [x] none\n## Tasks\n${pin('T1', 'rh-a')}\n${pin('T2', 'rh-b')}\n${pin('T3', 'rh-c')}`, 'src/.keep': '' } });
  const cfg = loadConfig(dir);
  cfg.providers = Object.fromEntries(['rh-a', 'rh-b', 'rh-c'].map((b) => [b, { type: 'cli', preset: 'codex', enabled: true, bin: b, free: true }]));
  cfg.roles = { ...cfg.roles, build: ['rh-a', 'rh-b', 'rh-c'] };
  cfg.settings = { ...cfg.settings, autoReview: false, verify: '', hedgeAfterSec: 0.5, hedgeCheckMs: 100 };
  const t0 = Date.now();
  const b = await runBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2', 'T3'], allowUnverified: true });
  const h = b.results.find((r) => r.task === 'T2').summary.hedged;
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms; hedged: ${JSON.stringify(h)}; log: ${fs.readFileSync(process.env.HEDGE_LOG, 'utf8').replace(/\s+/g, ' ')}`);
  assert.deepEqual(h.tries.map((x) => x.provider), ['rh-a', 'rh-c'], 'first the idle route, then the fast one once it was free');
  assert.equal(h.won, 'rh-c');
  assert.match(formatBatch(b), /hedged: rh-b was slow, so rh-a \(after \d+ s\), then rh-c \(after \d+ s\) also tried it; rh-c won/);
  assert.deepEqual(listWorktrees(dir).map((x) => x.id).sort(), ['T1', 'T2-h2', 'T3']);
  fs.rmSync(USAGE_FILE(), { force: true });
});
