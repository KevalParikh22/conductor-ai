// H1: best of several cheap attempts. The research (repeated sampling, CodeMonkeys, S*): N cheap attempts picked by
// running checks beat one attempt, and picking by execution, not by a model's opinion, is what makes it work.
// Each attempt runs in its own worktree on a different provider and goes through every gate (verify, scope, edit
// guard, acceptance checks, repro). conductor then picks: done first, then the most acceptance checks and criteria
// met, then the smallest diff. The winner's changes land where a normal run's would; the others are removed.
import { execFileSync } from 'node:child_process';
import { removeWorktree } from './worktree.js';
import * as git from './git.js';

const RANK = { done: 0, unverified: 1, 'out-of-scope': 2, partial: 2, 'verify-failed': 3, failed: 4 };

function diffLines(root, s) {
  if (!s.worktree?.commit) return 0;
  try {
    const st = execFileSync('git', ['diff', '--shortstat', s.worktree.base, s.worktree.branch], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return [...st.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((t, m) => t + Number(m[1]), 0);
  } catch { return 0; }
}

/** Order attempts best first, by results only. */
export function rankSamples(rows) {
  return [...rows].sort((a, b) => (RANK[a.outcome] ?? 5) - (RANK[b.outcome] ?? 5)
    || (b.checksPassed - a.checksPassed) || (b.accMet - a.accMet) || (a.lines - b.lines));
}

/**
 * Run `n` attempts of one task in parallel and keep the best. deps: { dispatch (one attempt), chooseChain, section, UsageError }.
 */
export async function runSamples(cfg, opts, n, { dispatchOnce, chooseChain, section, body, files, UsageError }) {
  const { root, settings } = cfg;
  const picked = chooseChain(cfg, opts.role, { provider: opts.provider, chain: opts.chain, section, body, files });
  const ready = picked.chain.filter((c) => !c.skip).map((c) => c.name);
  if (ready.length < 2) {
    const s = await dispatchOnce(cfg, { ...opts, samples: 1 });
    s.warnings.push(`--samples ${n}: only ${ready.length} provider ready for ${opts.role}, so one attempt ran`);
    return s;
  }
  n = Math.min(n, ready.length);
  if (!opts.worktree) {
    // the winner's changes are applied to this checkout, so the usual safety rules for it apply up front
    const b = git.branch(root);
    if ((settings.protectedBranches || []).includes(b)) throw new UsageError(`on protected branch "${b}". Create a branch first: git switch -c feat/<name>`);
    if (git.isDirty(root) && !opts.allowDirty) throw new UsageError('working tree is dirty. Commit or stash first (the best attempt is applied to it)');
  }
  const base = (opts.taskId || opts.role).replace(/[^\w.-]/g, '');
  const ids = Array.from({ length: n }, (_, i) => `${base}-s${i + 1}`);
  // each attempt starts on a different provider, with the others as its fallback (like batch spreads tasks)
  const chains = ids.map((_, i) => [...ready.slice(i), ...ready.slice(0, i)]);
  const settled = await Promise.allSettled(ids.map((id, i) => dispatchOnce(cfg, {
    ...opts, samples: 1, provider: undefined, chain: chains[i], worktree: true, worktreeId: id, replace: true, noEscalate: true, noReview: true, // one review per task, not per attempt
    onEvent: opts.onEvent ? (e) => opts.onEvent({ ...e, sample: i + 1 }) : undefined,
  })));
  const ok = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw settled[0].reason; // e.g. the plan gate refused the task: same for every attempt
  const rows = ok.map((s) => ({
    s, provider: s.winner || s.attempts.at(-1)?.provider || '-', outcome: s.outcome, verify: s.verify?.status || null,
    checksPassed: s.checks?.passed || 0, checksTotal: s.checks?.total || 0, accMet: s.acceptance?.met || 0, lines: diffLines(root, s),
    branch: s.worktree?.branch, id: s.worktree?.id,
    tokens: s.attempts.reduce((t, a) => t + (a.tokens?.input || 0) + (a.tokens?.output || 0), 0),
    cost: s.attempts.reduce((t, a) => t + (a.cost || 0), 0),
  }));
  const ranked = rankSamples(rows);
  const best = ranked[0];
  const w = best.s;
  for (const r of rows) if (r !== best && r.id) removeWorktree(root, r.id, { force: true });
  w.samples = ranked.map((r) => ({ provider: r.provider, outcome: r.outcome, verify: r.verify, checks: r.checksTotal ? `${r.checksPassed}/${r.checksTotal}` : null, lines: r.lines, tokens: r.tokens, chosen: r === best }));
  // what all the attempts cost together, not just the one kept
  w.samplesCost = { tokens: rows.reduce((t, r) => t + r.tokens, 0), cost: rows.reduce((t, r) => t + r.cost, 0) };
  if (!opts.worktree && w.winner && w.worktree?.commit) {
    // land the best attempt in this checkout, uncommitted, as a normal run would leave it
    const patch = execFileSync('git', ['diff', '--binary', w.worktree.base, w.worktree.branch], { cwd: root, maxBuffer: 256 << 20 });
    if (patch.length) execFileSync('git', ['apply', '--whitespace=nowarn'], { cwd: root, input: patch, stdio: ['pipe', 'ignore', 'pipe'] });
    w.appliedFrom = w.worktree.branch;
    w.changed = git.changedFiles(root);
    removeWorktree(root, w.worktree.id, { force: true });
    delete w.worktree;
  } else if (!opts.worktree && best.id) {
    removeWorktree(root, best.id, { force: true });
    delete w.worktree;
  }
  return w;
}
