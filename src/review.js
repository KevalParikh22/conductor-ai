// Q6: an independent review for risky work. After a write task passes every check, a model from a DIFFERENT family
// than the worker's reviews the diff against the task (models are blind to their own family's mistakes and judges
// favour their own output). It runs only when the work is risky: big, security-related, or asked for in the plan.
// Execution comes first: this adds findings for the controller and never overrides a passing check. Findings that
// don't point at a changed line are dropped, since a review of code the worker didn't touch is noise.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compactDiff } from './diffview.js';
import { providerKind, readOnlyEnforced } from './config.js';

// model family from the model id, else from the CLI preset; unknown → the provider's own name (never "different")
const FAMILIES = [
  [/claude|anthropic|opus|sonnet|haiku|fable/i, 'anthropic'], [/gpt|openai|codex|\bo[1-9]\b/i, 'openai'],
  [/gemini|gemma|google/i, 'google'], [/qwen|alibaba/i, 'qwen'], [/deepseek/i, 'deepseek'], [/llama|meta-/i, 'meta'],
  [/mistral|codestral|devstral/i, 'mistral'], [/kimi|moonshot/i, 'moonshot'], [/glm|zhipu|z-ai/i, 'zhipu'],
  [/grok|xai/i, 'xai'], [/nemotron|nvidia/i, 'nvidia'], [/cohere|command-r/i, 'cohere'], [/minimax/i, 'minimax'],
];
const PRESET_FAMILY = { antigravity: 'google', codex: 'openai', claude: 'anthropic', kimi: 'moonshot', grok: 'xai', copilot: 'openai' };

export function modelFamily(name, p = {}, model = '') {
  const m = `${model || p.model || ''}`;
  for (const [re, fam] of FAMILIES) if (m && re.test(m)) return fam;
  if (p.preset && PRESET_FAMILY[p.preset]) return PRESET_FAMILY[p.preset];
  for (const [re, fam] of FAMILIES) if (re.test(name)) return fam;
  return `unknown:${name}`;
}

const SECURITY = /(^|[/._-])(auth|login|logout|password|passwd|token|secret|session|cookie|crypto|encrypt|permission|acl|role|oauth|jwt|csrf|payment|billing|checkout|sql|query|upload|sanitiz|escape)/i;

/** Why this work deserves a second opinion ([] = it doesn't). */
export function riskReasons({ changed = [], lines = 0, section = '', settings = {}, forced = false }) {
  const out = [];
  if (forced || /\*\*review:\*\*\s*(yes|true|always)/i.test(section)) out.push('the plan asks for a review');
  const limit = settings.reviewLines ?? 150;
  if (limit && lines > limit) out.push(`${lines} lines changed (over ${limit})`);
  const sec = changed.filter((f) => SECURITY.test(f));
  if (sec.length) out.push(`security-related files: ${sec.slice(0, 3).join(', ')}`);
  return out;
}

/** Changed line ranges per file (new files: every line), from `git diff -U0 <base>` plus untracked files. */
export function changedRanges(work, base) {
  const ranges = {};
  let diff = '';
  try { diff = execFileSync('git', ['diff', '-U0', '--no-color', base], { cwd: work, maxBuffer: 64 << 20 }).toString(); } catch { /* none */ }
  let file = null;
  for (const l of diff.split('\n')) {
    const f = l.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]; ranges[file] ||= []; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) { const s = Number(h[1]), n = h[2] === undefined ? 1 : Number(h[2]); ranges[file].push([s, s + Math.max(n, 1) - 1]); }
  }
  try {
    for (const f of execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: work }).toString().split('\n').filter(Boolean)) ranges[f] = [[1, Infinity]];
  } catch { /* not a repo */ }
  return ranges;
}

/** Findings from the review's "## Findings" list: [{ n, severity, confidence, file, line, text }]. */
export function parseFindings(text) {
  const sec = (String(text).match(/^#{1,4}\s*Findings\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|\s*$(?![\s\S]))/im) || [])[1] || '';
  const out = [];
  let cur = null;
  for (const l of sec.split('\n')) {
    const m = l.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (m) {
      const body = m[2];
      const loc = body.match(/`?([\w./@-]+\.[\w]+):(\d+)(?:-\d+)?`?/);
      cur = {
        n: Number(m[1]),
        severity: (body.match(/severity:\s*(high|medium|low|critical)/i) || [])[1]?.toLowerCase() || 'unknown',
        confidence: (body.match(/confidence:\s*(high|low|medium)/i) || [])[1]?.toLowerCase() || 'unknown',
        file: loc ? loc[1].replace(/^\.\//, '') : null, line: loc ? Number(loc[2]) : null,
        text: body.replace(/\[[^\]]*\]\s*/g, '').trim().slice(0, 400),
      };
      out.push(cur);
    } else if (cur && /^\s+-\s*(scenario|fix):/i.test(l)) cur.text += `\n  ${l.trim().slice(0, 300)}`;
  }
  return out;
}

/** Keep findings that point at a changed line (±3); the rest are dropped as outside the diff. */
export function keepInDiff(findings, ranges) {
  const kept = [], dropped = [];
  for (const f of findings) {
    const r = f.file && Object.entries(ranges).find(([file]) => file === f.file || file.endsWith(`/${f.file}`))?.[1];
    if (r && f.line && r.some(([a, b]) => f.line >= a - 3 && f.line <= b + 3)) kept.push(f); else dropped.push(f);
  }
  return { kept, dropped };
}

/**
 * Review the work in `work` (vs `base`) with a provider of another family. deps: { cfg, resolveChain, runProvider,
 * loadPrompt, timeoutMs, quotaRe, runDir }. → summary.review object, or null when no reviewer is available.
 */
export async function independentReview({ work, base, worker, workerModel, section, reasons, deps }) {
  const { cfg, resolveChain, runProvider, loadPrompt, timeoutMs, quotaRe, runDir } = deps;
  const wf = modelFamily(worker, cfg.providers[worker] || {}, workerModel);
  const names = cfg.settings?.reviewers?.length ? cfg.settings.reviewers : [...new Set([...(cfg.roles.review || []), ...Object.keys(cfg.providers)])];
  const candidates = resolveChain(cfg, 'review', { chain: names }).filter((c) => !c.skip && c.p && c.name !== worker
    && modelFamily(c.name, c.p) !== wf && !modelFamily(c.name, c.p).startsWith('unknown:')
    && (providerKind(c.p) === 'chat' || readOnlyEnforced(c.p)));
  if (!candidates.length) return { skipped: `no ready reviewer from another model family than ${wf}`, reasons };
  const diff = compactDiff(work, { base, maxFileLines: 300 });
  if (diff.empty) return null;
  const prompt = `# Independent review\nAnother model (${worker}, ${wf}) did the task below, and it passes the project's checks. Review the diff for what checks miss: wrong behaviour against the task, security problems, missing error handling, unmet acceptance criteria. Cite \`path:line\` from the diff for every finding.\n\n## Task\n${section || '(no plan task)'}\n\n## Diff\n\`\`\`diff\n${diff.text.slice(0, cfg.settings?.maxDiffBytes || 100000)}\n\`\`\`\n`;
  const system = `${loadPrompt('_worker')}\n${loadPrompt('review')}`;
  for (const c of candidates.slice(0, 2)) {
    const res = await runProvider(c.name, c.p, { mode: 'read', prompt, system, cwd: work, runDir, quotaRe, timeoutMs });
    fs.writeFileSync(path.join(runDir, `review-${c.name}.log`), res.log || '');
    if (!res.ok) continue;
    fs.writeFileSync(path.join(runDir, 'review.md'), res.text);
    const all = parseFindings(res.text);
    const { kept, dropped } = keepInDiff(all, changedRanges(work, base));
    const verdict = (res.text.match(/VERDICT:\s*\**\s*(APPROVE|CHANGES_REQUESTED)/i) || [])[1]?.toUpperCase() || null;
    return { reviewer: c.name, family: modelFamily(c.name, c.p), workerFamily: wf, reasons, verdict, findings: kept, dropped: dropped.length, report: path.join(runDir, 'review.md') };
  }
  return { skipped: 'every reviewer failed', reasons };
}
