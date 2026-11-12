// H11: run the acceptance criteria. Lines like
//     `slugify('alpha beta gamma', { maxLength: 12 })` returns `'alpha-beta'`
//     `parseDuration('10')` and `parseDuration('1m30')` throw SyntaxError
//     `retry(f, { attempts: 0 })` rejects with RangeError
// become a small test conductor writes and runs itself after the worker: no model involved, so a confident but wrong
// "[x]" can't pass. Anything it can't run safely (prose, helpers the plan never defines) is skipped, never guessed.
// JavaScript first: the task's files are imported as ES modules (CommonJS exports work through Node's interop).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { run } from './util.js';

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'new', 'typeof', 'void', 'NaN', 'Infinity', 'this', 'in', 'of', 'instanceof',
  'async', 'await', 'function', 'return']);

// `expr` (and `expr`) returns|return|throws|throw|rejects [with] VALUE — VALUE in backticks or a bare literal/name
const CLAUSE = /((?:`[^`\n]+`\s*(?:,|and)?\s*)+?)\s*\b(returns?|throws?|rejects(?:\s+with)?)\s+(?:exactly\s+)?(`[^`\n]+`|-?\d+(?:\.\d+)?\b|true\b|false\b|null\b|undefined\b|[A-Z]\w*(?:Error|Exception)\b|'[^'\n]*'|"[^"\n]*")/g;

const strip = (s) => s.replace(/^`|`$/g, '');
const parses = (code) => { try { new Function(`return (${code});`); return true; } catch { return false; } }; // eslint-disable-line no-new-func

/** Free identifiers in an expression: not in strings, not a property (.x) or an object key (x:). */
export function freeNames(expr) {
  const bare = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const out = new Set();
  for (const m of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g)) if (!KEYWORDS.has(m[1])) out.add(m[1]);
  return [...out];
}

/** The checks in a task's criteria: [{ n (criterion number), criterion, kind: returns|throws|rejects, expr, expected }]. */
export function parseChecks(criteria) {
  const out = [];
  criteria.forEach((criterion, idx) => {
    for (const m of criterion.matchAll(CLAUSE)) {
      const exprs = [...m[1].matchAll(/`([^`\n]+)`/g)].map((x) => x[1].trim());
      const verb = m[2].startsWith('return') ? 'returns' : m[2].startsWith('throw') ? 'throws' : 'rejects';
      const expected = strip(m[3]).trim();
      for (const expr of exprs) {
        if (!/[(]/.test(expr) || !parses(expr)) continue; // a call or construction, valid JS
        if (verb === 'returns' && !parses(expected)) continue;
        if (verb !== 'returns' && !/^[A-Z]\w*$/.test(expected)) continue;
        out.push({ n: idx + 1, criterion, kind: verb, expr, expected });
      }
    }
  });
  return out;
}

const DEF = (n) => new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b|(?:module\\.)?exports\\.${n}\\s*=|module\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b`);

/** Which file exports each name: the task's own files first, then the rest of the project (JS only). */
function findExports(work, names, taskFiles) {
  let all = [];
  try { all = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 }).toString().split('\n').filter(Boolean); } catch { /* not a repo */ }
  const js = (f) => /\.(m?js|cjs)$/.test(f) && !/(^|\/)(node_modules|dist|build|coverage)\//.test(f) && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?js$/.test(f);
  const order = [...new Set([...taskFiles.filter(js), ...all.filter(js)])];
  const where = {};
  for (const f of order) {
    const left = names.filter((n) => !where[n]);
    if (!left.length) break;
    let text; try { text = fs.readFileSync(path.join(work, f), 'utf8'); } catch { continue; }
    for (const n of left) if (text.includes(n) && DEF(n).test(text)) where[n] = f;
  }
  return where;
}

/**
 * Turn the criteria into a script, run it in the worker's folder, and report each check.
 * → { total, passed, failed: [{ n, expr, kind, expected, got }], skipped: [{ expr, why }] } or null when nothing to check.
 */
export async function runAcceptanceChecks(work, criteria, taskFiles, { dir, timeoutMs = 30_000 } = {}) {
  const checks = parseChecks(criteria);
  if (!checks.length) return null;
  const skipped = [];
  const names = [...new Set(checks.flatMap((c) => freeNames(c.expr)))].filter((n) => !(n in globalThis));
  const where = findExports(work, names, taskFiles);
  const runnable = checks.filter((c) => {
    const unknown = freeNames(c.expr).filter((n) => !(n in globalThis) && !where[n]);
    // a name the plan uses but no file exports: a missing export when the task is about it, else a test helper
    if (unknown.length) { skipped.push({ expr: c.expr, why: `nothing exports ${unknown.join(', ')}` }); return false; }
    return true;
  });
  // a criterion that names a function the project doesn't export is a failure, not a skip, when that function is
  // the subject of the check (it's called directly): "slugify(...)" with no exported slugify
  const failed = [];
  for (const s of [...skipped]) {
    const called = (s.expr.match(/^(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
    if (called && s.why.includes(called) && freeNames(s.expr).filter((n) => !(n in globalThis) && !where[n]).length === 1) {
      const c = checks.find((x) => x.expr === s.expr);
      failed.push({ n: c.n, expr: c.expr, kind: c.kind, expected: c.expected, got: `${called} is not exported from any file` });
      skipped.splice(skipped.indexOf(s), 1);
    }
  }
  if (!runnable.length) return { total: failed.length, passed: 0, failed, skipped };
  const mods = [...new Set(runnable.flatMap((c) => freeNames(c.expr)).map((n) => where[n]).filter(Boolean))];
  const lines = [
    // conductor's own names are prefixed, so a project function called check, show or inspect can't collide
    "import * as __cdUtil from 'node:util';",
    ...mods.map((f, i) => `import * as __cdM${i} from ${JSON.stringify(pathToFileURL(path.join(fs.realpathSync(work), f)).href)};`),
    ...Object.entries(where).filter(([, f]) => mods.includes(f)).map(([n, f]) => `const ${n} = __cdM${mods.indexOf(f)}.${n} ?? __cdM${mods.indexOf(f)}.default?.${n};`),
    'const __cdOut = [];',
    'const __cdShow = (v) => __cdUtil.inspect(v, { depth: 4, breakLength: Infinity }).slice(0, 300);',
    'async function __cdCheck(i, kind, fn, expected, errName) {',
    '  try {',
    '    let v = fn();',
    "    if (kind === 'rejects') { if (!v || typeof v.then !== 'function') { __cdOut.push({ i, ok: false, got: `returned ${__cdShow(v)}, not a promise` }); return; } }",
    "    if (v && typeof v.then === 'function') v = await v;",
    "    if (kind === 'returns') { const e = expected(); __cdOut.push({ i, ok: __cdUtil.isDeepStrictEqual(v, e), got: `returned ${__cdShow(v)}` }); }",
    '    else __cdOut.push({ i, ok: false, got: `returned ${__cdShow(v)} instead of failing` });',
    '  } catch (e) {',
    "    if (kind === 'returns') __cdOut.push({ i, ok: false, got: `threw ${e?.name}: ${String(e?.message).slice(0, 200)}` });",
    "    else __cdOut.push({ i, ok: e?.name === errName || (typeof globalThis[errName] === 'function' && e instanceof globalThis[errName]), got: `threw ${e?.name}: ${String(e?.message).slice(0, 200)}` });",
    '  }',
    '}',
    ...runnable.map((c, i) => `await __cdCheck(${i}, ${JSON.stringify(c.kind)}, () => (${c.expr}), ${c.kind === 'returns' ? `() => (${c.expected})` : 'null'}, ${JSON.stringify(c.kind === 'returns' ? '' : c.expected)});`),
    "console.log('__CONDUCTOR_CHECKS__' + JSON.stringify(__cdOut));",
  ];
  const file = path.join(dir || work, `acceptance-checks-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = await run(process.execPath, [file], { cwd: work, timeoutMs, env });
  if (!dir) fs.rmSync(file, { force: true });
  const m = r.stdout.match(/__CONDUCTOR_CHECKS__(.*)$/m);
  let results = null; try { results = m && JSON.parse(m[1]); } catch { /* bad output */ }
  if (!results) {
    // the script itself failed: a file that won't load, or a check that hangs
    const why = r.timedOut ? `the checks did not finish in ${Math.round(timeoutMs / 1000)}s` : (r.stderr.split('\n').find((l) => /Error/.test(l)) || r.stderr.trim().split('\n')[0] || `exit ${r.code}`).slice(0, 300);
    for (const c of runnable) failed.push({ n: c.n, expr: c.expr, kind: c.kind, expected: c.expected, got: why });
    return { total: failed.length, passed: 0, failed, skipped };
  }
  for (const x of results) if (!x.ok) { const c = runnable[x.i]; failed.push({ n: c.n, expr: c.expr, kind: c.kind, expected: c.expected, got: x.got }); }
  const total = runnable.length + failed.filter((f) => !runnable.some((c) => c.expr === f.expr)).length;
  return { total, passed: results.filter((x) => x.ok).length, failed, skipped };
}

/** The failed checks as fix instructions (H3 style). */
export function checksBrief(ch) {
  if (!ch?.failed?.length) return '';
  return `Acceptance checks that fail when run:\n${ch.failed.map((f) => `- criterion ${f.n}: \`${f.expr}\` should ${f.kind === 'returns' ? `return \`${f.expected}\`` : `${f.kind === 'rejects' ? 'reject with' : 'throw'} ${f.expected}`}, but ${f.got}`).join('\n')}`;
}
