// Plan text: tasks, sections, open questions, file lists, durations (moved out of core.js unchanged, V12).


// ---------------- plan parsing ----------------
export function extractTask(planText, taskId) {
  const lines = planText.split('\n');
  const head = new RegExp(`^(#{2,4})\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

export function extractSection(planText, title) {
  const m = planText.match(new RegExp(`^##\\s+${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'));
  return m ? m[1].trim() : '';
}

/**
 * Unresolved items under "## Open questions" in a plan: "- [ ] ..." lines. Resolved ones are "- [x] ... → answer".
 * Workers must not guess at open questions, so write tasks from a plan with any left are refused.
 */
export function openQuestions(planText) {
  return extractSection(planText, 'Open questions').split('\n')
    .map((l) => l.match(/^\s*[-*]\s*\[ \]\s*(.+)$/)?.[1]?.trim())
    .filter((q) => q && !/^<.*>$/.test(q));
}

/** Paths in backticks on a "files:" line of a task. */
export function taskFiles(section) {
  const line = section.split('\n').find((l) => /\bfiles\b\**\s*:/i.test(l)) || '';
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((p) => !p.includes(' '));
}

/** "90m", "1h", "1h30m", "2 hours", "45 min", "1.5h" → milliseconds (0 when it can't be read). */
export function parseDuration(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase().replace(/`/g, '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60_000; // a bare number is minutes
  let ms = 0, any = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])/g)) {
    any = true;
    ms += Number(m[1]) * (m[2][0] === 'h' ? 3_600_000 : m[2][0] === 'm' ? 60_000 : 1000);
  }
  return any ? Math.round(ms) : 0;
}

/**
 * The Design notes lines that concern this task: the ones mentioning one of its files. Notes usually describe every
 * module in the plan, and a task must not be held to another task's exports (found by the pilot: a T4 worker was
 * asked to export T1's slugify).
 */
export function notesForFiles(notes, files) {
  const keys = files.map((f) => f.replace(/^\.\//, '')).filter(Boolean);
  if (!keys.length) return '';
  return String(notes || '').split('\n').filter((l) => keys.some((k) => l.includes(k))).join('\n');
}

/** "src/{a,b}.ts" → ["src/a.ts", "src/b.ts"] (nested groups too). */
export function expandBraces(p) {
  const m = p.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m || !m[2].includes(',')) return [p];
  return [...new Set(m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`)))];
}
