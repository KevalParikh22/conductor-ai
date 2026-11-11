// Checks conductor enforces around a write task (by code, not by asking the model):
//   base check (H4): run verify on the starting commit first, so failures that were already there aren't blamed on
//                    the worker. Cached per commit + command; parallel tasks on the same commit share one run.
//   scope gate (Q5): files the worker changed that the task doesn't list.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
