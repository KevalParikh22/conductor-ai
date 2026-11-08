// conductor's own files in a project (AGENTS.md, CLAUDE.md, .conductor/, plans, skills…) stay out of git by default:
// `init` lists them in a marked block in .gitignore. Because git can't see them then, conductor itself copies them
// into task worktrees and puts them back if a worker changes them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BLOCK_START = '# >>> conductor: local files, not committed (conductor init --share keeps them in git)';
export const BLOCK_END = '# <<< conductor';

// always ignored when conductor manages a project; created files are added on top of these
export const BASE_ENTRIES = ['.conductor/', 'docs/plan/', '.claude/commands/conduct-*', '.agents/skills/conduct-*/'];
// files conductor writes for a controller: ignored only when conductor created them (never your own existing file)
export const CREATED_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'HANDOFF.md', 'docs/architecture.md', '.mcp.json', 'opencode.json', '.agents/mcp_config.json', '.vscode/mcp.json'];
// not copied into worktrees: conductor's own state, plans (inlined into the prompt) and MCP configs
const NOT_IN_WORKTREES = ['.conductor/', 'docs/plan/', '.mcp.json', 'opencode.json', '.agents/mcp_config.json', '.vscode/mcp.json'];

/** Entries in the conductor block of .gitignore ([] when there is none). */
export function readBlock(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return []; }
  const i = text.indexOf(BLOCK_START), j = text.indexOf(BLOCK_END);
  if (i < 0 || j < i) return [];
  return text.slice(i + BLOCK_START.length, j).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Write (or replace) the conductor block. Creates .gitignore when missing. Returns 'added' | 'updated' | 'kept'. */
export function writeBlock(root, entries) {
  const file = path.join(root, '.gitignore');
  const existed = fs.existsSync(file);
  const cur = existed ? fs.readFileSync(file, 'utf8') : '';
  const block = [BLOCK_START, ...[...new Set(entries)], BLOCK_END].join('\n');
  const i = cur.indexOf(BLOCK_START), j = cur.indexOf(BLOCK_END);
  const next = i >= 0 && j > i ? cur.slice(0, i) + block + cur.slice(j + BLOCK_END.length) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block}\n`;
  if (next === cur) return 'kept';
  fs.writeFileSync(file, next);
  return existed ? 'updated' : 'added';
}

/** Remove the conductor block (init --share). */
export function removeBlock(root) {
  const file = path.join(root, '.gitignore');
  let cur; try { cur = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const i = cur.indexOf(BLOCK_START), j = cur.indexOf(BLOCK_END);
  if (i < 0 || j < i) return false;
  fs.writeFileSync(file, (cur.slice(0, i) + cur.slice(j + BLOCK_END.length)).replace(/\n{3,}/g, '\n\n'));
  return true;
}

/** Entries that git already tracks (ignoring them doesn't stop that: they need `git rm --cached`). */
export function trackedEntries(root, entries) {
  return entries.filter((e) => {
    try { return !!execFileSync('git', ['ls-files', '--', e.replace(/\/$/, '')], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return false; }
  });
}

/** Existing paths (relative) matching block entries; "*" matches within one path segment. */
export function expand(root, entries) {
  const out = [];
  for (const e of entries) {
    const clean = e.replace(/\/$/, '');
    if (!clean.includes('*')) { if (fs.existsSync(path.join(root, clean))) out.push(clean); continue; }
    const dir = path.dirname(clean), re = new RegExp(`^${path.basename(clean).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    try { for (const n of fs.readdirSync(path.join(root, dir))) if (re.test(n)) out.push(path.join(dir, n)); } catch { /* no folder */ }
  }
  return [...new Set(out)];
}

/** Files under the given paths (relative), walking folders. */
function files(root, rels, limit = 2000) {
  const out = [];
  const walk = (rel) => {
    if (out.length >= limit) return;
    let st; try { st = fs.lstatSync(path.join(root, rel)); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const n of fs.readdirSync(path.join(root, rel))) walk(path.join(rel, n));
    else if (st.isFile()) out.push(rel);
  };
  rels.forEach(walk);
  return out;
}

/** Skill folders conductor synced into .claude/skills and .agents/skills (they carry a marker file). */
export function syncedSkillDirs(root) {
  const out = [];
  for (const t of ['.claude/skills', '.agents/skills']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, t)); } catch { continue; }
    for (const n of names) if (fs.existsSync(path.join(root, t, n, '.conductor-skill'))) out.push(path.join(t, n));
  }
  return out;
}

/** The local files a worker should see in its worktree (rules, controller files, skills). */
export function worktreeFiles(root) {
  const ignored = readBlock(root);
  if (!ignored.length) return [];
  return [...new Set([...expand(root, ignored.filter((e) => !NOT_IN_WORKTREES.includes(e))), ...syncedSkillDirs(root)])];
}

/** Copy conductor's ignored files into a fresh worktree. Returns the relative paths copied. */
export function copyIntoWorktree(root, dir) {
  const copied = [];
  for (const rel of worktreeFiles(root)) {
    const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(path.join(root, rel), dst, { recursive: true, dereference: false });
    copied.push(rel);
  }
  return copied;
}

/**
 * Snapshot conductor's local files in `work` (entries from `root`'s .gitignore), so a worker's edits can be undone
 * even though git can't see them. Returns restore() → the paths that were put back.
 */
export function snapshot(root, work) {
  const block = readBlock(root);
  const rels = block.length ? files(work, [...expand(work, block.filter((e) => e !== '.conductor/')), ...syncedSkillDirs(work)]) : [];
  const saved = new Map(rels.map((r) => [r, fs.readFileSync(path.join(work, r))]));
  return () => {
    const back = [];
    for (const [r, buf] of saved) {
      const abs = path.join(work, r);
      let now = null; try { now = fs.readFileSync(abs); } catch { /* deleted */ }
      if (now && now.equals(buf)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      back.push(r);
    }
    return back;
  };
}
