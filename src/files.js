// Worker replies: file blocks, protected paths, trimmed reports and the evidence check (moved out of core.js unchanged, V12).
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import { expandBraces } from './plan.js';

// Files workers must never touch (agents are told; chat output is filtered).
const PROTECTED = [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^GEMINI\.md$/, /^HANDOFF\.md$/, /^docs\/plan\//, /^\.claude\//, /^\.gemini\//, /^\.agents\//,
  /^\.conductor\//, /^\.git\//, /^\.husky\//, /^\.githooks\//, /^\.vscode\/mcp\.json$/, /^\.mcp\.json$/, /(^|\/)node_modules\//, /(^|\/)\.env(\.|$)/, /(^|\/)auth\.json$/];
/** `extra`: regex strings from settings.protectedPaths (e.g. "^app/etc/env\\.php$"). */
export const isProtected = (p, extra = []) => {
  const norm = p.replaceAll('\\', '/');
  return PROTECTED.some((re) => re.test(norm)) || extra.some((src) => new RegExp(src).test(norm));
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
export function parseFileBlocks(text) {
  const blocks = [];
  const re = /^<<<FILE[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)^FILE>>>[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    let content = m[2];
    // tolerate models that wrap the content in a code fence
    const fenced = content.match(/^```[\w.+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced) content = fenced[1] + '\n';
    blocks.push({ path: m[1], content });
  }
  return blocks;
}

export function applyFileBlocks(root, blocks, extraProtected = []) {
  const applied = [], rejected = [];
  for (const b of blocks) {
    const norm = path.normalize(b.path).replaceAll('\\', '/');
    const abs = path.resolve(root, norm);
    if (path.isAbsolute(b.path) || norm.startsWith('..') || !abs.startsWith(path.resolve(root) + path.sep)) { rejected.push(`${b.path} (outside repo)`); continue; }
    if (isProtected(norm, extraProtected)) { rejected.push(`${b.path} (protected)`); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, b.content);
    applied.push(norm);
  }
  return { applied, rejected };
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
