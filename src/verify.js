import fs from 'node:fs';
import path from 'node:path';
import { run, which, SECRET_VARS } from './util.js';

/** Priority: settings.verify > the "Verify" line in AGENTS.md > auto-detect from project files. */
export function detectVerify(root, settings = {}) {
  if (settings.verify) return settings.verify;
  try {
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const m = agents.match(/^\s*-\s*\*\*Verify[^\n]*?`([^`]+)`/m);
    if (m && !m[1].trim().startsWith('<')) return m[1].trim();
  } catch { /* no AGENTS.md */ }

  const has = (f) => fs.existsSync(path.join(root, f));
  const cmds = [];
  if (has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch { /* bad json */ }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
    for (const s of ['lint', 'typecheck', 'test']) {
      if (scripts[s] && !/no test specified/.test(scripts[s])) cmds.push(`${pm} run ${s}`);
    }
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg') || has('pytest.ini')) {
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
    const pyproject = read('pyproject.toml');
    // the project's own venv first (where its tools really are), then PATH
    const venv = ['.venv', 'venv'].find((v) => has(`${v}/bin/python`) || has(`${v}/Scripts/python.exe`));
    const tool = (name) => (venv && (has(`${venv}/bin/${name}`) || has(`${venv}/Scripts/${name}.exe`)) ? `${venv}/bin/${name}` : which(name) ? name : null);
    const ruffConfigured = /^\[tool\.ruff/m.test(pyproject) || has('ruff.toml') || has('.ruff.toml');
    const ruff = tool('ruff');
    if (ruff && (ruffConfigured || ruff === 'ruff')) cmds.push(`${ruff} check .`);
    // pytest configured, or a tests folder: run it even when pytest isn't on PATH (python -m pytest)
    const pytestConfigured = /^\[tool\.pytest/m.test(pyproject) || has('pytest.ini') || has('conftest.py') || /\[tool:pytest\]/.test(read('setup.cfg')) || /\[pytest\]/.test(read('tox.ini'))
      || (has('tests') && fs.readdirSync(path.join(root, 'tests')).some((f) => /^test_.*\.py$|_test\.py$/.test(f)));
    const pytest = tool('pytest');
    if (pytest) cmds.push(`${pytest} -q`);
    else if (pytestConfigured) cmds.push(`${venv ? `${venv}/bin/python` : 'python3'} -m pytest -q`);
  }
  if (has('composer.json')) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8')).scripts || {}; } catch { /* bad json */ }
    if (scripts.test) cmds.push('composer test');
    else if (has('phpunit.xml') || has('phpunit.xml.dist')) cmds.push('vendor/bin/phpunit');
  }
  if (has('Cargo.toml')) cmds.push('cargo test');
  if (has('go.mod')) cmds.push('go test ./...');
  if (!cmds.length && has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) cmds.push('make test');
  return cmds.join(' && ');
}

export async function runVerify(root, settings, logFile) {
  const cmd = detectVerify(root, settings);
  if (!cmd) return { status: 'SKIPPED', cmd: '', note: 'no verify command: set it in AGENTS.md or conductor settings' };
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
  // verify runs code the worker may have written: it gets your environment minus conductor's API keys
  const env = { ...process.env };
  for (const k of SECRET_VARS) delete env[k];
  delete env.NODE_TEST_CONTEXT; // set when conductor itself runs under node --test: the project's tests would report to it
  const r = await run(shell, args, { cwd: root, env, timeoutMs: (settings.timeoutSec || 1200) * 1000 });
  if (logFile) fs.writeFileSync(logFile, `$ ${cmd}\n--- exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  return { status: r.code === 0 ? 'PASS' : 'FAIL', cmd, log: logFile, tail: (r.stdout + r.stderr).split('\n').slice(-25).join('\n') };
}
