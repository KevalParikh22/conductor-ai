import { slugify } from './slugify.js';

export function slugPath(segments) {
  if (!Array.isArray(segments)) throw new TypeError('segments must be an array');
  return segments.map((s) => slugify(String(s))).filter(Boolean).join('/');
}
