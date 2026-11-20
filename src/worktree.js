// Isolated git worktrees, so several write tasks can run at the same time without touching each other.
// Each task gets its own checkout (outside the repo) on branch conductor-ai/<id>; the result is committed there
// and the controller merges the branches it accepts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GLOBAL_DIR } from './util.js';
import { copyIntoWorktree } from './localfiles.js';

export const BRANCH_PREFIX = 'conductor-ai/';
const LEGACY_PREFIX = 'conductor/'; // branches made before the rename still show up and can be removed

// Ignored dependency folders shared into each worktree (as symlinks) so verify can run without a reinstall.
export const DEFAULT_LINKS = ['node_modules', 'vendor', '.venv', 'venv'];

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

/** Worktrees live outside the repo, so test runners and file watchers in the main checkout never see them. */
export function worktreesDir(root) {
  // native: the same folder gives the same id however it was named (Windows short names like RUNNER~1, / or \\, case)
  const real = fs.realpathSync.native(root);
  const id = crypto.createHash('sha1').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 8);
  return path.join(GLOBAL_DIR, 'worktrees', `${path.basename(real)}-${id}`);
}

export const safeId = (id) => String(id).replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'task';

export function branchExists(root, branch) {
  return git(root, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { allowFail: true }) !== null;
}

/** Create a worktree for `id` from the current HEAD commit. Throws if one already exists (unless replace). */
export function createWorktree(root, id, { replace = false, links = DEFAULT_LINKS } = {}) {
  const sid = safeId(id);
  const branch = BRANCH_PREFIX + sid;
  const dir = path.join(worktreesDir(root), sid);
  if (branchExists(root, branch) || fs.existsSync(dir)) {
    if (!replace) {
      throw new Error(`worktree for "${sid}" already exists (branch ${branch}). Merge it, or remove it with: conductor-ai worktree rm ${sid} (or pass --replace)`);
    }
    removeWorktree(root, sid, { force: true });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
  const linked = linkIgnored(root, dir, links);
  // conductor-ai's own files (AGENTS.md, skills…) are git-ignored, so the checkout lacks them: copy them in
  const copied = copyIntoWorktree(root, dir);
  if (linked.length || copied.length) {
    // keep the symlinks and copies out of `git status` in the worktree (info/exclude is shared by all worktrees)
    const exclude = path.join(git(root, ['rev-parse', '--git-common-dir']).trim(), 'info', 'exclude');
    const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const add = [...linked, ...copied].map((n) => `/${n}`).filter((l) => !cur.split('\n').includes(l));
    if (add.length) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.appendFileSync(abs, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`); }
  }
  return { id: sid, branch, dir, base: git(root, ['rev-parse', 'HEAD']).trim(), linked };
}

/** Symlink the ignored dependency folders (node_modules, .venv…) from the main checkout into `dir`. */
function linkIgnored(root, dir, links) {
  const linked = [];
  for (const name of links) {
    const src = path.join(root, name);
    const dst = path.join(dir, name);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    // only share folders git ignores; tracked folders are already in the checkout
    if (git(root, ['check-ignore', '-q', name], { allowFail: true }) === null) continue;
    fs.symlinkSync(src, dst, 'dir');
    linked.push(name);
  }
  return linked;
}

/** True when `commit` is still in this repo (a merged and deleted branch keeps its commits; a gc'd one doesn't). */
export const commitExists = (root, commit) => !!commit && git(root, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true }) !== null;

/**
 * Run `fn(dir)` in a throwaway checkout of `commit` (no branch), with the same shared folders and conductor-ai files
 * a task worktree gets. The checkout is removed afterwards, whatever fn does.
 */
export async function withCommitCheckout(root, commit, fn, { links = DEFAULT_LINKS } = {}) {
  const dir = path.join(worktreesDir(root), `.recheck-${safeId(commit)}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-q', '--detach', dir, commit]);
  try {
    linkIgnored(root, dir, links);
    copyIntoWorktree(root, dir);
    return await fn(dir);
  } finally {
    git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'prune'], { allowFail: true });
  }
}

/**
 * Reopen a task's existing worktree to continue the work in it (a retry with the orchestrator's note).
 * Throws when there is none. base = where the branch left the current HEAD.
 */
export function openWorktree(root, id) {
  const sid = safeId(id);
  const branch = BRANCH_PREFIX + sid;
  const dir = path.join(worktreesDir(root), sid);
  if (!fs.existsSync(dir) || !branchExists(root, branch)) {
    throw new Error(`no worktree for "${sid}" to continue. Start the task with --worktree (or conductor-ai batch) first`);
  }
  const base = (git(root, ['merge-base', 'HEAD', branch], { allowFail: true }) || git(root, ['rev-parse', 'HEAD'])).trim();
  const linked = DEFAULT_LINKS.filter((n) => { try { return fs.lstatSync(path.join(dir, n)).isSymbolicLink(); } catch { return false; } });
  return { id: sid, branch, dir, base, linked, continued: true };
}

const metaFile = (root, id) => path.join(worktreesDir(root), '.meta', `${safeId(id)}.json`);
/** What a worktree was made for (role, plan, task) and who last worked in it, so `conductor-ai retry` can continue it. */
export function readWorktreeMeta(root, id) {
  try { return JSON.parse(fs.readFileSync(metaFile(root, id), 'utf8')); } catch { return null; }
}
export function writeWorktreeMeta(root, id, data) {
  const f = metaFile(root, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...(readWorktreeMeta(root, id) || {}), ...data, updatedAt: new Date().toISOString() }, null, 2));
}

/** Commit everything in the worktree on its branch. Returns the short sha, or null if nothing changed. */
export function commitWorktree(dir, message) {
  if (!git(dir, ['status', '--porcelain']).trim()) return null;
  git(dir, ['add', '-A']);
  const args = ['commit', '-q', '--no-verify', '-m', message];
  if (git(dir, args, { allowFail: true }) === null) {
    // no git identity configured: commit as conductor-ai rather than lose the work
    git(dir, ['-c', 'user.name=conductor-ai', '-c', 'user.email=conductor-ai@localhost', ...args]);
  }
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim();
}

/** conductor-ai/* worktrees of this repo, with how many commits each is ahead of HEAD and whether it is merged. */
export function listWorktrees(root) {
  const out = git(root, ['worktree', 'list', '--porcelain']) || '';
  const items = [];
  for (const block of out.split('\n\n')) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    const prefix = [BRANCH_PREFIX, LEGACY_PREFIX].find((p) => ref?.startsWith(p));
    if (!dir || !prefix) continue;
    const ahead = Number(git(root, ['rev-list', '--count', `HEAD..${ref}`], { allowFail: true }) || 0);
    const dirty = fs.existsSync(dir) && !!(git(dir, ['status', '--porcelain'], { allowFail: true }) || '').trim();
    items.push({ id: ref.slice(prefix.length), branch: ref, dir, ahead, merged: ahead === 0, dirty });
  }
  return items;
}

/** Remove a task's worktree. The branch is deleted only when merged, unless force. */
export function removeWorktree(root, id, { force = false } = {}) {
  const sid = safeId(id);
  const branch = BRANCH_PREFIX + sid;
  const dir = path.join(worktreesDir(root), sid);
  const notes = [];
  if (fs.existsSync(dir)) {
    git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    notes.push(`removed ${dir}`);
  }
  git(root, ['worktree', 'prune'], { allowFail: true });
  const io = path.join(worktreesDir(root), '.io');
  if (fs.existsSync(io)) for (const f of fs.readdirSync(io)) if (f.startsWith(`${sid}-`)) fs.rmSync(path.join(io, f), { recursive: true, force: true });
  fs.rmSync(metaFile(root, sid), { force: true });
  for (const b of [branch, LEGACY_PREFIX + sid]) if (branchExists(root, b)) {
    if (git(root, ['branch', force ? '-D' : '-d', b], { allowFail: true }) !== null) notes.push(`deleted branch ${b}`);
    else notes.push(`kept branch ${b}: it has commits that are not merged (merge it, or use --force to discard)`);
  }
  if (!notes.length) notes.push(`nothing to remove for "${sid}"`);
  return notes;
}
