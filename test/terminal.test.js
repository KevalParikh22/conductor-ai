// UX checklist: output on an 80-column terminal stays readable; piped output and --json are unchanged; typos get a
// suggestion (also for the newer commands, and both sides of a tie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isolateHome } from './helpers.js';

const home = isolateHome();
const { wrapForTerminal } = await import('../src/util.js');
const BIN = new URL('../bin/conductor.js', import.meta.url).pathname;
const cli = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, CONDUCTOR_HOME: home, NO_COLOR: '1', COLUMNS: '', ...env } });
const longest = (text) => Math.max(...text.split('\n').map((l) => [...l].length));

test('wrapping: at words, continuing under the text column; short lines, trailing spaces and long words handled', () => {
  const line = '  conductor setup                 guided setup: finds your agents and keys, adds a free provider';
  assert.equal(wrapForTerminal(line, 80), '  conductor setup                 guided setup: finds your agents and keys, adds\n                                  a free provider');
  assert.equal(wrapForTerminal('short', 80), 'short');
  assert.equal(wrapForTerminal('a    \nb', 80), 'a    \nb', 'a short line keeps its spaces');
  assert.equal(longest(wrapForTerminal(`path: ${'x'.repeat(200)}`, 80)), 80, 'a word longer than the line is cut');
  assert.equal(wrapForTerminal(line, 0), line, 'no width: unchanged');
});

test('on an 80-column terminal no line of help, help all or status is wider; piped output and --json are untouched', () => {
  for (const args of [['help'], ['help', 'all'], ['status'], ['providers']]) {
    const r = cli(args, { COLUMNS: '80' });
    assert.ok(longest(r.stdout) <= 80, `${args.join(' ')}: ${longest(r.stdout)} columns`);
  }
  assert.ok(longest(cli(['help']).stdout) > 80, 'piped: the original long lines');
  const j = cli(['status', '--json'], { COLUMNS: '40' });
  assert.doesNotThrow(() => JSON.parse(j.stdout), '--json is never wrapped');
});

test('typos: the newer commands are suggested, a tie names both, a swapped pair of letters counts as one edit', () => {
  const guess = (w) => cli([w]).stderr.split('\n')[0];
  assert.match(guess('lesons'), /Did you mean: conductor lessons\?/);
  assert.match(guess('gaurd'), /Did you mean: conductor guard\?/);
  assert.match(guess('runz'), /Did you mean: conductor run or conductor runs\?/);
  assert.match(guess('stauts'), /conductor status/);
  assert.equal(cli(['xyzzy']).status, 2);
});
