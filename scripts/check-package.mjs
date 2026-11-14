#!/usr/bin/env node
// V10: what `npm publish` would ship, checked. Every file must sit under an entry of package.json "files", and nothing
// that is for development only may slip in: tests, the benchmark, eval reference solutions, plans, conductor's own
// state, roadmaps, logs or secrets. test/package.test.js runs this, so CI fails before a bad package is published.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
export const DENY = [
  [/^test\//, 'tests'], [/^bench\//, 'the benchmark'], [/^evals\/[^/]+\/solution\//, 'eval reference solutions (only `eval check` uses them)'],
  [/(^|\/)docs\/plan\//, 'plans'], [/(^|\/)\.conductor\//, "conductor's own state"], [/^(ROADMAP|PRODUCT_PLAN|LAUNCH_PLAN|ALPHA_READINESS|UX_REVIEW|RELEASE_NOTES)/, 'internal planning notes'],
  [/(^|\/)node_modules\//, 'dependencies'], [/(^|\/)(\.env|secrets\.env|auth\.json)$|\.pem$|\.key$/, 'secrets'], [/\.log$/, 'logs'], [/(^|\/)scratch/, 'scratch files'],
];

export function packageFiles() {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

export function packageProblems(files, allowed) {
  const ok = (p) => p === 'package.json' || allowed.some((a) => p === a || p.startsWith(`${a}/`));
  const out = [];
  for (const p of files) {
    const bad = DENY.find(([re]) => re.test(p));
    if (bad) out.push(`${p}: ${bad[1]} must not be published`);
    else if (!ok(p)) out.push(`${p}: not under an entry of package.json "files"`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowed = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).files.filter((f) => !f.startsWith('!'));
  const files = packageFiles();
  const problems = packageProblems(files, allowed);
  console.log(problems.length ? `✗ the package would ship ${problems.length} file(s) it shouldn't:\n  ${problems.join('\n  ')}` : `✓ package: ${files.length} files, all allowed`);
  process.exit(problems.length ? 1 : 0);
}
