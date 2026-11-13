// Q7: lessons, the team's memory. Every failure conductor diagnoses (a failed acceptance check, a misnamed export,
// a wrong test, out-of-scope edits…) and every --note the controller writes is kept per project. Later work in the
// same area gets the matching lessons in its prompt, and a provider that failed the same kind of task twice moves to
// the back of the chain for it. Research on experience memory: modest but real gains (+4–7 points on coding tasks),
// so it stays small: a few lines per prompt, deduplicated, never a log dump.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECT_DIRNAME } from './config.js';

const MAX = 500;
// Inside the repository's git folder: git never tracks it (so it can't make the tree look changed, even when
// conductor's folder is shared with init --share), and each clone keeps its own. promote shares one via AGENTS.md.
const gitDirs = new Map();
/** conductor's private folder inside the repository's git folder (never tracked; per clone). */
export function conductorGitDir(root) {
  if (!gitDirs.has(root)) {
    let d = null;
    try { d = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo */ }
    gitDirs.set(root, d ? path.join(path.isAbsolute(d) ? d : path.join(root, d), 'conductor') : path.join(root, PROJECT_DIRNAME));
  }
  return gitDirs.get(root);
}
export const lessonsFile = (root) => path.join(conductorGitDir(root), 'lessons.jsonl');

// what each kind of failure teaches the next worker (provider-neutral)
export const GUIDANCE = {
  'acceptance-check': 'An acceptance criterion failed when run',
  'missing-name': 'Define (and export) functions and classes under exactly the names the task gives; a worker here used its own names',
  'wrong-test': 'Check every expected value in your tests against the task and its acceptance criteria; a worker here wrote tests that contradicted the spec',
  scope: "Change only the task's files; a worker here edited files outside the task",
  'regression-test': 'For a fix, add a test that fails on the original code because of the bug, then passes with the fix',
  syntax: 'Make sure every file you write parses; a worker here returned a file with a syntax error',
  'no-files': 'Reply with the complete <<<FILE blocks; a worker here answered without any',
  verify: "Run the project's checks before reporting DONE; a worker here finished with failing tests",
};

export function readLessons(root) {
  let text = '';
  try { text = fs.readFileSync(lessonsFile(root), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function writeLessons(root, list) {
  fs.mkdirSync(path.dirname(lessonsFile(root)), { recursive: true });
  fs.writeFileSync(lessonsFile(root), list.slice(-MAX).map((l) => JSON.stringify(l)).join('\n') + (list.length ? '\n' : ''));
}

const dirs = (files = []) => [...new Set(files.map((f) => path.posix.dirname(f.replace(/^\.\//, ''))))].sort();

/** Add a lesson, or count a repeat of the same one (same source, kind, provider, role, folders and text). */
export function addLesson(root, l) {
  const list = readLessons(root);
  const entry = { source: 'manual', kind: null, provider: null, role: null, files: [], text: '', ...l, dirs: dirs(l.files) };
  const key = (x) => JSON.stringify([x.source, x.kind, x.provider, x.role, x.dirs, x.kind === 'acceptance-check' || x.source !== 'auto' ? x.text : '']);
  const same = list.find((x) => key(x) === key(entry));
  if (same) { same.count = (same.count || 1) + 1; same.ts = new Date().toISOString(); writeLessons(root, list); return same; }
  const fresh = { id: crypto.randomBytes(3).toString('hex'), ts: new Date().toISOString(), count: 1, ...entry };
  list.push(fresh);
  writeLessons(root, list);
  return fresh;
}

export function removeLesson(root, id) {
  const list = readLessons(root);
  const i = list.findIndex((l) => l.id === id);
  if (i < 0) return null;
  const [gone] = list.splice(i, 1);
  writeLessons(root, list);
  return gone;
}

/** Does a lesson apply to work with this role and these files? Same folder, or a lesson with no files at all. */
export function lessonMatches(l, { role, files = [] }) {
  if (l.role && role && l.role !== role) return false;
  if (!l.dirs?.length) return true;
  const want = dirs(files);
  return !want.length || l.dirs.some((d) => want.some((w) => w === d || w.startsWith(`${d}/`) || d.startsWith(`${w}/`)));
}

/** The prompt section: the controller's notes and manual lessons first, then what failures here teach. */
export function lessonsPrompt(root, task, { max = 5 } = {}) {
  const hits = readLessons(root).filter((l) => !l.promoted && lessonMatches(l, task));
  if (!hits.length) return { text: '', ids: [] };
  const lines = [], ids = [];
  const byRecent = (a, b) => (b.count || 1) - (a.count || 1) || String(b.ts).localeCompare(String(a.ts));
  for (const l of hits.filter((x) => x.source !== 'auto').sort(byRecent)) {
    if (lines.length >= max) break;
    lines.push(`- ${l.text}`); ids.push(l.id);
  }
  const kinds = new Set();
  for (const l of hits.filter((x) => x.source === 'auto').sort(byRecent)) {
    if (lines.length >= max) break;
    if (l.kind === 'acceptance-check') { lines.push(`- ${GUIDANCE['acceptance-check']}: ${l.text}`); ids.push(l.id); continue; }
    if (kinds.has(l.kind) || !GUIDANCE[l.kind]) continue;
    kinds.add(l.kind); lines.push(`- ${GUIDANCE[l.kind]}.`); ids.push(l.id);
  }
  if (!lines.length) return { text: '', ids: [] };
  return { text: `\n## Lessons from earlier work in this project\n${lines.join('\n')}\n`, ids };
}

/**
 * Providers that failed this kind of work at least `after` times (same role, same area, last `days` days) move to
 * the back of the chain, in their original order. Nothing is removed. → { chain, demoted }
 */
export function demoteByLessons(root, chainNames, { role, files = [], after = 2, days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const fails = {};
  for (const l of readLessons(root)) {
    if (l.source !== 'auto' || !l.provider || Date.parse(l.ts) < since || !lessonMatches(l, { role, files })) continue;
    fails[l.provider] = (fails[l.provider] || 0) + (l.count || 1);
  }
  const demoted = chainNames.filter((n) => (fails[n] || 0) >= after);
  if (!demoted.length || demoted.length === chainNames.length) return { chain: chainNames, demoted: [] };
  return { chain: [...chainNames.filter((n) => !demoted.includes(n)), ...demoted], demoted: demoted.map((n) => `${n} (${fails[n]} failures)`) };
}

/** What a finished run teaches: one auto lesson per diagnosed failure, attributed to the provider that made it. */
export function lessonsFromRun(s, { files = [] } = {}) {
  const out = [];
  const add = (provider, kind, text = '') => provider && out.push({ source: 'auto', provider, role: s.role, kind, files, text });
  for (const a of s.attempts || []) {
    if (a.guard?.syntax?.length) add(a.provider, 'syntax');
    else if (a.guard?.missing?.length || a.guard?.unexported?.length) add(a.provider, 'missing-name', [...(a.guard.missing || []), ...(a.guard.unexported || [])].join(', '));
    else if (/no file blocks/.test(a.reason || '')) add(a.provider, 'no-files');
  }
  const w = s.winner;
  if (!w || s.mode !== 'write') return out;
  if (s.checks?.failed?.length) { const f = s.checks.failed[0]; add(w, 'acceptance-check', `\`${f.expr}\` should ${f.kind === 'returns' ? `return \`${f.expected}\`` : `throw ${f.expected}`} (a worker's version ${f.got})`); }
  if (s.verify?.suspectTests?.length) add(w, 'wrong-test');
  else if (s.verify?.status === 'FAIL' && !(s.verify.baseFailed && !s.verify.newFailures?.length)) add(w, 'verify');
  if (s.scope?.outside?.length && !s.scope.allowed) add(w, 'scope', s.scope.outside.join(', '));
  if (s.repro?.ok === false && !s.repro.waived) add(w, 'regression-test');
  for (const e of s.escalated || []) if (e.from && !out.some((x) => x.provider === e.from)) add(e.from, e.checksFailed ? 'acceptance-check' : 'verify', e.checksFailed ? 'its acceptance checks failed' : '');
  return out;
}

/** Make a lesson a permanent rule: a bullet in AGENTS.md (read by every controller and worker), marked promoted. */
export function promoteLesson(root, id) {
  const list = readLessons(root);
  const l = list.find((x) => x.id === id);
  if (!l) return null;
  const text = l.source === 'auto' && l.kind !== 'acceptance-check' ? GUIDANCE[l.kind] : l.text;
  const file = path.join(root, 'AGENTS.md');
  let cur = ''; try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  const bullet = `- ${text.replace(/\.$/, '')}.${l.dirs?.length && l.dirs[0] !== '.' ? ` (in ${l.dirs.join(', ')})` : ''}`;
  const head = '## Lessons (promoted by conductor)';
  const next = cur.includes(head) ? cur.replace(head, `${head}\n${bullet}`) : `${cur.trimEnd()}${cur ? '\n\n' : ''}${head}\n${bullet}\n`;
  fs.writeFileSync(file, next);
  l.promoted = true;
  writeLessons(root, list);
  return { lesson: l, bullet };
}
