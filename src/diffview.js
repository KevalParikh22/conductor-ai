// Compact diffs: what the controller (and review workers) read instead of raw `git diff`.
// Whitespace-only changes, lockfiles, build output and source maps are left out (listed, not shown), context is
// 2 lines, and very long files are cut. The full diff stays one `git diff` away.
import * as git from './git.js';

// generated or vendored: listed with their line counts, never shown
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|out|vendor|node_modules|coverage|\.next)\//;
const ARGS = ['-w', '-U2', '--find-renames'];

function splitFiles(raw) {
  return raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git')).map((chunk) => {
    const m = chunk.match(/^\+\+\+ b\/(.+)$/m) || chunk.match(/^--- a\/(.+)$/m) || chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    const lines = chunk.split('\n');
    const add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return { path: m ? m[1].trim() : '?', chunk, add, del, binary: /^Binary files /m.test(chunk), isNew: /^new file mode/m.test(chunk) || /^--- \/dev\/null/m.test(chunk) };
  });
}

/**
 * opts: { range } for `git diff <range>` (e.g. "HEAD...conductor/T3"), or { base } for the working tree against
 * a commit plus untracked files (default base HEAD). maxFileLines caps each file's shown lines.
 */
export function compactDiff(root, { range, base = 'HEAD', maxFileLines = 200 } = {}) {
  let files, full = 0;
  if (range) {
    files = splitFiles(git.diffRaw(root, [...ARGS, range]));
    full = git.diffRaw(root, [range]).length;
  } else {
    files = splitFiles(git.diffRaw(root, [...ARGS, base]));
    full = git.diffRaw(root, [base]).length;
    for (const f of git.untracked(root)) {
      const d = git.diffRaw(root, ['-U2', '--no-index', '--', '/dev/null', f]);
      full += d.length;
      files.push(...splitFiles(d).map((x) => ({ ...x, path: f, isNew: true })));
    }
  }
  const hidden = files.filter((f) => NOISE.test(f.path));
  const shown = files.filter((f) => !NOISE.test(f.path));
  const out = [];
  for (const f of shown) {
    if (f.binary) { out.push(`diff --git ${f.path} (binary file changed)\n`); continue; }
    const lines = f.chunk.replace(/\n$/, '').split('\n');
    if (lines.length > maxFileLines) out.push(lines.slice(0, maxFileLines).join('\n') + `\n… ${lines.length - maxFileLines} more lines in ${f.path} (git diff -- ${f.path})\n`);
    else out.push(lines.join('\n') + '\n');
  }
  const add = files.reduce((t, f) => t + f.add, 0), del = files.reduce((t, f) => t + f.del, 0);
  const body = out.join('');
  const head = [`${files.length} file${files.length === 1 ? '' : 's'} changed, +${add} -${del}${range ? ` (${range})` : ` (working tree vs ${base}${files.some((f) => f.isNew) ? ', new files included' : ''})`}`];
  for (const f of shown) head.push(`  ${f.isNew ? 'A' : 'M'} ${f.path}  +${f.add} -${f.del}`);
  if (hidden.length) head.push(`  hidden (generated/lockfiles): ${hidden.map((f) => `${f.path} +${f.add} -${f.del}`).join(', ')}`);
  const text = `${head.join('\n')}\n\n${body}`;
  return { text, files: files.length, hidden: hidden.map((f) => f.path), chars: text.length, fullChars: full, empty: !files.length };
}
