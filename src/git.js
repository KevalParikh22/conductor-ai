import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function git(root, args, opts = {}) {
  try {
    // core.fsmonitor names a program git runs on status/diff: never let a repo's config run one through conductor-ai
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts }).toString();
  } catch (e) {
    if (opts.allowFail) return e.stdout?.toString() ?? '';
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

export const isRepo = (root) => { try { git(root, ['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; } };
export const branch = (root) => git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }).trim() || '(detached)';
export const status = (root) => git(root, ['status', '--porcelain']).trimEnd();
export const isDirty = (root) => status(root).length > 0;
export const head = (root) => git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true }).trim();
export const hasCommits = (root) => { try { git(root, ['rev-parse', '-q', '--verify', 'HEAD']); return true; } catch { return false; } };

/** Hash of the working tree state, used to detect changes made by read-only runs. */
export function stateHash(root) {
  const s = status(root) + '\n' + git(root, ['diff'], { allowFail: true });
  return crypto.createHash('sha1').update(s).digest('hex');
}

export function changedFiles(root) {
  return git(root, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
}

export function stashPush(root, message) {
  if (!isDirty(root)) return false;
  git(root, ['stash', 'push', '-u', '-q', '-m', message]);
  return true;
}

export function defaultBase(root) {
  for (const b of ['main', 'master']) {
    try {
      git(root, ['rev-parse', '-q', '--verify', b]);
      const mb = git(root, ['merge-base', 'HEAD', b]).trim();
      return mb;
    } catch { /* try next */ }
  }
  return 'HEAD';
}

/** Diff of working tree vs base, plus untracked files as new-file diffs. */
/** Raw `git diff` with the given arguments ('' on error). */
export const diffRaw = (root, args) => git(root, ['diff', '--no-color', '--no-ext-diff', ...args], { allowFail: true });
/** Untracked files that are not ignored. */
export const untracked = (root) => git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);

/** `git diff --stat base` in root, committed and uncommitted changes together ('' when none). */
export function diffStatVs(root, base) {
  return (git(root, ['diff', '--stat', base], { allowFail: true }) || '').trim();
}

export function diffAgainst(root, base) {
  let d = git(root, ['diff', base], { allowFail: true });
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of untracked) d += git(root, ['diff', '--no-index', '--', '/dev/null', f], { allowFail: true });
  return d;
}

export const diffStat = (root) => git(root, ['diff', '--stat'], { allowFail: true }).trimEnd();
export const failedStashCount = (root) =>
  git(root, ['stash', 'list'], { allowFail: true }).split('\n').filter((l) => /conductor(-ai)?: failed attempt/.test(l)).length;

// ---------------- git control files ----------------
// .git/config and .git/hooks can make git run programs (hooks, fsmonitor, filters, diff drivers). They are not in
// `git status`, so a worker that wrote them would go unnoticed and its code would run on the next git command.
// conductor-ai snapshots them before a worker runs and puts them back afterwards, before it runs git again.

// info/exclude can hide a worker's new files from git status (and so from the scope and evidence checks), and
// info/attributes can mark files -diff to hide their changes from review
const CONTROL = ['config', 'config.worktree', 'info/exclude', 'info/attributes'];
// A git dir and the submodule git dirs inside it (modules/<name>, names may hold slashes, and nest): a planted
// fsmonitor there runs on your next plain `git status` in the parent repo.
function gitDirs(d) {
  const out = [d];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, 'HEAD'))) out.push(...gitDirs(p)); else walk(p);
    }
  };
  walk(path.join(d, 'modules'));
  return out;
}
const filesIn = (d) => {
  const files = CONTROL.map((f) => path.join(d, f));
  try { for (const f of fs.readdirSync(path.join(d, 'hooks'))) files.push(path.join(d, 'hooks', f)); } catch { /* no hooks folder */ }
  return files;
};
function controlFiles(root) {
  const dirs = new Set();
  for (const a of ['--git-dir', '--git-common-dir']) {
    const d = git(root, ['rev-parse', a], { allowFail: true }).trim();
    if (d) dirs.add(path.resolve(root, d));
  }
  return { dirs: [...dirs], files: [...dirs].flatMap(gitDirs).flatMap(filesIn) };
}

const readOrNull = (f) => { try { return { data: fs.readFileSync(f), mode: fs.statSync(f).mode }; } catch { return null; } };

export function snapshotControl(root) {
  const { dirs, files } = controlFiles(root);
  return { root, dirs, files: new Map(files.map((f) => [f, readOrNull(f)])) };
}

/** Put .git/config, hooks and info files (also submodules') back as they were. Returns what had changed (paths relative to the repo). */
export function restoreControl(snap) {
  const changed = [];
  const now = new Set(snap.dirs.flatMap(gitDirs).flatMap(filesIn));
  for (const f of new Set([...snap.files.keys(), ...now])) {
    const was = snap.files.get(f) ?? null, cur = readOrNull(f);
    const same = was && cur ? was.data.equals(cur.data) && was.mode === cur.mode : was === cur;
    if (same) continue;
    changed.push(path.relative(snap.root, f).split(path.sep).join('/') || f);
    if (was) { fs.writeFileSync(f, was.data); fs.chmodSync(f, was.mode); } else fs.rmSync(f, { recursive: true, force: true });
  }
  return changed;
}

/** core.hooksPath when it points inside the repo (husky and friends): those hooks are ordinary tracked files. */
export function repoHooksPath(root) {
  const p = git(root, ['config', '--get', 'core.hooksPath'], { allowFail: true }).trim();
  if (!p) return null;
  const rel = path.relative(root, path.resolve(root, p)).replaceAll('\\', '/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}
