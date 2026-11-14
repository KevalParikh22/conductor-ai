// Rate-limit cooldowns (shared across projects) and per-provider parallel slots (moved out of core.js unchanged, V12).
import path from 'node:path';
import { GLOBAL_DIR, readJSON, writeJSON } from './util.js';

// ---------------- cooldowns (shared across projects) ----------------
const STATE = () => path.join(GLOBAL_DIR, 'state.json');

export function getCooldowns() {
  const s = readJSON(STATE(), {});
  const now = Date.now(), out = {};
  for (const [n, c] of Object.entries(s.cooldowns || {})) if (c.until > now) out[n] = c;
  return out;
}
export function setCooldown(name, minutes, reason) {
  const s = readJSON(STATE(), {});
  s.cooldowns = { ...getCooldowns(), [name]: { until: Date.now() + minutes * 60_000, reason } };
  writeJSON(STATE(), s);
}
export function clearCooldowns(name) {
  const s = readJSON(STATE(), {});
  if (name) delete (s.cooldowns ||= {})[name]; else s.cooldowns = {};
  writeJSON(STATE(), s);
}

export const modelKey = (name, model) => `${name}@${model || '(default)'}`;

// V8: a provider with maxParallel (agy: 1) runs that many calls at once in this process; the rest wait their turn
const slots = new Map();
export async function withSlot(name, limit, fn, onWait) {
  if (!(limit > 0)) return fn();
  const s = slots.get(name) || { busy: 0, queue: [] };
  slots.set(name, s);
  if (s.busy >= limit) { onWait?.(); await new Promise((resolve) => s.queue.push(resolve)); } else s.busy++;
  try { return await fn(); } finally { const nextUp = s.queue.shift(); if (nextUp) nextUp(); else s.busy--; }
}
