// A run's outcome: done only with proof (moved out of core.js unchanged, V12).


/**
 * How a finished run ended: 'done', 'partial' (the worker says it did only part: RESULT PARTIAL / BLOCKED /
 * FAILED), 'verify-failed' (it finished but the checks fail), 'out-of-scope' (it changed files the task doesn't
 * list), 'unverified' (it wrote code but no verify ran, so
 * nothing proves it works) or 'failed' (no provider finished).
 */
/** Exit code 5: the run waits for your answer from a web chat (W1: conductor import <run> <file>). */
export const EXIT_WAITING = 5;

export function outcome(s) {
  // W1: a manual run waits for your answer, then points at the run that imported it
  if (!s?.winner && s?.waiting) return s.importedAs ? 'answered' : 'waiting';
  if (!s?.winner) return 'failed';
  if (s.verify?.status === 'FAIL') return 'verify-failed';
  if (/RESULT:\s*\**\s*(PARTIAL|BLOCKED|FAILED|FAIL)\b/i.test(s.status || '')) return 'partial';
  // H11: an acceptance criterion that fails when conductor runs it, whatever the worker said
  if (s.checks?.failed?.length) return 'partial';
  // Q4: a fix that doesn't make the repro pass, or a regression test that doesn't fail on the old code
  if (s.repro?.ok === false && !s.repro.waived) return 'partial';
  // H5: DONE, but not every acceptance criterion answered with evidence
  const a = s.acceptance;
  if (a && !a.waived && (!a.answered || a.met < a.total)) return 'partial';
  if (s.scope?.outside?.length && !s.scope.allowed) return 'out-of-scope';
  // no proof, no "done": code a worker wrote counts as done only when verify ran and passed
  if (isWriteRun(s) && s.verify?.status !== 'PASS') return 'unverified';
  return 'done';
}

const WRITE_ROLES = new Set(['build', 'fix', 'test', 'docs']);
const isWriteRun = (s) => (s.mode ? s.mode === 'write' : WRITE_ROLES.has(s.role));

/** Exit code 4: a worker finished but nothing proved its work (no verify command), and the caller didn't choose that. */
export const EXIT_UNVERIFIED = 4;
export function unverifiedBlocks(s, { allowUnverified = false } = {}) {
  return outcome(s) === 'unverified' && !allowUnverified && !s.verify?.chosen;
}
