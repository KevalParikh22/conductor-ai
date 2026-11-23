import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_ROOT = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const GLOBAL_DIR = process.env.CONDUCTOR_HOME || path.join(CONFIG_ROOT, 'conductor-ai');
// shortcut: one-time move of the pre-rename folder ~/.config/conductor; drop this once nobody has the old name
// Other tools are called "conductor" too (the reason for the rename), so ~/.config/conductor moves only when it holds
// our own files: a config.json shaped like ours, or our secrets.env.
export function isOurOldDir(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'secrets.env'))) return true;
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return c !== null && typeof c === 'object' && typeof c.version === 'number' && ['providers', 'roles', 'settings', 'controller', 'routes'].some((k) => k in c);
  } catch { return false; }
}
if (!process.env.CONDUCTOR_HOME) {
  const old = path.join(CONFIG_ROOT, 'conductor');
  try { if (!fs.existsSync(GLOBAL_DIR) && isOurOldDir(old)) fs.renameSync(old, GLOBAL_DIR); } catch { /* keep going without the old settings */ }
}

/** Marker lines older versions wrote into user files (.gitignore, AGENTS.md, CLAUDE.md, .git/info/exclude), in the new spelling. */
export const legacyMarkers = (t) => t
  .replace(/<!-- conductor:/g, '<!-- conductor-ai:')
  .replace('# >>> conductor: local files, not committed (conductor init --share', '# >>> conductor-ai: local files, not committed (conductor-ai init --share')
  .replace('# <<< conductor\n', '# <<< conductor-ai\n')
  .replace('# >>> conductor skills', '# >>> conductor-ai skills').replace('# <<< conductor skills', '# <<< conductor-ai skills');

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

/** What changed from base to eff: changed leaves only; an array counts as one value. */
export function deepDiff(base, eff) {
  const out = {};
  for (const [k, v] of Object.entries(eff || {})) {
    const b = base?.[k];
    if (isPlainObject(v) && isPlainObject(b)) { const d = deepDiff(b, v); if (Object.keys(d).length) out[k] = d; }
    else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
  }
  return out;
}

/** Names of the variables conductor-ai loaded from its secret files (kept away from CLI workers). */
export const SECRET_VARS = new Set();

/** Parse a KEY=VALUE env file. Does not override variables already set, but every key in it counts as a secret. */
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
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    SECRET_VARS.add(m[1]); // also when the shell exports it too: it is still one of conductor-ai's keys
  }
  return vars;
}

/**
 * The environment for commands that run project code (verify, plan repro commands, acceptance checks): yours, minus
 * conductor-ai's keys. NODE_TEST_CONTEXT is set when conductor-ai itself runs under node --test.
 */
export function codeEnv() {
  const env = { ...process.env };
  for (const k of SECRET_VARS) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return env;
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

// Windows (cross-spawn's rules): cmd.exe metacharacters, escaped with ^ when a command has to go through cmd.exe
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = (a) => `"${String(a).replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`.replace(CMD_META, '^$1');

/**
 * Windows: how to start `cmd`. Node can't start a .cmd or .bat file directly, and npm installs CLIs (Codex, OpenCode,
 * Copilot…) as .cmd shims. An npm shim runs its script with node directly, so prompt text in the arguments never
 * passes through cmd.exe; any other .cmd/.bat goes through cmd.exe with every argument escaped. → { file, args, opts }
 */
export function winCommand(cmd, args) {
  const full = which(cmd) || cmd;
  if (!/\.(cmd|bat)$/i.test(full)) return { file: full, args, opts: {} };
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch { /* not readable: use cmd.exe */ }
  const m = text.match(/(?:node(?:\.exe)?"?|%_prog%"?)\s+"%~?dp0%?\\([^"]+)"\s+%\*/i);
  if (m) return { file: process.execPath, args: [path.join(path.dirname(full), m[1]), ...args], opts: {} };
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${full.replace(CMD_META, '^$1')} ${args.map(cmdArg).join(' ')}"`], opts: { windowsVerbatimArguments: true } };
}

/**
 * A shell command line (verify, repro): bash -c on macOS and Linux; on Windows cmd.exe /d /s /c "<line>", passed as
 * written. Node's own quoting turns the line's quotes into \" (which cmd.exe doesn't read), so node -e "…" failed.
 */
export function runShell(line, opts = {}) {
  if (process.platform !== 'win32') return run('bash', ['-c', line], opts);
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, verbatim: true });
}

// Worker processes still running: killed with their whole process group if conductor-ai itself is stopped.
const live = new Set();
function onSignal(sig) {
  for (const k of live) k('SIGKILL');
  process.exit(sig === 'SIGINT' ? 130 : 143);
}
function track(kill) {
  if (!live.size) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
  live.add(kill);
}
function untrack(kill) {
  live.delete(kill);
  if (!live.size) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}

/**
 * Run a process. Never throws for non-zero exits.
 * On POSIX it runs in its own process group, so a timeout stops the helpers it started too: an agent's child
 * processes can hold its output pipes open, and killing only the agent would leave conductor-ai waiting forever.
 * idleTimeoutMs stops it when it prints nothing for that long.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, idle?:boolean, error?:string}>}
 */
export function run(cmd, args, { cwd, input, timeoutMs = 0, idleTimeoutMs = 0, env, onData, signal, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let child;
    const group = process.platform !== 'win32';
    try {
      const w = process.platform === 'win32' && !verbatim ? winCommand(cmd, args) : { file: cmd, args, opts: verbatim ? { windowsVerbatimArguments: true } : {} };
      child = spawn(w.file, w.args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: group, ...w.opts });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), timedOut: false, error: String(e) });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, idle = false, cancelled = false, done = false, killer, idler, last;
    const killTree = (sig) => {
      if (!child.pid) return;
      if (group) { try { process.kill(-child.pid, sig); return; } catch { /* group gone: fall through */ } }
      else if (sig === 'SIGKILL') { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ } }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(killer); clearTimeout(idler); clearTimeout(last);
      untrack(killTree);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(cancelled ? { ...r, cancelled: true } : r);
    };
    const stop = (why) => {
      if (timedOut) return;
      timedOut = true; idle = why === 'idle';
      killTree('SIGTERM');
      setTimeout(() => {
        killTree('SIGKILL');
        // a grandchild in another group can still hold the pipes: give up waiting for them
        last = setTimeout(() => finish({ code: null, stdout, stderr, timedOut, idle }), 5_000);
        last.unref?.();
      }, 10_000).unref();
    };
    const poke = () => {
      if (!idleTimeoutMs) return;
      clearTimeout(idler);
      idler = setTimeout(() => stop('idle'), idleTimeoutMs);
    };
    // V9: a race that another attempt won stops this one (the whole process group, like a timeout)
    function onAbort() { cancelled = true; stop('cancel'); }
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    track(killTree);
    poke();
    child.stdout.on('data', (d) => { stdout += d; poke(); onData?.(d); });
    child.stderr.on('data', (d) => { stderr += d; poke(); onData?.(d); });
    if (timeoutMs > 0) killer = setTimeout(() => stop('timeout'), timeoutMs);
    child.on('error', (e) => finish({ code: null, stdout, stderr: stderr + String(e), timedOut, idle, error: String(e) }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, idle }));
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A path relative to root, with / on every OS (Windows file APIs and git accept it; output and tests read the same). */
export function rel(root, p) { return path.relative(root, p).split(path.sep).join('/') || '.'; }

// "YOUR_API_KEY", "<key>", "sk-xxxx", "changeme"…: copied examples, not keys
const PLACEHOLDER_KEY = /^(your[_-]|<.*>$|sk-x{3,}$|x{4,}$|changeme$|todo$|placeholder|replace[_-]?me)/i;
export const isPlaceholderKey = (v) => !v || !String(v).trim() || PLACEHOLDER_KEY.test(String(v).trim());
/** An env var's value when it holds a real-looking key, else ''. */
export const keyValue = (name) => (name && !isPlaceholderKey(process.env[name]) ? process.env[name] : '');

/** "14:05:00" for a time today, "Wed 18 Nov 14:05" for a later day (a weekly quota can reset days away). */
export function untilText(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString();
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Fit text to a terminal `width`: a long line wraps at word boundaries, and its continuation lines start under the
 * line's text column (after the first run of 2+ spaces in the first half: the description in help, the notes in a
 * table), so columns stay readable on an 80-column terminal. Shorter lines are untouched.
 */
export function wrapForTerminal(text, width) {
  if (!(width > 20)) return text;
  return String(text).split('\n').map((raw) => {
    if ([...raw].length <= width) return raw;
    const line = raw.trimEnd(); // trailing spaces alone would wrap into an empty line
    if ([...line].length <= width) return line;
    const lead = (line.match(/^\s*/) || [''])[0].length;
    let indent = lead;
    const gaps = [...line.matchAll(/\S( {2,})(?=\S)/g)].map((m) => m.index + 1 + m[1].length).filter((i) => i <= width / 2);
    if (gaps.length) indent = gaps.at(-1);
    if (indent > width / 2) indent = lead + 2;
    const out = [];
    let cur = line;
    while ([...cur].length > width) {
      let cut = cur.lastIndexOf(' ', width);
      if (cut <= indent) cut = width; // one long word (a path): cut it
      out.push(cur.slice(0, cut).trimEnd());
      cur = ' '.repeat(indent) + cur.slice(cut).trimStart();
    }
    out.push(cur);
    return out.join('\n');
  }).join('\n');
}

/** Put text on the clipboard if this machine has a way to (wl-copy, xclip, xsel, pbcopy, clip.exe). → the tool used, or null */
export function copyToClipboard(text) {
  const tools = [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['pbcopy', []], ['clip.exe', []], ['clip', []]];
  for (const [bin, args] of tools) {
    if (!which(bin)) continue;
    try { execFileSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }); return bin; } catch { /* try the next */ }
  }
  return null;
}
