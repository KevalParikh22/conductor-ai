// Isolated git worktrees, so several write tasks can run at the same time without touching each other.
// Each task gets its own checkout (outside the repo) on branch conductor/<id>; the result is committed there
// and the controller merges the branches it accepts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GLOBAL_DIR } from './util.js';

export const BRANCH_PREFIX = 'conductor/';

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
  const real = fs.realpathSync(root);
  const id = crypto.createHash('sha1').update(real).digest('hex').slice(0, 8);
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
      throw new Error(`worktree for "${sid}" already exists (branch ${branch}). Merge it, or remove it with: conductor worktree rm ${sid} (or pass --replace)`);
    }
    removeWorktree(root, sid, { force: true });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
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
  if (linked.length) {
    // keep the symlinks out of `git status` in the worktree (info/exclude is shared by all worktrees)
    const exclude = path.join(git(root, ['rev-parse', '--git-common-dir']).trim(), 'info', 'exclude');
    const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const add = linked.map((n) => `/${n}`).filter((l) => !cur.split('\n').includes(l));
    if (add.length) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.appendFileSync(abs, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`); }
  }
  return { id: sid, branch, dir, base: git(root, ['rev-parse', 'HEAD']).trim(), linked };
}

/** Commit everything in the worktree on its branch. Returns the short sha, or null if nothing changed. */
export function commitWorktree(dir, message) {
  if (!git(dir, ['status', '--porcelain']).trim()) return null;
  git(dir, ['add', '-A']);
  const args = ['commit', '-q', '--no-verify', '-m', message];
  if (git(dir, args, { allowFail: true }) === null) {
    // no git identity configured: commit as conductor rather than lose the work
    git(dir, ['-c', 'user.name=conductor', '-c', 'user.email=conductor@localhost', ...args]);
  }
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim();
}

/** conductor/* worktrees of this repo, with how many commits each is ahead of HEAD and whether it is merged. */
export function listWorktrees(root) {
  const out = git(root, ['worktree', 'list', '--porcelain']) || '';
  const items = [];
  for (const block of out.split('\n\n')) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!dir || !ref?.startsWith(BRANCH_PREFIX)) continue;
    const ahead = Number(git(root, ['rev-list', '--count', `HEAD..${ref}`], { allowFail: true }) || 0);
    const dirty = fs.existsSync(dir) && !!(git(dir, ['status', '--porcelain'], { allowFail: true }) || '').trim();
    items.push({ id: ref.slice(BRANCH_PREFIX.length), branch: ref, dir, ahead, merged: ahead === 0, dirty });
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
  if (branchExists(root, branch)) {
    if (git(root, ['branch', force ? '-D' : '-d', branch], { allowFail: true }) !== null) notes.push(`deleted branch ${branch}`);
    else notes.push(`kept branch ${branch}: it has commits that are not merged (merge it, or use --force to discard)`);
  }
  if (!notes.length) notes.push(`nothing to remove for "${sid}"`);
  return notes;
}
