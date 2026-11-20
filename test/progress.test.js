// CLI live progress: a status line for a run and a live table for a batch on a terminal; the plain lines when piped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runProgress, batchProgress, clock } = await import('../src/progress.js');
const stream = (tty) => { const s = { isTTY: tty, columns: 100, out: '', write(x) { s.out += x; } }; return s; };
const plain = (t) => t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('clock reads minutes and seconds', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65_400), '1:05');
  assert.equal(clock(20 * 60_000), '20:00');
});

test('a run on a terminal: event lines as before, plus one status line with the step and the time against the limit', () => {
  const s = stream(true); let t = 1000;
  const p = runProgress({ stream: s, now: () => t });
  p.line('trying codex-cli (agent)…');
  p.step({ type: 'try', provider: 'codex-cli', limitMs: 20 * 60_000 });
  t += 42_000; p.step({ type: 'unknown' });
  p.line('codex-cli finished');
  p.step({ type: 'verify' });
  p.stop();
  const out = plain(s.out);
  assert.match(out, /conductor-ai: trying codex-cli \(agent\)…\n/);
  assert.match(out, /codex-cli is working · 0:00 of 20:00/);
  assert.match(out, /conductor-ai: codex-cli finished\n/);
  assert.match(out, /running verify · 0:00/);
  assert.ok(s.out.endsWith('\r\x1b[2K'), 'the status line is cleared at the end');
});

test('a run when piped: only the plain lines, nothing redrawn', () => {
  const s = stream(false);
  const p = runProgress({ stream: s });
  p.line('trying good (agent)…');
  p.line('good finished', 'attempt 2');
  p.step({ type: 'try', provider: 'good', limitMs: 1000 });
  p.stop();
  assert.equal(s.out, 'conductor-ai: trying good (agent)…\nconductor-ai [attempt 2]: good finished\n');
});

test('a batch on a terminal: one row per task, redrawn in place, with worker, state and time', () => {
  const s = stream(true); let t = 0;
  const b = batchProgress(['T1', 'T2'], { stream: s, now: () => t });
  b.event({ task: 'T1', type: 'try', provider: 'opencode', limitMs: 600_000 });
  t = 30_000; b.event({ task: 'T2', type: 'try', provider: 'kilo-free' });
  t = 45_000; b.event({ task: 'T1', type: 'done', outcome: 'done' });
  b.event({ task: 'T2', type: 'fail', provider: 'kilo-free', reason: 'quota' });
  b.stop();
  const last = plain(s.out.split('\x1b[2F').at(-1)).trim().split('\n');
  assert.equal(last.length, 2);
  assert.match(last[0], /^✓ T1 +done +opencode +0:45$/);
  assert.match(last[1], /^. T2 +kilo-free failed: quota +kilo-free +0:15$/);
  assert.ok(s.out.includes('\x1b[2F'), 'the table moves the cursor up to redraw');
});

test('a batch when piped: the plain lines batch always printed', () => {
  const s = stream(false);
  const b = batchProgress(['T1'], { stream: s });
  b.event({ task: 'T1', type: 'start', provider: 'good' });
  b.event({ task: 'T1', type: 'try', provider: 'good' });
  b.event({ task: 'T1', type: 'done', outcome: 'done' });
  b.stop();
  assert.equal(s.out, 'conductor-ai [T1]: starting (first choice: good)\nconductor-ai [T1]: trying good…\nconductor-ai [T1]: done\n');
});

test('a batch race: the row names the worker that won, not the one that started last, and ignores the loser', () => {
  const s = stream(true); let t = 0;
  const b = batchProgress(['T1'], { stream: s, now: () => t });
  b.event({ task: 'T1', type: 'start', provider: 'codex-cli' });
  b.event({ task: 'T1', type: 'try', provider: 'codex-cli', sample: 1 });
  b.event({ task: 'T1', type: 'try', provider: 'antigravity-cli', sample: 2 });
  const racing = plain(s.out.split('\x1b[1F').at(-1)).trim();
  assert.match(racing, /2 workers racing +racing \(2\)/);
  t = 30_000; b.event({ task: 'T1', type: 'verify', sample: 1 });
  b.event({ task: 'T1', type: 'race-won', provider: 'codex-cli', sample: 1 });
  b.event({ task: 'T1', type: 'fail', provider: 'antigravity-cli', reason: 'cancelled', sample: 2 }); // the loser, stopped
  b.event({ task: 'T1', type: 'merge', branch: 'conductor-ai/T1-s1' });
  b.event({ task: 'T1', type: 'verify' });
  t = 34_000; b.event({ task: 'T1', type: 'done', outcome: 'done' });
  b.stop();
  const out = plain(s.out);
  assert.ok(!/merging conductor-ai\/T1-s1 +antigravity-cli/.test(out), 'never shows the loser while merging');
  assert.match(out, /merging conductor-ai\/T1-s1 +codex-cli/);
  assert.match(plain(s.out.split('\x1b[1F').at(-1)).trim(), /^✓ T1 +done +codex-cli +0:34$/);
  assert.ok(!out.includes('antigravity-cli failed'), "the loser's cancel isn't shown as a failure");
});

test('a batch hedge: the slow attempt stopping reads as stopped, and the row ends on the winner', () => {
  const s = stream(true); let t = 0;
  const b = batchProgress(['T2'], { stream: s, now: () => t });
  b.event({ task: 'T2', type: 'try', provider: 'antigravity-cli' });
  t = 46_000; b.event({ task: 'T2', type: 'hedge', provider: 'nvidia-nim', from: 'antigravity-cli' });
  b.event({ task: 'T2', type: 'try', provider: 'nvidia-nim' });
  t = 80_000; b.event({ task: 'T2', type: 'ok', provider: 'nvidia-nim' });
  b.event({ task: 'T2', type: 'fail', provider: 'antigravity-cli', reason: 'cancelled' });
  let row = plain(s.out.split('\x1b[1F').at(-1)).trim();
  assert.match(row, /antigravity-cli stopped: other won +nvidia-nim/);
  b.event({ task: 'T2', type: 'hedge-won', provider: 'nvidia-nim' });
  b.event({ task: 'T2', type: 'done', outcome: 'done' });
  b.stop();
  row = plain(s.out.split('\x1b[1F').at(-1)).trim();
  assert.match(row, /^✓ T2 +done +nvidia-nim +1:20$/);
});

test('a batch row after a failure names the provider that took over', () => {
  const s = stream(true);
  const b = batchProgress(['T3'], { stream: s, now: () => 0 });
  b.event({ task: 'T3', type: 'try', provider: 'kilo-free' });
  b.event({ task: 'T3', type: 'fail', provider: 'kilo-free', reason: 'quota' });
  b.event({ task: 'T3', type: 'try', provider: 'opencode' });
  b.stop();
  assert.match(plain(s.out.split('\x1b[1F').at(-1)).trim(), /opencode is working +opencode/);
});
