// What a chat model (no tools) is shown so it doesn't have to guess: a short map of the project, with the names each
// code file defines. Agents can look for themselves; chat models can't (H7: conductor does the "find" step).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODE = /\.(m?js|cjs|jsx|tsx?|py|php|go|rb|java|kt|rs|cs|swift)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.conductor|\.claude|\.agents|\.gemini|docs\/plan)\//;
const SECRET = /(^|\/)(\.env[^/]*|auth\.json|secrets?\.[^/]+|env\.php|id_[a-z0-9]+|[^/]+\.pem|[^/]+\.key)$/i;

// top-level definitions: export/function/class/const in JS/TS, def/class in Python, function/class in PHP, func in Go
const DEFS = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s*\{([^}]*)\}/gm,
  /^(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:def|class)\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:public\s+|final\s+|abstract\s+)*(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/gm,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
];

/** Names a code file defines at the top level (exports first). */
export function fileSymbols(text) {
  const names = [];
  for (const re of DEFS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      for (const n of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

function projectFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 })
      .toString().split('\n').filter(Boolean);
  } catch { return []; }
}

/** "path: name, name" per code file, then other files by name only, within `budget` characters. */
export function repoMap(root, { budget = 6000, maxFiles = 400, near = null } = {}) {
  // near: only files under these top-level folders (the task's area), for a short map
  const files = projectFiles(root).filter((f) => !SKIP.test(f) && !SECRET.test(f) && (!near?.length || near.includes(f.split('/')[0]))).slice(0, maxFiles);
  if (!files.length) return '';
  const lines = [];
  let used = 0;
  for (const f of files.filter((x) => CODE.test(x))) {
    let text = '';
    try { const st = fs.statSync(path.join(root, f)); if (st.size < 400_000) text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const syms = fileSymbols(text);
    const line = `${f}${syms.length ? `: ${syms.slice(0, 15).join(', ')}${syms.length > 15 ? ', …' : ''}` : ''}`;
    if (used + line.length > budget) { lines.push(`… (${files.length} files in all)`); return lines.join('\n'); }
    lines.push(line); used += line.length + 1;
  }
  const other = files.filter((x) => !CODE.test(x));
  if (other.length) {
    const line = `other files: ${other.join(', ')}`;
    lines.push(used + line.length > budget ? `other files: ${other.length} (not listed)` : line);
  }
  return lines.join('\n');
}

// ---------------- context pack (Q2) ----------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where the names defined in `files` are used elsewhere: [{ file, line, code, name }], capped. */
export function callersOf(root, files, { max = 40 } = {}) {
  const names = new Set();
  for (const f of files) {
    if (!CODE.test(f)) continue;
    let text = ''; try { const st = fs.statSync(path.join(root, f)); if (st.size < 400_000) text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const n of fileSymbols(text)) if (n.length >= 3) names.add(n);
  }
  if (!names.size) return [];
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-n', '-I', '--untracked', '-E', `(^|[^A-Za-z0-9_$])(${[...names].map(esc).join('|')})([^A-Za-z0-9_$]|$)`, '--', '.'],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 }).toString();
  } catch { return []; } // no matches exits 1
  const own = new Set(files.map((f) => f.replace(/^\.\//, '')));
  const hits = [];
  for (const l of out.split('\n')) {
    const m = l.match(/^([^:]+):(\d+):(.*)$/);
    if (!m || own.has(m[1]) || SKIP.test(m[1]) || SECRET.test(m[1]) || !CODE.test(m[1])) continue;
    const name = [...names].find((n) => new RegExp(`(^|[^\\w$])${esc(n)}([^\\w$]|$)`).test(m[3]));
    hits.push({ file: m[1], line: Number(m[2]), code: m[3].trim().slice(0, 160), name });
    if (hits.length >= max) break;
  }
  return hits;
}

/** Sections of docs/architecture.md that mention the task's files, folders or names (capped). */
export function architectureExcerpt(root, files, { budget = 3000 } = {}) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8'); } catch { return ''; }
  const keys = [...new Set(files.flatMap((f) => [f, path.posix.dirname(f), path.posix.basename(f).replace(/\.[^.]+$/, '')]).filter((k) => k && k !== '.' && k.length >= 3))];
  if (!keys.length) return '';
  const sections = text.split(/\n(?=#{1,4} )/);
  let out = '';
  for (const s of sections) {
    if (!keys.some((k) => s.includes(k))) continue;
    if (out.length + s.length > budget) { out += `\n(more in docs/architecture.md)`; break; }
    out += `${s.trim()}\n\n`;
  }
  return out.trim();
}

/**
 * Facts conductor gathers before a worker starts, so it doesn't have to guess or explore blind: the task's files,
 * who calls the code in them, how the work is checked, and the architecture notes that concern them.
 * kind 'agent': compact (paths and lines to open); kind 'chat': the same, plus caller code lines (it can't open files).
 */
export function contextPack(root, { files = [], verifyCmd = '', kind = 'agent', budget = 4000 } = {}) {
  const parts = [];
  if (verifyCmd) parts.push(`- **Verify** (must pass before DONE): \`${verifyCmd}\``);
  if (files.length) {
    const lines = files.map((f) => {
      let st = null; try { st = fs.statSync(path.join(root, f)); } catch { /* new */ }
      if (!st) return `  - \`${f}\`: new file`;
      if (!st.isFile()) return `  - \`${f}\``;
      let names = []; try { if (CODE.test(f) && st.size < 400_000) names = fileSymbols(fs.readFileSync(path.join(root, f), 'utf8')); } catch { /* unreadable */ }
      return `  - \`${f}\` (${st.size < 1024 ? `${st.size} B` : `${Math.round(st.size / 1024)} KB`})${names.length ? `: ${names.slice(0, 12).join(', ')}` : ''}`;
    });
    parts.push(`- **Task files:**\n${lines.join('\n')}`);
  }
  const callers = callersOf(root, files);
  if (callers.length) {
    if (kind === 'chat') {
      // a chat model can't open files: the code lines themselves, imports left out
      const isTest = (f) => /(^|\/)(tests?|__tests__)\/|[._-](test|spec)\./.test(f);
      const uses = callers.filter((c) => !/^\s*(import|export\s*\{|from\s|require\()/.test(c.code) && !/^\s*(const|let|var)\s*\{[^}]*\}\s*=\s*(require|await import)/.test(c.code))
        .sort((a, b) => isTest(a.file) - isTest(b.file)).slice(0, 12); // the code that uses it before its tests
      if (uses.length) parts.push(`- **Used elsewhere** (keep these working):\n${uses.map((c) => `  - \`${c.file}:${c.line}\`: \`${c.code}\``).join('\n')}`);
    } else {
      // an agent opens what it needs: one line per calling file, with each name's line numbers
      const byFile = new Map();
      for (const c of callers) { const m = byFile.get(c.file) || new Map(); m.set(c.name, [...(m.get(c.name) || []), c.line]); byFile.set(c.file, m); }
      parts.push(`- **Used elsewhere** (keep these working):\n${[...byFile].slice(0, 10).map(([f, m]) => `  - \`${f}\`: ${[...m].map(([n, ls]) => `${n}:${ls.slice(0, 4).join(',')}`).join(', ')}`).join('\n')}`);
    }
  }
  const arch = architectureExcerpt(root, files, { budget: Math.min(3000, budget) });
  if (arch) parts.push(kind === 'chat' ? `- **From docs/architecture.md:**\n${arch.split('\n').map((l) => `  ${l}`).join('\n')}` : `- **docs/architecture.md** has notes on these files: read the sections on ${[...new Set(files.map((f) => path.posix.dirname(f)).filter((d) => d !== '.'))].join(', ') || 'them'}`);
  if (kind === 'agent') {
    const near = [...new Set(files.map((f) => f.replace(/^\.\//, '').split('/')[0]).filter((d) => d && !d.includes('.')))];
    const map = near.length ? repoMap(root, { budget: Math.min(1500, budget), near }) : '';
    if (map) parts.push(`- **Project map** (files and the names they define):\n${map.split('\n').map((l) => `  ${l}`).join('\n')}`);
  }
  if (!parts.length) return '';
  let text = `\n## Context (gathered by conductor, so you don't have to search)\n${parts.join('\n')}\n`;
  if (text.length > budget) text = `${text.slice(0, budget)}\n… (cut to fit)\n`;
  return text;
}
