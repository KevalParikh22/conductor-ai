// The name-clash safeguards for the alpha: a second command name, and doctor noticing another program's `conductor`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';

const { conductorCommandCheck } = await import('../src/doctor.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OWN = new URL('../bin/conductor.js', import.meta.url).pathname;

test('both command names run the same program', () => {
  assert.deepEqual(pkg.bin, { conductor: 'bin/conductor.js', 'conductor-ai': 'bin/conductor.js' });
});

test('doctor knows whether `conductor` on PATH is this program or another tool\'s', () => {
  const PATH = process.env.PATH;
  const dir = tmpdir('conductor-path-');
  try {
    process.env.PATH = dir;
    assert.deepEqual(conductorCommandCheck(OWN), { missing: true });
    fs.symlinkSync(OWN, path.join(dir, 'conductor')); // npm's global link to us
    assert.deepEqual(conductorCommandCheck(OWN), { ok: true });
    fs.rmSync(path.join(dir, 'conductor'));
    fs.writeFileSync(path.join(dir, 'conductor'), '#!/usr/bin/env node\n// Conductor OSS CLI\n'); fs.chmodSync(path.join(dir, 'conductor'), 0o755);
    const r = conductorCommandCheck(OWN);
    assert.equal(r.ok, false);
    assert.match(r.problem, /is another program/);
    assert.match(r.fix, /conductor-ai/);
  } finally { process.env.PATH = PATH; }
});
