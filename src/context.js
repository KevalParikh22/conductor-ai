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
export function repoMap(root, { budget = 6000, maxFiles = 400 } = {}) {
  const files = projectFiles(root).filter((f) => !SKIP.test(f) && !SECRET.test(f)).slice(0, maxFiles);
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
