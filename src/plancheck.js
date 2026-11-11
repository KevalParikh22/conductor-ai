// Plan gate (Q1) and acceptance check (H5): enforced by code, not by asking the model.
//   checkTask:   is a plan task specific enough to hand to a worker? (files, checkable acceptance, verify, size)
//   acceptance:  the task's criteria are repeated at the end of the worker's prompt, the worker answers each one with
//                evidence in its report, and conductor counts the answers.
import { taskFiles, extractTask } from './core.js';

const field = (section, name) => (section.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.*)`, 'i')) || [])[1]?.trim() || '';
const placeholder = (s) => !s || /^(\.\.\.|…|-|none|tbd|todo)$/i.test(s.trim()) || /^<[^>]*>$/.test(s.trim());

// criteria nobody can check: "works", "done", "tests pass" with nothing about what is observed
const VAGUE = /^(it |everything |all |code )?(works?( correctly| fine| as expected)?|done|complete[d]?|finished|ok(ay)?|as expected|no (errors?|bugs?)|tests? (pass(es)?|green)|implemented|looks good|is correct|feature works?)\.?$/i;

/** The task's acceptance criteria: the items under `- **acceptance:**` (or text on the same line). */
export function taskAcceptance(section) {
  const lines = String(section || '').split('\n');
  const i = lines.findIndex((l) => /^\s*[-*]\s*\*\*acceptance:\*\*/i.test(l));
  if (i < 0) return [];
  const out = [];
  const inline = lines[i].replace(/^\s*[-*]\s*\*\*acceptance:\*\*\s*/i, '').trim();
  if (!placeholder(inline)) out.push(inline);
  for (const l of lines.slice(i + 1)) {
    if (/^\s*[-*]\s*\*\*[\w ]+:\*\*/.test(l) || /^#{1,6}\s/.test(l)) break; // next field or heading
    const m = l.match(/^\s+[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/) || l.match(/^\s+\d+[.)]\s+(.+)$/);
    if (m && !placeholder(m[1])) out.push(m[1].trim());
    else if (l.trim() && !/^\s/.test(l)) break;
  }
  return out;
}

/** Task ids in a plan, from headings like "### T3: title". */
export function planTaskIds(planText) {
  return [...String(planText).matchAll(/^#{2,4}\s+([A-Za-z]+\d[\w.-]*)\s*[:—–-]/gm)].map((m) => m[1]);
}

/**
 * What a write task is missing before a worker can do it well. [] when it's ready. Controller and read-only tasks
 * aren't checked. `verifyCmd` is the project's verify command (a task's own `verify:` line also counts).
 */
export function checkTask(section, { verifyCmd = '', maxFiles = 4 } = {}) {
  const role = field(section, 'role').split(/[\s|,]/)[0] || 'build';
  if (!['build', 'fix', 'test', 'docs'].includes(role)) return [];
  const problems = [];
  const files = taskFiles(section).filter((f) => !placeholder(f) && !f.includes('...') && !f.includes('<'));
  if (!files.length) problems.push('no files: list what it may change, e.g. - **files:** `src/cart.js`, `src/cart.test.js` (workers stay inside them; small tasks can go to free models)');
  const acc = taskAcceptance(section);
  if (!acc.length) problems.push('no acceptance criteria: say what must be true when it is done, e.g. "addItem() with qty 0 throws RangeError"');
  else {
    const vague = acc.filter((a) => VAGUE.test(a.replace(/[`*_]/g, '').trim()) || a.replace(/[`*_]/g, '').trim().length < 8);
    if (vague.length) problems.push(`acceptance too vague to check: ${vague.map((v) => `"${v}"`).join(', ')}. Say what can be observed (a return value, an HTTP status, a command that passes)`);
  }
  const taskVerify = (field(section, 'verify').match(/`([^`]+)`/) || [])[1];
  if (!verifyCmd && (!taskVerify || taskVerify.includes('<'))) problems.push('no verify command: add - **verify:** `<command>` to the task, or set one for the project (conductor init --verify "<cmd>")');
  const code = files.filter((f) => !/(^|[/._-])(tests?|spec|__tests__)([/._-]|$)/i.test(f));
  if (code.length > maxFiles) problems.push(`too big for one worker: ${code.length} files besides tests (limit ${maxFiles}). Split it into smaller tasks`);
  return problems;
}

/** Every task in a plan (or just `ids`) with its problems. */
export function checkPlan(planText, { ids, verifyCmd, maxFiles } = {}) {
  return (ids?.length ? ids : planTaskIds(planText)).map((id) => {
    const section = extractTask(planText, id);
    if (!section) return { id, title: '', role: '', problems: ['not found in the plan'] };
    return {
      id,
      title: (section.split('\n')[0].match(/[:—–-]\s*(.+)$/) || [])[1]?.trim() || '',
      role: field(section, 'role').split(/[\s|,]/)[0] || 'build',
      problems: checkTask(section, { verifyCmd, maxFiles }),
    };
  });
}

export function formatPlanCheck(file, rows) {
  const L = [`plan check: ${file}`];
  for (const r of rows) {
    L.push(`${r.problems.length ? '✗' : '✓'} ${r.id}${r.title ? `: ${r.title}` : ''}${r.role && r.role !== 'build' ? ` (${r.role})` : ''}`);
    for (const p of r.problems) L.push(`    - ${p}`);
  }
  const bad = rows.filter((r) => r.problems.length).length;
  L.push('', bad ? `${bad} of ${rows.length} task(s) need work before a worker gets them.` : `All ${rows.length} task(s) are ready to hand out.`);
  return L.join('\n');
}

/** The end of a worker's prompt: its criteria again, and how to answer them (models attend most to the end). */
export function acceptancePrompt(criteria) {
  if (!criteria.length) return '';
  return `\n## Before you finish: check every acceptance criterion\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
    'Add this section to your report, right after "## Checks run", with one line per criterion, in order:\n' +
    '## Acceptance\n- [x] 1. <criterion> — evidence: <command → result, or file:line that does it>\n- [ ] 2. <criterion> — why it is not met\n' +
    'Mark [x] only with evidence. A criterion you did not meet is [ ] and the RESULT is PARTIAL, not DONE.\n';
}

/** Count the worker's answers in its "## Acceptance" section. */
export function readAcceptance(text, criteria) {
  const m = String(text || '').match(/^#{1,4}\s*Acceptance\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|\s*$(?![\s\S]))/im);
  if (!m) return { total: criteria.length, met: 0, answered: false, unmet: criteria.map((c, i) => `${i + 1}. ${c}`) };
  const items = m[1].split('\n').map((l) => l.match(/^\s*[-*]\s*\[([ xX✓✔])\]\s*(.*)$/)).filter(Boolean);
  const met = items.filter((x) => x[1] !== ' ').length;
  const unmet = items.filter((x) => x[1] === ' ').map((x) => x[2].trim());
  // criteria the worker didn't mention at all count as not met
  for (let i = items.length; i < criteria.length; i++) unmet.push(`${i + 1}. ${criteria[i]} (not answered)`);
  return { total: criteria.length, met: Math.min(met, criteria.length), answered: true, unmet };
}
