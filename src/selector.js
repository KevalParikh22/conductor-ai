// Smart selector: within a role's chain, try the provider that will do this task for the fewest tokens first.
// It never adds or removes providers; it only reorders the chain you configured, and says why in the summary.
//   - small tasks whose files are known (and reviews of small diffs) go to free API models first: they cost
//     nothing and get the files in the prompt;
//   - bigger or open-ended tasks go to agents first: they find and edit files themselves, instead of an API
//     model rewriting whole files blind;
//   - paid API models go after free ones and agents;
//   - a provider whose last 3 attempts all failed (not counting rate limits, which cooldowns handle) goes last.
import { readUsage } from './usage.js';
import { providerKind, providerLocation } from './config.js';

const LARGE_BODY = 3000; // characters of task text
const LARGE_FILES = 3;
const LARGE_DIFF = 40_000; // bytes

/** "small" or "large", with the reason. */
export function taskSize({ role, mode, body = '', files = [], diffBytes = 0 }) {
  if (role === 'review') return diffBytes > LARGE_DIFF ? { size: 'large', why: `${Math.round(diffBytes / 1000)}k diff` } : { size: 'small', why: 'small diff' };
  if (files.length >= LARGE_FILES) return { size: 'large', why: `${files.length} files` };
  if (body.length > LARGE_BODY) return { size: 'large', why: 'long task' };
  if (mode === 'write' && !files.length) return { size: 'large', why: 'files not listed, so it needs exploring' };
  if (role === 'ask' && !files.length) return { size: 'large', why: 'question about the codebase' };
  return { size: 'small', why: files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'short task' };
}

const isFree = (p) => !!p.free || providerLocation(p) === 'local-model';

/** Providers whose last 3 recorded attempts (last 24h) all failed for reasons other than rate limits. */
export function unhealthy(names, now = Date.now()) {
  const recent = readUsage(now - 24 * 3600_000);
  const out = new Map();
  for (const n of names) {
    const last = recent.filter((e) => e.provider === n).slice(-3);
    if (last.length === 3 && last.every((e) => !e.ok && e.reason !== 'quota' && !/cooldown|rate/i.test(e.reason || ''))) out.set(n, last.at(-1).reason);
  }
  return out;
}

/**
 * Reorder resolved chain entries ({ name, p, skip }) for this task. Skipped entries keep their place at the end.
 * Returns { chain, note } where note is '' when nothing moved.
 */
export function smartOrder(entries, task) {
  const live = entries.filter((e) => !e.skip);
  const { size, why } = taskSize(task);
  const cheapFirst = size === 'small';
  const bad = unhealthy(live.map((e) => e.name));
  const group = (e) => {
    const chat = providerKind(e.p) === 'chat';
    if (chat && isFree(e.p)) return cheapFirst ? 0 : 1;
    if (!chat) return cheapFirst ? 1 : 0;
    return 2; // paid or unknown-price API
  };
  const ranked = live.map((e, i) => ({ e, i, k: [bad.has(e.name) ? 1 : 0, group(e), i] }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]).map((x) => x.e);
  const chain = [...ranked, ...entries.filter((e) => e.skip)];
  const moved = ranked.some((e, i) => e !== live[i]);
  if (!moved) return { chain: entries, note: '' };
  const parts = [`${size} task (${why}): ${cheapFirst ? 'free API models first' : 'agents first'}`];
  if (bad.size) parts.push(`moved last: ${[...bad.keys()].join(', ')} (failed 3 times in a row)`);
  return { chain, note: parts.join('; ') };
}
