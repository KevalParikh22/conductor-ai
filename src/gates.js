// Checks conductor enforces around a write task (by code, not by asking the model):
//   base check (H4): run verify on the starting commit first, so failures that were already there aren't blamed on
//                    the worker. Cached per commit + command; parallel tasks on the same commit share one run.
//   scope gate (Q5): files the worker changed that the task doesn't list.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as git from './git.js';
import { detectVerify, runVerify } from './verify.js';
import { globToRegex } from './routing.js';
import { PROJECT_DIRNAME } from './config.js';

const CACHE_MAX = 30;
const inFlight = new Map(); // key → promise (batch: several worktrees on the same commit)

// in runs/, which git always ignores (runs/.gitignore = "*"): the cache itself must never make the tree look changed
const cacheFile = (root) => path.join(root, PROJECT_DIRNAME, 'runs', 'base-verify.json');
function readCache(root) { try { return JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')); } catch { return {}; } }
function writeCache(root, data) {
  const keep = Object.entries(data).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, CACHE_MAX);
  const dir = path.dirname(cacheFile(root));
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  fs.writeFileSync(cacheFile(root), JSON.stringify(Object.fromEntries(keep), null, 2));
}

/**
 * Verify on the starting commit, before the worker changes anything. Returns null when there is no verify command.
 * A tree with uncommitted changes (--allow-dirty) isn't the commit, so it is checked but not cached.
 */
export async function baseVerify(root, work, settings, logFile) {
  const cmd = detectVerify(work, settings);
  if (!cmd) return null;
  const head = git.head(work);
  const dirty = git.isDirty(work);
  const key = crypto.createHash('sha1').update(`${head}\0${cmd}`).digest('hex').slice(0, 16);
  if (!dirty) {
    const hit = readCache(root)[key];
    if (hit) return { ...hit, cached: true };
    if (inFlight.has(key)) return { ...(await inFlight.get(key)), cached: true };
  }
  const job = (async () => {
    const r = await runVerify(work, { ...settings, verify: cmd }, logFile);
    const out = { status: r.status, cmd, head: head.slice(0, 7), at: new Date().toISOString(), log: logFile, failures: failureLines(readLog(logFile)).slice(0, 200) };
    if (!dirty) writeCache(root, { ...readCache(root), [key]: out });
    return out;
  })();
  if (!dirty) inFlight.set(key, job);
  try { return { ...(await job), cached: false, dirty }; } finally { inFlight.delete(key); }
}

function readLog(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

/** Lines that name a failure, with timings and counters removed so two runs can be compared. */
export function failureLines(text) {
  const out = new Set();
  for (const raw of String(text || '').split('\n')) {
    if (/^(\$ |--- )/.test(raw)) continue; // the log's own header lines (the command, exit code)
    if (!/(\bFAIL(ED|URE)?\b|\bERROR\b|\bError\b|✖|✗|^\s*not ok\b|\bfailed\b|AssertionError|Traceback)/.test(raw)) continue;
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\(?\d+(\.\d+)?\s*(ms|s|sec|seconds)\)?/g, '').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').trim();
    if (l.length > 3) out.add(l.slice(0, 200));
  }
  return [...out];
}

/** Failure lines in `after` that the base run didn't have: what the worker's change may have broken. */
export function newFailures(baseLines, afterText) {
  const base = new Set(baseLines || []);
  return failureLines(afterText).filter((l) => !base.has(l));
}

// files a worker may change without listing them: lockfiles and test snapshots follow from the listed changes
const ALWAYS_OK = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'composer.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Gemfile.lock', '**/__snapshots__/**', '*.snap'];

const stem = (f) => path.basename(f).replace(/(\.d)?\.[^.]+$/, '');
/** Is `file` the test of `listed` (same name with .test/.spec/_test/test_/Test)? */
function isTestOf(file, listed) {
  const s = stem(listed).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(${s}[._-](test|spec)|test_${s}|${s}_test|${s}Tests?)\\.[^/]+$`, 'i').test(path.basename(file));
}

/**
 * The scope gate: files changed outside the task's `files:` list (plus their tests, lockfiles, snapshots and
 * settings.scopeAllow). Returns null when the task lists no files (nothing to compare against).
 */
export function scopeCheck(changed, listed, { allow = [] } = {}) {
  if (!listed?.length) return null;
  const clean = (f) => f.trim().replace(/^\.\//, '');
  const matchers = [...listed, ...ALWAYS_OK, ...allow].map(clean).map((f) => (f.endsWith('/') ? globToRegex(`${f}**`) : globToRegex(f)));
  const inScope = (f) => matchers.some((re) => re.test(f)) || listed.some((l) => isTestOf(f, clean(l)));
  return { outside: changed.map(clean).filter((f) => !inScope(f)) };
}

// ---------------- edit guard (H6) ----------------
import { which } from './util.js';

/**
 * Syntax errors in changed files, checked without running them: node --check (JS), JSON.parse, php -l, Python's
 * parser. Languages with no checker available are skipped. → [{ file, error }]
 */
export function syntaxErrors(work, files) {
  const out = [];
  for (const f of files) {
    const abs = path.join(work, f);
    let text; try { if (!fs.statSync(abs).isFile()) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; } // deleted
    const fail = (error) => out.push({ file: f, error: String(error).trim().split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300) });
    try {
      if (/\.(m?js|cjs)$/.test(f)) execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'ignore', 'pipe'] });
      else if (/\.json$/.test(f) && !/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(f)) JSON.parse(text);
      else if (/\.php$/.test(f) && which('php')) execFileSync('php', ['-l', abs], { stdio: ['ignore', 'pipe', 'pipe'] });
      else if (/\.py$/.test(f) && which('python3')) execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', abs], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { fail(e.stderr?.toString() || e.stdout?.toString() || e.message); }
  }
  return out;
}

// names a task may mention that are never the project's own: language built-ins and test helpers
const NOT_CONTRACT = new Set(['require', 'import', 'describe', 'test', 'it', 'expect', 'assert', 'beforeEach', 'afterEach', 'print', 'len', 'range',
  'str', 'int', 'dict', 'list', 'set', 'map', 'isset', 'count', 'array', 'strlen', 'json_encode', 'json_decode', 'echo', 'super', 'this', 'self',
  'typeof', 'await', 'async', 'return', 'function', 'new', 'throw', 'catch', 'if', 'for', 'while', 'switch', 'fetch', 'console']);

/** Functions and classes the task itself names in code spans: `toQuery(...)`, `new LRUCache(2)`, `class Cart`. */
export function contractNames(section) {
  const names = new Set();
  for (const [, span] of String(section || '').matchAll(/`([^`\n]+)`/g)) {
    for (const m of span.matchAll(/(?<![\w$.])(?:new\s+|class\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
    for (const m of span.matchAll(/(?:class|new)\s+([A-Z][\w$]*)/g)) names.add(m[1]);
  }
  return [...names].filter((n) => n.length >= 3 && !NOT_CONTRACT.has(n) && !(n in globalThis));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function definedIn(text, name) {
  const n = esc(name);
  return new RegExp(`(?:function\\*?|class|def|func|const|let|var|interface|trait|type|enum)\\s+${n}\\b`).test(text) ||
    new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|async|get|set|override)\\s+)*${n}\\s*\\([^)\\n]*\\)\\s*(?::[^{\\n]*)?\\{`, 'm').test(text) ||
    new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(text) ||
    new RegExp(`(?:^|[\\s,{])${n}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function|[A-Za-z_$][\\w$]*\\s*=>)`, 'm').test(text);
}

/**
 * The contract check: names the task gives (in code spans) that the project still doesn't define anywhere after the
 * worker's change. Catches a worker that "finished" under a name of its own, with its own tests using that name.
 */
export function missingContract(work, section) {
  const names = contractNames(section);
  if (!names.length) return [];
  let files = [];
  try { files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 }).toString().split('\n').filter(Boolean); } catch { return []; }
  const code = files.filter((f) => /\.(m?js|cjs|jsx|tsx?|py|php|go|rb|java|kt|rs|cs|swift)$/i.test(f) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(f));
  const left = new Set(names);
  for (const f of code) {
    if (!left.size) break;
    let text; try { const st = fs.statSync(path.join(work, f)); if (st.size > 500_000) continue; text = fs.readFileSync(path.join(work, f), 'utf8'); } catch { continue; }
    for (const n of [...left]) if (text.includes(n) && definedIn(text, n)) left.delete(n);
  }
  return [...left];
}
