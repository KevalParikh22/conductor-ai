// One command name: conductor-ai (the short `conductor` name belongs to other tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('conductor-ai is the only command name', () => {
  assert.deepEqual(pkg.bin, { 'conductor-ai': 'bin/conductor-ai.js' });
});
