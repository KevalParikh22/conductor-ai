import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GLOBAL_DIR = process.env.CONDUCTOR_HOME
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'conductor');

export function readJSON(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
}

export function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Deep merge for config objects. Arrays are replaced, not concatenated. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) ? deepMerge(out[k], v) : v;
  return out;
}

/** Names of the variables conductor loaded from its secret files (kept away from CLI workers). */
export const SECRET_VARS = new Set();

/** Parse a KEY=VALUE env file. Does not override variables already set. */
export function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    vars[m[1]] = v;
    if (process.env[m[1]] === undefined) { process.env[m[1]] = v; SECRET_VARS.add(m[1]); }
  }
  return vars;
}

export function which(bin) {
  if (!bin) return null;
  if (bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Run a process. Never throws for non-zero exits.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, error?:string}>}
 */
export function run(cmd, args, { cwd, input, timeoutMs = 0, env, onData } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), timedOut: false, error: String(e) });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, killer;
    child.stdout.on('data', (d) => { stdout += d; onData?.(d); });
    child.stderr.on('data', (d) => { stderr += d; onData?.(d); });
    if (timeoutMs > 0) {
      killer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }, timeoutMs);
    }
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, stdout, stderr: stderr + String(e), timedOut, error: String(e) }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function rel(root, p) { return path.relative(root, p) || '.'; }
