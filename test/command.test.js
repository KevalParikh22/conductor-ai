// The name-clash safeguards for the alpha: a second command name, and doctor noticing another program's `conductor`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';
import { fileURLToPath } from 'node:url';

const { conductorCommandCheck } = await import('../src/doctor.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OWN = fileURLToPath(new URL('../bin/conductor.js', import.meta.url));

test('conductor-ai is the only command name', () => {
  assert.deepEqual(pkg.bin, { 'conductor-ai': 'bin/conductor.js' });
});

test('doctor knows whether `conductor` on PATH is this program or another tool\'s', () => {
  const PATH = process.env.PATH;
  const dir = tmpdir('conductor-path-');
  try {
    process.env.PATH = dir;
    assert.deepEqual(conductorCommandCheck(OWN), { missing: true });
    // npm's global link to us: a symlink, or on Windows a .cmd shim that names the package
    const win = process.platform === 'win32', cmd = path.join(dir, win ? 'conductor.cmd' : 'conductor');
    if (win) fs.writeFileSync(cmd, '@node "%~dp0\\node_modules\\conductor-ai\\bin\\conductor.js" %*\r\n'); else fs.symlinkSync(OWN, cmd);
    assert.deepEqual(conductorCommandCheck(OWN), { ok: true });
    fs.rmSync(cmd);
    fs.writeFileSync(cmd, win ? '@node "%~dp0\\node_modules\\@conductor-oss\\cli\\index.js" %*\r\n' : '#!/usr/bin/env node\n// Conductor OSS CLI\n'); fs.chmodSync(cmd, 0o755);
    const r = conductorCommandCheck(OWN);
    assert.equal(r.ok, false);
    assert.match(r.problem, /is another program/);
    assert.match(r.fix, /conductor-ai/);
  } finally { process.env.PATH = PATH; }
});
