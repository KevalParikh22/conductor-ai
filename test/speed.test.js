// Speed-aware routing: measured run times decide the order for small tasks, and batch spreads a wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';

const home = isolateHome();
const { speedStats, smartOrder } = await import('../src/selector.js');
const { spreadChains } = await import('../src/batch.js');
const { loadConfig } = await import('../src/config.js');

const usage = (rows) => fs.writeFileSync(path.join(home, 'usage.jsonl'), rows.map(([provider, ok, seconds, role = 'build', reason = ok ? 'ok' : 'exit 1']) => JSON.stringify({ ts: new Date().toISOString(), provider, ok, seconds, role, reason, kind: 'agent' })).join('\n') + '\n');
const agent = (name) => ({ name, p: { type: 'cli', enabled: true, bin: name } });

test('speed stats: median of successful runs, success rate, rate limits ignored', () => {
  usage([['slow', true, 200], ['slow', true, 180], ['slow', true, 300], ['fast', true, 30], ['fast', true, 40], ['fast', false, 5], ['fast', false, 2, 'build', 'quota'], ['few', true, 1]]);
  const s = speedStats(['slow', 'fast', 'few'], 'build');
  assert.deepEqual(s.slow, { n: 3, okRate: 1, median: 200 });
  assert.equal(s.fast.n, 3, 'the quota failure is not counted');
  assert.equal(s.fast.median, 40);
  assert.equal(s.few, undefined, 'too few runs to judge');
});

test('small tasks go to the fast, reliable provider first; big tasks keep your order', () => {
  usage([['slow', true, 200], ['slow', true, 190], ['slow', true, 210], ['fast', true, 35], ['fast', true, 30], ['fast', true, 40], ['flaky', true, 5], ['flaky', false, 3], ['flaky', false, 3]]);
  const entries = [agent('slow'), agent('flaky'), agent('fast')];
  const small = smartOrder(entries, { role: 'build', mode: 'write', body: 'x', files: ['src/a.js'] });
  assert.deepEqual(small.chain.map((e) => e.name), ['fast', 'slow', 'flaky'], 'flaky is fast but fails: not first');
  assert.match(small.note, /fastest reliable first: fast ~35s, slow ~200s/);
  const big = smartOrder(entries, { role: 'build', mode: 'write', body: 'x', files: ['a.js', 'b.js', 'c.js'] });
  assert.deepEqual(big.chain.map((e) => e.name), ['slow', 'flaky', 'fast']);
});

test('batch: each task goes where it should finish soonest, at most 2 per provider; unknown providers spread evenly', () => {
  usage([['slow', true, 200], ['slow', true, 190], ['slow', true, 210], ['fast', true, 35], ['fast', true, 30], ['fast', true, 40]]);
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers = { slow: { type: 'cli', enabled: true, bin: 'node' }, fast: { type: 'cli', enabled: true, bin: 'node' }, a: { type: 'cli', enabled: true, bin: 'node' }, b: { type: 'cli', enabled: true, bin: 'node' } };
  const items = ['T1', 'T2', 'T3', 'T4'].map((id) => ({ id, role: 'build', files: ['src/x.js'], section: `### ${id}: x\n- **files:** \`src/x.js\`` }));
  cfg.roles = { ...cfg.roles, build: ['slow', 'fast'] };
  assert.deepEqual(spreadChains(cfg, items).map((t) => t.chain[0]), ['fast', 'fast', 'slow', 'slow'], 'the fast one takes two, the cap sends the rest on');
  cfg.settings = { ...cfg.settings, maxParallelPerProvider: 4 };
  assert.deepEqual(spreadChains(cfg, items).map((t) => t.chain[0]), ['fast', 'fast', 'fast', 'fast'], 'with room, the fast one takes them all (35s ×2.5 still beats 200s)');
  cfg.roles = { ...cfg.roles, build: ['a', 'b'] };
  cfg.settings = { ...cfg.settings, maxParallelPerProvider: 2 };
  assert.deepEqual(spreadChains(cfg, items).map((t) => t.chain[0]), ['a', 'b', 'a', 'b'], 'no history: an even spread');
});
