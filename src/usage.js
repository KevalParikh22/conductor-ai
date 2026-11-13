// Usage and cost: every provider attempt is appended to ~/.config/conductor/usage.jsonl, so you can see
// where work went and cap paid spend per day. Cost is only known for API providers that report tokens and
// have a `price` set ({ "input": $ per 1M tokens, "output": $ per 1M tokens }); free providers cost 0.
import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_DIR } from './util.js';

export const USAGE_FILE = () => path.join(GLOBAL_DIR, 'usage.jsonl');

/** Dollar cost of one call, or null when unknown (no tokens reported or no price set). */
export function estimateCost(p, tokens) {
  if (!tokens || (tokens.input == null && tokens.output == null)) return null;
  if (p.free) return 0;
  if (!p.price) return null;
  return ((tokens.input || 0) * (p.price.input || 0) + (tokens.output || 0) * (p.price.output || 0)) / 1e6;
}

export function recordUsage(entry) {
  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    fs.appendFileSync(USAGE_FILE(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch { /* usage logging must never break a run */ }
}

// Tokens saved are estimates: characters kept out of a model's context, at about 4 characters per token.
export const CHARS_PER_TOKEN = 4;
export const SAVING_SOURCES = {
  diff: 'compact diffs the controller read (conductor diff)',
  report: 'trimmed worker reports the controller read',
  'review-diff': 'compact diffs sent to review workers',
  'free-model': 'tasks the selector gave to a free model first',
};
/** Log a saving: { source, chars } or { source, tokens }. Ignored when there is nothing to count. */
export function recordSaving({ source, chars = 0, tokens, project }) {
  const t = tokens ?? Math.round(chars / CHARS_PER_TOKEN);
  if (t > 0) recordUsage({ kind: 'saving', source, tokens: t, project });
  return t;
}

/** Usage entries since `sinceMs` (epoch ms). */
export function readUsage(sinceMs = 0) {
  let text = '';
  try { text = fs.readFileSync(USAGE_FILE(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (Date.parse(e.ts) >= sinceMs) out.push(e); } catch { /* skip a torn line */ }
  }
  return out;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Today's known spend in dollars, overall and for one provider. */
export function spentToday(provider) {
  const today = readUsage(startOfToday());
  const sum = (list) => list.reduce((t, e) => t + (e.cost || 0), 0);
  return { total: sum(today), provider: provider ? sum(today.filter((e) => e.provider === provider)) : 0 };
}

/**
 * Skip reason when a paid provider would go over a daily budget, else null.
 * settings.dailyBudgetUSD caps all providers together; provider.dailyBudgetUSD caps one provider.
 * Free providers and providers without a price are never blocked (their cost is 0 or unknown).
 */
export function budgetBlock(name, p, settings = {}) {
  if (p.free || !p.price) return null;
  const spent = spentToday(name);
  if (p.dailyBudgetUSD > 0 && spent.provider >= p.dailyBudgetUSD) return `daily budget reached for ${name} ($${spent.provider.toFixed(2)} of $${p.dailyBudgetUSD})`;
  if (settings.dailyBudgetUSD > 0 && spent.total >= settings.dailyBudgetUSD) return `daily budget reached ($${spent.total.toFixed(2)} of $${settings.dailyBudgetUSD})`;
  return null;
}

/** Totals per provider over the last `days` days. */
export function usageReport(days = 7) {
  const since = startOfToday() - (days - 1) * 86_400_000;
  const rows = {};
  const savings = { total: 0, controller: 0, workers: 0, freeRuns: 0, by: {} };
  for (const e of readUsage(since)) {
    if (e.kind === 'saving') {
      savings.total += e.tokens || 0;
      savings.by[e.source] = (savings.by[e.source] || 0) + (e.tokens || 0);
      if (e.source === 'diff' || e.source === 'report') savings.controller += e.tokens || 0; else savings.workers += e.tokens || 0;
      if (e.source === 'free-model') savings.freeRuns++;
      continue;
    }
    const r = rows[e.provider] ||= { provider: e.provider, runs: 0, ok: 0, input: 0, output: 0, cost: 0, costKnown: true, subscription: true, seconds: 0 };
    if (e.kind === 'chat') r.subscription = false;
    r.runs++; if (e.ok) r.ok++;
    r.input += e.tokens?.input || 0; r.output += e.tokens?.output || 0;
    if (e.cost == null) { if (e.kind === 'chat') r.costKnown = false; } else r.cost += e.cost;
    r.seconds += e.seconds || 0;
  }
  const list = Object.values(rows).sort((a, b) => b.runs - a.runs);
  return { days, since: new Date(since).toISOString().slice(0, 10), rows: list, total: list.reduce((t, r) => t + r.cost, 0), today: spentToday().total, savings };
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function formatUsage(u, settings = {}) {
  if (!u.rows.length) return `No runs recorded since ${u.since}.`;
  const L = [`Usage since ${u.since} (${u.days} day${u.days === 1 ? '' : 's'})`, ''];
  L.push(`${'provider'.padEnd(18)}${'runs'.padStart(6)}${'ok'.padStart(6)}${'tokens in'.padStart(11)}${'out'.padStart(9)}${'cost'.padStart(10)}${'time'.padStart(9)}`);
  for (const r of u.rows) {
    const cost = r.subscription ? 'subscr.' : r.cost ? `$${r.cost.toFixed(3)}` : r.costKnown ? '$0' : '?';
    L.push(`${r.provider.padEnd(18)}${String(r.runs).padStart(6)}${String(r.ok).padStart(6)}${k(r.input).padStart(11)}${k(r.output).padStart(9)}${cost.padStart(10)}${`${Math.round(r.seconds / 60)}m`.padStart(9)}`);
  }
  L.push('', `known cost: $${u.total.toFixed(3)} · today: $${u.today.toFixed(3)}${settings.dailyBudgetUSD > 0 ? ` of $${settings.dailyBudgetUSD} daily budget` : ' (no daily budget set)'}`);
  L.push('CLI agents run on your subscriptions: Antigravity, Codex and OpenCode report tokens, other CLIs only runs and time. "?" = an API provider without a `price` in config.');
  if (u.savings?.total) {
    L.push('', `Context kept out of models (estimate from characters, ~${CHARS_PER_TOKEN} per token; not measured Claude usage): ~${k(u.savings.total)} tokens`);
    L.push(`  your controller: ~${k(u.savings.controller)} · workers: ~${k(u.savings.workers)}`);
    for (const [src, t] of Object.entries(u.savings.by)) L.push(`  ${('~' + k(t)).padStart(8)}  ${SAVING_SOURCES[src] || src}`);
  }
  return L.join('\n');
}
