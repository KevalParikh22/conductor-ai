// W1: the manual web bridge. You paste a run's prompt into any web chat and bring the answer back; conductor never
// drives a browser, holds cookies or logs into an account (decided 2026-11-11). The answer is replayed through the
// normal pipeline as the manual provider's reply: for write roles its file blocks are applied with the same protected
// file rules, then verify, the scope gate and every other check run, exactly as for an API worker.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRun, runsDir } from './runs.js';
import { readJSON, writeJSON, which } from './util.js';

export class ImportError extends Error {}

/**
 * Import your answer for a waiting run. deps: { dispatch } (core's, passed in to avoid an import cycle).
 * → the new run's summary (the waiting run then points at it)
 */
export async function importAnswer(cfg, runId, text, { dispatch, onEvent } = {}) {
  const r = readRun(cfg.root, runId);
  if (!r) throw new ImportError(`no run "${runId}" (see conductor runs)`);
  const s = r.summary;
  if (!s.waiting) throw new ImportError(`run ${r.id} isn't waiting for an answer (only runs with --provider manual are)`);
  if (s.importedAs) throw new ImportError(`run ${r.id} already has its answer: run ${s.importedAs}`);
  const answer = String(text ?? '').trim();
  if (!answer) throw new ImportError('the answer is empty: paste the chat\'s whole reply');
  const dir = path.join(runsDir(cfg.root), r.id);
  const request = readJSON(path.join(dir, 'request.json'), null);
  if (!request) throw new ImportError(`run ${r.id} has no request.json to replay`);
  const next = await dispatch(cfg, { ...request, chain: [s.waiting.provider], provider: undefined, manualAnswer: answer, replace: true, onEvent });
  writeJSON(path.join(dir, 'summary.json'), { ...s, importedAs: (next.runDir || '').split('/').pop(), importedAt: new Date().toISOString() });
  return next;
}

/**
 * File a deep-research report from a web chat into the project, so `ask` (--files) and the controller can use it.
 * Markdown and text are copied; a PDF is converted with pdftotext when it is installed. → the project-relative path
 */
export function importResearch(root, file, save) {
  if (!fs.existsSync(file)) throw new ImportError(`no file ${file}`);
  const dest = path.resolve(root, save || path.join('docs', 'research', path.basename(file).replace(/\.(pdf|txt)$/i, '.md')));
  if (!dest.startsWith(path.resolve(root) + path.sep)) throw new ImportError('--save must be a path inside the project');
  let text;
  if (/\.pdf$/i.test(file)) {
    if (!which('pdftotext')) throw new ImportError('reading a PDF needs pdftotext (poppler-utils); or save the report as Markdown or text from the chat');
    text = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 << 20 }).toString();
  } else text = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `<!-- imported by conductor from ${path.basename(file)} on ${new Date().toISOString().slice(0, 10)}: a web chat's research, check it before relying on it -->\n${text.trimEnd()}\n`);
  return path.relative(root, dest);
}
