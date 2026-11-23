// Worker replies: file blocks, protected paths, trimmed reports and the evidence check (moved out of core.js unchanged, V12).
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import { expandBraces } from './plan.js';

// Files workers must never touch (agents are told; chat output is filtered).
// Case-insensitive: on macOS and Windows `agents.md` is the same file as `AGENTS.md`.
const PROTECTED = [/^AGENTS\.md$/i, /^CLAUDE\.md$/i, /^GEMINI\.md$/i, /^HANDOFF\.md$/i, /^docs\/plan\//i, /^\.claude\//i, /^\.gemini\//i, /^\.agents\//i,
  /^\.conductor-ai\//i, /^\.git\//i, /^\.husky\//i, /^\.githooks\//i, /^\.vscode\/mcp\.json$/i, /^\.mcp\.json$/i, /(^|\/)node_modules\//i, /(^|\/)\.env(\.|$)/i, /(^|\/)auth\.json$/i];
/** `extra`: regex strings from settings.protectedPaths (e.g. "^app/etc/env\\.php$"). */
export const isProtected = (p, extra = []) => {
  const norm = p.replaceAll('\\', '/');
  return PROTECTED.some((re) => re.test(norm)) || extra.some((src) => new RegExp(src, 'i').test(norm));
};

/**
 * The part of a worker's output the controller needs: from its RESULT/VERDICT line on (agents often print their
 * whole transcript before it), capped at maxBytes. Falls back to the end of the output.
 * Findings or notes the worker wrote before that line are kept too, and a bare "VERDICT: CHANGES_REQUESTED"
 * (or a PARTIAL/BLOCKED result) with nothing after it gets the end of the output before it.
 */
export function trimReport(text, maxBytes = 8000) {
  const at = text.search(/^#{0,4}\s*(RESULT|VERDICT):/m);
  let r = at > 0 ? text.slice(at) : text;
  if (at > 0) {
    const before = text.slice(0, at);
    const kept = [];
    for (const name of ['Findings', 'Notes']) {
      if (new RegExp(`^#{1,4}\\s*${name}\\b`, 'mi').test(r)) continue;
      const last = [...before.matchAll(new RegExp(`^#{1,4}\\s*${name}\\b[^\\n]*\\n[\\s\\S]*?(?=^#{1,2}\\s|(?![\\s\\S]))`, 'gmi'))].at(-1);
      if (last && last[0].trim().split('\n').length > 1) kept.push(last[0].trim());
    }
    if (kept.length) r = `${r.trimEnd()}\n\n${kept.join('\n\n')}\n`;
    else if (/CHANGES_REQUESTED|PARTIAL|BLOCKED|FAIL/i.test(r.split('\n')[0]) && r.trim().split('\n').length < 3) {
      r = `${r.trimEnd()}\n\n## Output before the verdict (last part; full output: report.full.md)\n${before.slice(-4000).trim()}\n`;
    }
  }
  if (r.length > maxBytes) r = at >= 0 ? r.slice(0, maxBytes) + `\n… [cut at ${maxBytes} characters; full output: report.full.md]\n` : `[… start cut; full output: report.full.md]\n` + r.slice(-maxBytes);
  return r;
}

// ---------------- chat-model file blocks ----------------
// <<<FILE path … FILE>>> is a whole file; <<<EDIT path … EDIT>>> holds SEARCH/REPLACE hunks for an existing file.
const HUNK = /^<<<<<<< SEARCH[ \t]*\r?\n([\s\S]*?)^=======[ \t]*\r?\n([\s\S]*?)^>>>>>>> REPLACE[ \t]*$/gm;
export function parseFileBlocks(text) {
  const blocks = [];
  const re = /^<<<(FILE|EDIT)[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)^\1>>>[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    let content = m[3];
    if (m[1] === 'EDIT') { // text around the hunks (a code fence, a comment) is ignored
      blocks.push({ path: m[2], edits: [...content.matchAll(HUNK)].map((h) => ({ search: h[1], replace: h[2] })), chars: m[0].length });
      continue;
    }
    // tolerate models that wrap the content in a code fence
    const fenced = content.match(/^```[\w.+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced) content = fenced[1] + '\n';
    blocks.push({ path: m[2], content });
  }
  return blocks;
}

/**
 * The file after every hunk, each matched exactly once against the text so far, or { error }. Matching ignores line
 * endings; lines outside a hunk keep theirs, and replaced lines take the ending of the first line they replace.
 */
export function applyEdits(text, edits) {
  if (!edits.length) return { error: 'EDIT block has no SEARCH/REPLACE hunks' };
  const lf = (s) => s.replaceAll('\r\n', '\n');
  const noEol = !text.endsWith('\n');
  let out = noEol ? text + (text.includes('\r\n') ? '\r\n' : '\n') : text; // so a SEARCH that ends on the last line still matches
  for (const [i, e] of edits.entries()) {
    const search = lf(e.search);
    if (!search.trim()) return { error: `SEARCH ${i + 1} is empty` };
    if (/^=======[ \t]*$/m.test(e.replace)) return { error: `hunk ${i + 1} has two ======= lines` }; // can't tell where SEARCH ends
    // the LF-only text, and for each of its characters where it starts in `out` (a \r\n maps to its \r)
    const map = [];
    for (let j = 0; j < out.length; j++) { map.push(j); if (out[j] === '\r' && out[j + 1] === '\n') j++; }
    map.push(out.length);
    const flat = lf(out);
    const at = flat.indexOf(search);
    if (at < 0) return { error: `SEARCH ${i + 1} not found` };
    if (flat.indexOf(search, at + 1) >= 0) return { error: `SEARCH ${i + 1} matches more than once` };
    const start = map[at], end = map[at + search.length], nl = out.indexOf('\n', start);
    const eol = nl > 0 && out[nl - 1] === '\r' ? '\r\n' : '\n';
    out = out.slice(0, start) + lf(e.replace).replaceAll('\n', eol) + out.slice(end);
  }
  if (noEol) out = out.replace(/\r?\n$/, '');
  return { text: out };
}

/**
 * Why writing `p` (relative to `root`) must be refused, or null. The real path is checked too, so a symlink in the
 * repo can't send the write outside it or onto a protected file.
 */
export function writeRefusal(root, p, extra = []) {
  const norm = path.normalize(p).replaceAll('\\', '/');
  const abs = path.resolve(root, norm);
  if (path.isAbsolute(p) || norm.startsWith('..') || !abs.startsWith(path.resolve(root) + path.sep)) return 'outside repo';
  if (isProtected(norm, extra)) return 'protected';
  // the nearest part of the path that exists, through its symlinks; the rest is created as plain folders and a file
  let at = abs; const rest = [];
  while (true) {
    try { fs.lstatSync(at); } catch { rest.unshift(path.basename(at)); at = path.dirname(at); continue; }
    try { at = fs.realpathSync(at); break; } catch { return 'symlink to a missing target'; } // a write would create it, anywhere
  }
  const real = path.relative(fs.realpathSync(root), path.join(at, ...rest));
  if (!real || /^\.\.([\\/]|$)/.test(real) || path.isAbsolute(real)) return 'outside repo (symlink)';
  return isProtected(real, extra) ? 'protected (symlink)' : null;
}

export function applyFileBlocks(root, blocks, extraProtected = []) {
  const applied = [], rejected = [], edits = [];
  for (const b of blocks) {
    const norm = path.normalize(b.path).replaceAll('\\', '/');
    const abs = path.resolve(root, norm);
    const why = writeRefusal(root, b.path, extraProtected);
    if (why) { rejected.push(`${b.path} (${why})`); continue; }
    if (b.edits) {
      let cur;
      try { cur = fs.readFileSync(abs, 'utf8'); } catch { rejected.push(`${b.path} (EDIT on a file that doesn't exist: send it as <<<FILE)`); continue; }
      const r = applyEdits(cur, b.edits);
      if (r.error) { rejected.push(`${b.path} (${r.error})`); continue; }
      fs.writeFileSync(abs, r.text);
      edits.push({ path: norm, hunks: b.edits.length, savedChars: Math.max(0, r.text.length - b.chars) });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, b.content);
    }
    applied.push(norm);
  }
  return { applied, rejected, edits };
}

/**
 * Paths a worker lists under "## Files changed" in its report, or null when the report has no such section.
 * Accepts "- path — summary", "- `path`: summary", "* path", "- `a.ts`, `b.ts`", markdown links
 * "[a.ts](file:///…/a.ts)", absolute paths (made relative to `roots`), "src/{a,b}.ts" and "a.ts:12".
 * Words that aren't paths ("No", "Tabs") are skipped unless they name a file in `known`.
 */
export function claimedFiles(report, { roots = [], known = [] } = {}) {
  const m = report.match(/^#{1,4}\s*Files changed\s*$([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/mi);
  if (!m) return null;
  const bases = [...new Set(roots.flatMap((r) => { try { return [r, fs.realpathSync(r)]; } catch { return [r]; } }))].map((r) => r.replace(/\/+$/, ''));
  const knownSet = new Set(known);
  const files = [];
  const clean = (raw) => {
    let p = decodeURIComponent(raw.trim()).replace(/^file:\/\//, '').replace(/^\*\*|\*\*$/g, '').replace(/[),.;:]+$/, '');
    p = p.replace(/#L?\d+(-L?\d+)?$/, '').replace(/:\d+(:\d+)?$/, '');
    if (path.isAbsolute(p)) {
      const base = bases.find((b) => p === b || p.startsWith(b + '/'));
      if (!base) return null; // outside the project
      p = p.slice(base.length + 1);
    }
    p = p.replace(/^\.\//, '');
    if (!p || /^\(?(none|nothing|n\/a)\)?\.?$/i.test(p)) return null;
    return p;
  };
  // a word with a dot is a file only with a real file extension: `Math.ceil` or `user.name` in a report is code, not a
  // path (a top-level file with an unusual extension still counts when it exists)
  const FILE_EXT = /\.(m?[jt]sx?|c[jt]s|json5?|md|mdx|txt|py|pyi|php|go|rb|java|kt|kts|rs|cs|swift|c|cc|cpp|h|hpp|m|mm|scala|sh|bash|zsh|ps1|sql|css|scss|sass|less|html?|vue|svelte|astro|xml|ya?ml|toml|ini|cfg|conf|env|lock|gradle|properties|csv|tsv|graphql|gql|proto|tf|dart|ex|exs|erl|hs|lua|pl|r|jl|zig|nim|snap|svg|png|jpe?g|gif|webp|ico|pdf|wasm|map|d\.ts)$/i;
  const exists = (p) => bases.some((b) => { try { return fs.existsSync(path.join(b, p)); } catch { return false; } });
  const looksLikePath = (p) => knownSet.has(p) || /\//.test(p) || FILE_EXT.test(p) || /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|LICENSE|README)$/.test(p) || (/\.[A-Za-z0-9_-]{1,10}$/.test(p) && exists(p));
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item) continue;
    const text = item[1];
    let raw = [...text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((l) => (/^https?:/.test(l[2]) ? l[1] : l[2]));
    if (!raw.length) raw = [...text.matchAll(/`([^`]+)`/g)].map((b) => b[1]).filter((b) => !/\s/.test(b.trim()));
    if (!raw.length) raw = [text.trim().split(/\s+/)[0]];
    // a backticked or linked path list may be followed by prose; only the first group of paths counts
    for (const r of raw) {
      for (const one of expandBraces(r.replace(/^\*\*|\*\*$/g, ''))) {
        const p = clean(one);
        if (p && looksLikePath(p) && !files.includes(p)) files.push(p);
      }
    }
  }
  return files;
}

/**
 * Evidence check: does the worker's report match what git shows? Claims are not trusted on their own.
 * Returns warnings plus the details for the summary.
 */
export function checkEvidence(report, changed, status, preDirty = new Set(), roots = []) {
  const claimed = claimedFiles(report, { roots, known: changed });
  const actual = new Set(changed);
  const warnings = [];
  if (/RESULT:\s*DONE/i.test(status || '') && !changed.length) warnings.push('the worker reports DONE but changed no files');
  changed = changed.filter((f) => !preDirty.has(f)); // their changes may be from before the run
  if (!claimed) return { claimed: null, notChanged: [], notReported: [], warnings };
  const claimedSet = new Set(claimed);
  const notChanged = claimed.filter((f) => !actual.has(f) && !changed.some((c) => c.startsWith(f.replace(/\/?$/, '/'))));
  const notReported = changed.filter((f) => !claimedSet.has(f) && ![...claimedSet].some((c) => f.startsWith(c.replace(/\/?$/, '/'))));
  if (notChanged.length) warnings.push(`the worker says it changed ${notChanged.join(', ')}, but git shows no change there`);
  if (notReported.length) warnings.push(`changed but not listed in the worker's report: ${notReported.join(', ')}`);
  return { claimed, notChanged, notReported, warnings };
}
