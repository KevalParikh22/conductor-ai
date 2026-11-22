// The rename moves ~/.config/conductor to ~/.config/conductor-ai, but only when the folder is ours: other tools are
// called "conductor" too, and their settings must stay where they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, tmpdir } from './helpers.js';

isolateHome();
const { isOurOldDir } = await import('../src/util.js');

test('only our own old folder counts: our config.json or secrets.env, not another tool\'s files', () => {
  const mk = (files) => { const d = tmpdir('conductor-old-'); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d; };
  assert.equal(isOurOldDir(mk({ 'config.json': JSON.stringify({ version: 1, settings: { timeoutSec: 600 } }) })), true);
  assert.equal(isOurOldDir(mk({ 'secrets.env': 'X=1\n' })), true);
  assert.equal(isOurOldDir(mk({ 'config.json': JSON.stringify({ server: 'http://localhost:8080', apiKey: 'x' }) })), false, 'another tool\'s config');
  assert.equal(isOurOldDir(mk({ 'settings.yaml': 'a: 1' })), false);
  assert.equal(isOurOldDir(mk({ 'config.json': 'not json' })), false);
  assert.equal(isOurOldDir(path.join(tmpdir('conductor-old-'), 'missing')), false);
});
