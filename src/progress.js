// Live progress in the terminal. A run shows its event lines as before, plus one status line at the bottom: a
// spinner, what is happening, and the time spent against the worker's limit. A batch shows a table with one row per
// task, redrawn in place. Not a terminal (piped, CI, an MCP client): plain event lines only, exactly as before.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** What a step is doing, for the status line and the batch table. */
export function stepText(e) {
  return {
    start: `starting${e.provider ? ` (first choice: ${e.provider})` : ''}`, base: 'checking the starting commit', try: `${e.provider} is working`,
    wait: `waiting for ${e.provider} (one task at a time on it)`, verify: 'running verify', checks: 'running the acceptance checks',
    repro: 'running the repro', isolate: 'checking the code alone against the original tests', review: 'independent review',
    escalate: `${e.provider} takes over ${e.from}'s work`, repair: `asking ${e.provider} once more`,
  }[e.type] || null;
}

/**
 * Progress for one run. `line(text)` prints an event line; `step(e)` updates the status line from an event.
 * → { line, step, stop }
 */
export function runProgress({ stream = process.stderr, prefix = 'conductor', now = () => Date.now(), tty = !!stream.isTTY, columns = () => stream.columns || 80 } = {}) {
  let status = null, since = now(), limit = 0, frame = 0, timer = null, shown = false;
  const clear = () => { if (shown) { stream.write('\r\x1b[2K'); shown = false; } };
  const draw = () => {
    if (!tty || !status) return;
    const t = `${FRAMES[frame++ % FRAMES.length]} ${status} · ${clock(now() - since)}${limit ? ` of ${clock(limit)}` : ''}`;
    stream.write(`\r\x1b[2K${[...t].slice(0, columns() - 1).join('')}`); shown = true;
  };
  return {
    line(text, tag = '') { clear(); stream.write(`${prefix}${tag ? ` [${tag}]` : ''}: ${text}\n`); draw(); },
    step(e) {
      const t = stepText(e);
      if (!t) return;
      status = t; since = now(); limit = e.type === 'try' ? e.limitMs || 0 : 0;
      if (tty && !timer) { timer = setInterval(draw, 120); timer.unref?.(); }
      draw();
    },
    stop() { clearInterval(timer); timer = null; clear(); status = null; },
  };
}

/** A live table for a batch: one row per task with its state, worker and time. → { event(e), stop() } */
export function batchProgress(tasks, { stream = process.stderr, now = () => Date.now(), tty = !!stream.isTTY, columns = () => stream.columns || 80 } = {}) {
  const rows = new Map(tasks.map((t) => [t, { state: 'queued', worker: '', since: null, limit: 0, end: null }]));
  let lines = 0, frame = 0, timer = null;
  const render = () => {
    if (!tty) return;
    const spin = FRAMES[frame++ % FRAMES.length];
    const out = [...rows].map(([t, r]) => {
      const mark = r.end != null ? (r.ok ? '✓' : '✗') : r.since != null ? spin : '·';
      const time = r.since != null ? `${clock((r.end ?? now()) - r.since)}${r.limit && r.end == null ? ` of ${clock(r.limit)}` : ''}` : '';
      return [...`${mark} ${String(t).padEnd(6)} ${r.state.padEnd(34).slice(0, 34)} ${String(r.worker).padEnd(16).slice(0, 16)} ${time}`].slice(0, columns() - 1).join('');
    });
    stream.write(`${lines ? `\x1b[${lines}F` : ''}${out.map((l) => `\x1b[2K${l}`).join('\n')}\n`);
    lines = out.length;
  };
  return {
    event(e) {
      const r = rows.get(e.task);
      if (!r) return;
      if (!tty) {
        // not a terminal: the plain lines batch has always printed
        const m = { start: `starting (first choice: ${e.provider})`, wait: `waiting for ${e.provider} (one task at a time on it)…`, try: `trying ${e.provider}…`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…', base: 'checking the starting commit…', escalate: `verify failed: handing ${e.from}'s work to ${e.provider}…`, repair: `${e.provider} sent no files: asking once more…`, done: 'done' }[e.type];
        if (m) stream.write(`conductor [${e.task}]: ${m}\n`);
        return;
      }
      if (r.since == null) r.since = now();
      if (e.type === 'try') { r.worker = e.provider; r.limit = e.limitMs || 0; }
      if (e.type === 'fail') r.state = `${e.provider} failed: ${e.reason}`;
      else if (e.type === 'ok') r.state = `${e.provider} finished`;
      else if (e.type === 'done') { r.end = now(); r.ok = e.outcome ? e.outcome === 'done' : true; r.state = e.outcome || 'done'; }
      else { const t = stepText(e); if (t) r.state = t; }
      if (!timer) { timer = setInterval(render, 150); timer.unref?.(); }
      render();
    },
    stop() { clearInterval(timer); timer = null; render(); },
  };
}
