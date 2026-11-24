import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetSeconds } from '../src/providers.js';
import { DEFAULT_SETTINGS } from '../src/presets.js';

test('resetSeconds reads local clock times and absolute reset timestamps', () => {
  const now = new Date(2026, 10, 22, 14, 0, 0);
  assert.equal(resetSeconds("You've hit your usage limit. Try again at 3:05 PM.", now), 3900);
  assert.equal(resetSeconds("You've hit your 5-hour limit · resets 3pm", now), 3600);
  assert.equal(resetSeconds('resets 1pm', now), 82_800);
  assert.equal(resetSeconds('Try again at Nov 24th, 2026 9:00 AM.', now), (new Date(2026, 10, 24, 9) - now) / 1000);
  assert.equal(resetSeconds('resets 3pm (Europe/London)', now), 3600);
  assert.equal(resetSeconds('resets at 2026-11-23T09:00:00Z', now), Math.round((Date.parse('2026-11-23T09:00:00Z') - now) / 1000));
});

test('resetSeconds caps date and clock resets at 31 days', () => {
  const now = new Date(2026, 10, 23, 22, 51, 0);
  const dec2 = new Date(2026, 11, 2, 8, 34, 0);
  assert.equal(resetSeconds('try again at Dec 2nd, 2026 8:34 AM.', now), (dec2 - now) / 1000);
  const fortyDays = new Date(now.getTime() + 40 * 86_400_000);
  const date = `resets at ${fortyDays.toISOString()}`;
  assert.equal(resetSeconds(date, now), 31 * 86_400);
  assert.equal(resetSeconds('try again in 900h', now), 604_800);
});

test('resetSeconds retains durations, unknown text and the seven-day cap', () => {
  assert.equal(resetSeconds('Resets in 118h3m13s'), 424_993);
  assert.equal(resetSeconds('Try again later.'), 0);
  const now = new Date();
  assert.equal(resetSeconds(`resets at ${(new Date(now.getTime() + 30 * 86_400_000)).toISOString()}`, now), 30 * 86_400);
});

test('default quota pattern matches common Claude usage-limit messages', () => {
  const quota = new RegExp(DEFAULT_SETTINGS.quotaPattern, 'i');
  for (const text of ["You've hit your weekly limit", "You're out of usage credits", 'You have exhausted your quota on this model.', 'usage_limit_reached']) assert.match(text, quota);
});

test('resetSeconds reads month names in any case, and a date without a year as the next such date', () => {
  const now = new Date(2026, 10, 22, 14, 0, 0);
  assert.equal(resetSeconds("You've hit your weekly limit · resets Nov 24, 9am", now), (new Date(2026, 10, 24, 9) - now) / 1000);
  assert.equal(resetSeconds('try again at nov 24th, 2026 9:00 am', now), (new Date(2026, 10, 24, 9) - now) / 1000);
  // a date earlier in the year means next year, capped at 31 days
  assert.equal(resetSeconds('resets Jan 2, 9am', now), 31 * 86_400);
  assert.equal(resetSeconds('resets Nov 22, 3pm', now), 3600);
});
