// The run summary the controller reads (moved out of core.js unchanged, V12).
import * as git from './git.js';
import { fixLines } from './nextsteps.js';
import { outcome } from './outcome.js';

export function formatSummary(s) {
  const L = [];
  L.push('', '==================== CONDUCTOR RESULT ====================');
  L.push(`role:      ${s.role}${s.task ? `   task: ${s.task}` : ''}${s.plan ? `   plan: ${s.plan}` : ''}`);
  if (s.worktree) L.push(`worktree:  ${s.worktree.branch}${s.worktree.removed ? ' (removed: nothing to keep)' : `  ${s.worktree.dir}`}`);
  if (s.route) L.push(`route:     ${s.route}`);
  if (s.selector) L.push(`selector:  ${s.selector}`);
  if (s.skills?.length) L.push(`skills:    ${s.skills.join(', ')}`);
  if (s.lessons?.length) L.push(`lessons:   ${s.lessons.length} from earlier work here were in the prompt (conductor lessons)`);
  if (s.lessonsResolved) L.push(`lessons:   ${s.winner} passed this kind of work here, so ${s.lessonsResolved} earlier failure(s) of its no longer move it back`);
  for (const l of s.promotable || []) L.push(`promote?:  seen ${l.count}×: "${String(l.text).slice(0, 100)}" → make it a rule: conductor lessons promote ${l.id}`);
  if (s.lessonsDemoted?.length) L.push(`order:     moved to the back: ${s.lessonsDemoted.join(', ')} (failed this kind of work here before)`);
  const multi = (n) => s.attempts.filter((a) => a.provider === n).length > 1; // show models only where a provider switched model
  L.push(`attempts:  ${s.attempts.map((a) => `${a.provider}${a.model && multi(a.provider) ? `[${a.model}]` : ''}(${a.reason}${a.stashed ? ', stashed' : ''})`).join(' → ') || '(none)'}`);
  if (!s.winner) {
    L.push('worker:    NONE. Every provider failed or was skipped (exit 3).');
    if (s.worktree?.continued) L.push(`kept:      the earlier work is still on ${s.worktree.branch}; failed attempts were stashed there`);
    for (const f of fixLines(s.attempts)) L.push(`fix:       ${f}`);
    L.push('next:      orchestrator does this task itself, or fixes a provider above and runs it again');
    return L.join('\n');
  }
  L.push(`worker:    ${s.winner} (${s.model})`);
  const used = s.attempts.filter((a) => a.tokens);
  if (used.length) {
    const tin = used.reduce((t, a) => t + (a.tokens.input || 0), 0), tout = used.reduce((t, a) => t + (a.tokens.output || 0), 0);
    const known = used.filter((a) => a.cost != null), cost = known.reduce((t, a) => t + a.cost, 0);
    L.push(`usage:     ${tin} tokens in / ${tout} out${known.length ? ` · $${cost.toFixed(4)}` : ' · cost unknown (no price set)'}`);
  }
  L.push(`report:    ${s.report}`);
  L.push(`status:    ${s.status || '(no RESULT/VERDICT line, so read the report)'}`);
  const out = outcome(s);
  const acc = s.acceptance;
  const accShort = acc && !acc.waived && (!acc.answered || acc.met < acc.total);
  const chFail = s.checks?.failed?.length;
  const rp = s.repro;
  if (out === 'partial' && !chFail && rp?.ok === false) L.push(`outcome:   PARTIAL. ${rp.cmd ? `The bug still reproduces: \`${rp.cmd}\` still fails` : rp.why === 'no regression test added' ? 'The fix has no regression test' : 'The new test also passes on the original code, so it doesn\'t prove the fix'}`);
  else if (out === 'partial' && chFail) L.push(`outcome:   PARTIAL. ${chFail} acceptance check(s) fail when conductor runs them: see "checks" below`);
  else if (out === 'partial') L.push(accShort && !/RESULT:\s*\**\s*(PARTIAL|BLOCKED|FAILED|FAIL)\b/i.test(s.status || '')
    ? `outcome:   PARTIAL. ${acc.answered ? `Only ${acc.met} of ${acc.total} acceptance criteria are met with evidence` : 'The worker reports DONE but did not answer the acceptance criteria'}: check them, then finish or retry with --note`
    : 'outcome:   PARTIAL. The worker says it did only part of the task: read the report, then finish it or retry the rest');
  if (acc) L.push(`acceptance: ${acc.met}/${acc.total} met with evidence${acc.waived ? ' (not required)' : ''}${acc.unmet.length ? `; not met: ${acc.unmet.slice(0, 4).join(' | ')}` : ''}`);
  if (out === 'verify-failed' && s.verify?.suspectTests?.length) L.push(`outcome:   NOT DONE, but the code looks right: it passes every earlier test and every acceptance check. Only the worker's own tests fail (${s.verify.suspectTests.join(', ')}): check those tests first`);
  else if (out === 'verify-failed') L.push(s.verify?.baseFailed
    ? `outcome:   NOT PROVEN. Verify already failed before the worker started, so it can't prove this work. ${s.verify.newFailures?.length ? `${s.verify.newFailures.length} failure line(s) are new: check them first` : 'No new failure lines: the worker probably added no new failures'}`
    : 'outcome:   NOT DONE. The worker finished but verify fails: fix it, or retry with --note "<what failed>"');
  if (out === 'out-of-scope') L.push(`outcome:   OUT OF SCOPE. The worker changed files the task doesn't list: ${s.scope.outside.join(', ')}. Check them in the diff: if they're needed, accept the work (and list them next time); if not, revert them or retry with --note`);
  if (out === 'unverified') L.push(s.verify?.chosen
    ? 'outcome:   UNVERIFIED. Verify was skipped, so nothing proves this works: check it yourself before committing'
    : 'outcome:   UNVERIFIED (exit 4). No verify command, so nothing proves this works. Set one: conductor init --verify "<cmd>" (or the Verify line in AGENTS.md), then run conductor verify');
  if (s.applied.length) L.push(`applied:   ${s.applied.join(', ')}`);
  if (s.rejected.length) L.push(`rejected:  ${s.rejected.join(', ')}`);
  if (s.mode === 'write') L.push(`changed:   ${s.changed.join(', ') || '(nothing)'}`);
  if (s.base) L.push(`base:      verify ${s.base.status} on the starting commit ${s.base.head}${s.base.cached ? ' (cached)' : ''}${s.base.status === 'FAIL' ? `, log: ${s.base.log}` : ''}`);
  if (s.scope?.outside?.length) L.push(`scope:     outside the task's files: ${s.scope.outside.join(', ')}${s.scope.allowed ? ' (allowed)' : ''}`);
  if (s.verify?.newFailures?.length) L.push(`new fails: ${s.verify.newFailures.slice(0, 5).join(' | ')}`);
  const tm = s.timings || {}, workerSec = Math.round((s.attempts || []).reduce((t, a) => t + (a.seconds || 0), 0));
  if (Object.keys(tm).length || workerSec) L.push(`time:      workers ${workerSec}s${Object.entries(tm).map(([k, v]) => ` · ${k} ${v}s`).join('')}`);
  if (s.race) L.push(`race:      ${s.race.winner ? `${s.race.winner} passed every check first (${s.race.seconds}s)` : 'no attempt passed every check, so the best one was kept'}${s.race.stopped.length ? `; stopped: ${s.race.stopped.join(', ')}` : ''}`);
  if (s.samples?.length) L.push(`samples:   ${s.samples.length} attempts, best kept: ${s.samples.map((x) => `${x.provider} ${x.outcome}${x.checks ? ` checks ${x.checks}` : ''}${x.lines ? ` ${x.lines} lines` : ''}${x.chosen ? ' ← chosen' : ''}`).join(' · ')}`);
  if (s.appliedFrom) L.push(`landed:    the chosen attempt's changes are in your working tree (from ${s.appliedFrom}, now removed)`);
  if (s.escalated?.length) L.push(`handed on: ${s.escalated.map((e) => `${e.from}'s work failed ${[e.verify === 'FAIL' && 'verify', e.checksFailed && 'acceptance checks'].filter(Boolean).join(' and ')}`).join(', then ')} → ${s.winner} took it over`);
  if (s.verify) L.push(`verify:    ${s.verify.status}${s.verify.scope === 'task' ? ' [task verify]' : ''}${s.verify.cmd ? ` (${s.verify.cmd})` : ''}${s.verify.status === 'FAIL' ? `, log: ${s.verify.log}` : ''}${s.verify.note ? `, ${s.verify.note}` : ''}`);
  if (rp) L.push(`repro:     ${rp.cmd ? `\`${rp.cmd}\` ${rp.before || '?'} before${rp.after ? `, ${rp.after} after` : ''}` : rp.tests ? `regression test ${rp.tests.join(', ')}: ${rp.proof === 'proved' ? 'fails on the original code (proves the bug)' : rp.proof === 'not-proved' ? 'also passes on the original code (proves nothing)' : `couldn't check: ${rp.why}`}` : rp.why}${rp.waived ? ' (not required)' : ''}`);
  if (s.checks) {
    L.push(`checks:    ${s.checks.passed}/${s.checks.total} acceptance checks pass when run${s.checks.skipped?.length ? ` (${s.checks.skipped.length} skipped: ${s.checks.skipped.map((x) => x.why).join('; ')})` : ''}`);
    for (const f of s.checks.failed.slice(0, 5)) L.push(`           ✗ ${f.expr} → ${f.got} (expected ${f.kind === 'returns' ? f.expected : `${f.kind === 'rejects' ? 'rejection with' : ''} ${f.expected}`.trim()})`);
    if (s.verify?.status === 'FAIL' && !s.checks.failed.length && !s.verify.suspectTests) L.push('hint:      every acceptance check passes, so the failing test may itself be wrong');
  }
  if (s.verify?.status === 'FAIL' && s.verify.brief) L.push(`why:       ${s.verify.brief.split('\n').slice(1, -1).join('\n           ')}`);
  const rv = s.review;
  if (rv?.skipped) L.push(`review:    not done (${rv.skipped}); it was due: ${rv.reasons.join('; ')}`);
  else if (rv) {
    L.push(`review:    ${rv.reviewer} (${rv.family}, the worker is ${rv.workerFamily}) because ${rv.reasons.join('; ')}: ${rv.verdict || 'no verdict'}, ${rv.findings.length} finding(s) on changed lines${rv.dropped ? ` (${rv.dropped} dropped: not on a changed line)` : ''}. Advisory: triage before committing; report ${rv.report}`);
    for (const f of rv.findings.slice(0, 6)) L.push(`           ${f.severity === 'high' || f.severity === 'critical' ? '!' : '·'} [${f.severity}${f.confidence === 'low' ? ', low confidence' : ''}] ${f.file}:${f.line} ${f.text.split('\n')[0].replace(/^`?[\w./@-]+:\d+`?:?\s*/, '').slice(0, 140)}`);
  }
  if (s.saved) L.push(`saved:     ${s.saved}`);
  if (s.tokensSaved?.tokens) L.push(`context:   ~${s.tokensSaved.tokens.toLocaleString()} tokens kept out (estimate: ${Object.entries(s.tokensSaved).filter(([k]) => k !== 'tokens').map(([k, n]) => `${{ report: 'report trimmed', 'review-diff': 'compact review diff', 'free-model': 'free model chosen' }[k] || k} ~${n.toLocaleString()}`).join(', ')})`);
  if (s.worktree?.commit) L.push(`commit:    ${s.worktree.commit} on ${s.worktree.branch} (from ${s.worktree.base})`);
  for (const w of s.warnings) L.push(`WARNING:   ${w}`);
  for (const f of fixLines(s.attempts, { won: true })) L.push(`fix:       ${f}`);
  if (s.worktree) {
    L.push(s.worktree.commit
      ? `next:      orchestrator reviews \`conductor diff ${s.worktree.branch}\`, then \`git merge --no-ff ${s.worktree.branch}\` and \`conductor worktree rm ${s.worktree.id}\` (or rm --force to reject)`
      : s.worktree.continued
        ? `next:      nothing new this time; the earlier work is still on ${s.worktree.branch}. Retry with another note or provider, or merge it as it is`
        : `next:      the worker changed nothing; \`conductor worktree rm ${s.worktree.id}\``);
    return L.join('\n');
  }
  L.push(s.mode === 'write'
    ? 'next:      orchestrator checks `conductor diff`, then commits, or retries with --provider <other> --note "<what was wrong>"'
    : 'next:      orchestrator reads the report and triages it. Workers can be wrong.');
  return L.join('\n');
}
