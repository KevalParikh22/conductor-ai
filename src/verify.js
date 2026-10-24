import fs from 'node:fs';
import path from 'node:path';
import { run, which } from './util.js';

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
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    if (which('ruff')) cmds.push('ruff check .');
    if (which('pytest')) cmds.push('pytest -q');
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
  const r = await run(shell, args, { cwd: root, timeoutMs: (settings.timeoutSec || 1200) * 1000 });
  if (logFile) fs.writeFileSync(logFile, `$ ${cmd}\n--- exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  return { status: r.code === 0 ? 'PASS' : 'FAIL', cmd, log: logFile, tail: (r.stdout + r.stderr).split('\n').slice(-25).join('\n') };
}
