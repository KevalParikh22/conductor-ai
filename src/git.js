import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

function git(root, args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts }).toString();
  } catch (e) {
    if (opts.allowFail) return e.stdout?.toString() ?? '';
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

export const isRepo = (root) => { try { git(root, ['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; } };
export const branch = (root) => git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }).trim() || '(detached)';
export const status = (root) => git(root, ['status', '--porcelain']).trimEnd();
export const isDirty = (root) => status(root).length > 0;
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
export function diffAgainst(root, base) {
  let d = git(root, ['diff', base], { allowFail: true });
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of untracked) d += git(root, ['diff', '--no-index', '--', '/dev/null', f], { allowFail: true });
  return d;
}

export const diffStat = (root) => git(root, ['diff', '--stat'], { allowFail: true }).trimEnd();
export const failedStashCount = (root) =>
  git(root, ['stash', 'list'], { allowFail: true }).split('\n').filter((l) => l.includes('conductor: failed attempt')).length;
