// V2: every failure says what to do next. One table maps a failure reason (as providers.js, config.js, usage.js and
// core.js write it) to a concrete step. The CLI summary, MCP replies (which use the CLI summary) and the UI show it.
import { CLI_PRESETS } from './presets.js';
import { CATALOG } from './catalog.js';

const cfgFile = '`conductor ui` → Settings, or the file from `conductor config path`';

// [pattern, (match, ctx) → step]. First match wins; ctx = { name, p, log }.
const RULES = [
  [/^unknown provider/, ({ name }) => `"${name}" isn't configured: check the name against \`conductor status\`${CATALOG[name] ? `, or add it with \`conductor add ${name}\`` : ' (chat APIs you can add: `conductor providers`)'}`],
  [/^disabled/, ({ name }) => `turn ${name} on in \`conductor ui\` → Providers, or take it out of this role's chain`],
  [/^"?([\w.-]+)"? not installed|^not installed/, ({ p }, m) => {
    const pre = CLI_PRESETS[p?.preset] || {};
    return `install it${pre.install ? `: ${pre.install}` : ` (\`${p?.bin || m[1]}\` must be on PATH)`}${pre.login ? `, sign in: ${pre.login}` : ''}, then \`conductor doctor\``;
  }],
  [/^(\w+) not set/, ({ p }, m) => {
    const url = Object.values(CATALOG).find((e) => e.apiKeyEnv === m[1])?.keyUrl;
    return `set the key: \`conductor keys set ${m[1]}\`${url ? ` (get one at ${url})` : ''}`;
  }],
  [/^cooling down until ([^(]+)/, ({ name }, m) => `it waits until ${m[1].trim()}; to try it now: \`conductor cooldown --clear ${name}\``],
  [/^every model is cooling down/, ({ name }) => `all of ${name}'s models hit their limits; \`conductor cooldown\` shows when each resets (\`conductor cooldown --clear ${name}\` to try now)`],
  [/daily budget reached/, () => `the paid daily budget is used up: wait until tomorrow, or raise dailyBudgetUSD in ${cfgFile}`],
  [/^waiting for your answer/, ({ run, prompt }) => `paste ${prompt || 'the prompt in the run folder'} into any web chat, save its whole answer to a file, then: conductor import ${run || '<run>'} <answer file>`],
  [/^prompt too long for (.+?): (\d+) characters, its limit is (\d+)/, (_, m) => `the prompt (${m[2]} characters) is over ${m[1]}'s limit (${m[3]}): give it a smaller task, fewer --files, or a chat with a bigger limit (raise maxPromptChars)`],
  [/^cancelled/, () => 'nothing to do: another attempt in the race passed first, so this one was stopped'],
  [/^context too small: .*~(\d+) tokens with the answer, (\S+) runs with (\d+) \((Ollama|LM Studio)/, (_, m) => m[4] === 'LM Studio'
    ? `load ${m[2]} in LM Studio with a context length of at least ${m[1]} (Developer → model settings), or give this task to a bigger route`
    : `give ${m[2]} a bigger window: set OLLAMA_CONTEXT_LENGTH=${2 ** Math.ceil(Math.log2(Number(m[1])))} for the Ollama server and restart it (or \`ollama create\` a copy with PARAMETER num_ctx). More context needs more memory; smaller tasks also help`],
  [/^quota/, ({ name }) => `${name} hit a rate limit or its quota and cools down; conductor moved on. See \`conductor cooldown\`. More free routes: \`conductor providers --free\``],
  [/^denied: (.+?) \(/, (_, m) => `the worker was refused \`${m[1]}\` (headless runs can't ask): add it to settings.allowCommands in ${cfgFile}`],
  [/^agy status/, ({ log }) => `Antigravity reported an error: read ${log || 'the worker log in the run folder'}, then \`conductor doctor --live\``],
  [/^auth \((\d+)/, ({ p }) => `the key was refused: check or replace it with \`conductor keys set ${p?.apiKeyEnv || '<KEY_NAME>'}\``],
  [/^idle \(/, ({ name }) => `${name} printed nothing for too long: raise its \`idleTimeoutMin\`, or set it to 0 to turn the idle limit off (providers.${name} in the file from \`conductor config path\`)`],
  [/^timeout/, ({ name }) => `${name} ran out of time: give the task more (\`--timeout 45m\`, or an \`eta:\` line in the plan task), or split it into smaller tasks`],
  [/^spawn error/, ({ p }) => `the program couldn't start: check \`${p?.bin || 'its command'}\` runs in a terminal, then \`conductor doctor\``],
  [/^network: (.+)/, () => 'couldn\'t reach the provider: check your connection and its base URL, then `conductor doctor --live`'],
  [/^server (5\d\d)|^server overloaded/, () => 'the provider failed on its side: nothing to fix here; conductor moved on, try it again later'],
  [/^http (4\d\d)/, ({ name }) => `the provider refused the request (often a model id that no longer exists): pick a current one with \`conductor models ${name}\``],
  [/^no model set/, ({ name }) => `set a model for ${name}: \`conductor models ${name}\` lists them`],
  [/^(no file blocks in reply|only protected\/outside files returned)/, () => 'the chat model didn\'t return files in the required format: give this task to an agent (Codex, OpenCode, Antigravity) or a bigger model'],
  [/^syntax error in (.+)/, (_, m) => `the worker's ${m[1]} doesn't parse, so nothing was kept: conductor tries the next worker; a lesson is recorded`],
  [/^missing from the code: (.+?) \(/, (_, m) => `the worker didn't write ${m[1]}, which the task names: retry, or check the name in the plan is right`],
  [/^not exported by name: (.+?) \(/, (_, m) => `add \`export\` for ${m[1]} under exactly that name (or fix the name in the plan), then retry`],
  [/^empty output/, ({ name, p, log }) => {
    const login = CLI_PRESETS[p?.preset]?.login;
    return `${name} returned nothing usable: read ${log || 'its log in the run folder'}${login ? `; if it's signed out: ${login}` : ''}`;
  }],
  [/^exit (\d+)/, ({ log }) => `the worker stopped with an error: read ${log || 'its log in the run folder'}`],
  [/^unexpected reply/, ({ name }) => `${name} answered, but not as asked: try another model (\`conductor models ${name}\`)`],
];

/** The next step for one failure reason, or '' when the reason is not a failure (ok, skipped by choice). */
export function nextStep(reason, ctx = {}) {
  const r = String(reason || '');
  if (!r || r === 'ok') return '';
  for (const [re, fn] of RULES) { const m = r.match(re); if (m) return fn(ctx, m); }
  return `read ${ctx.log || 'the worker log in the run folder'}, then \`conductor doctor --live\``;
}

// Failures that stay until someone acts (install, key, config). Shown even when another worker won.
const LASTING = /^(context too small|unknown provider|disabled|"?[\w.-]+"? not installed|not installed|\w+ not set|auth \(|denied: |no model set|http 4|spawn error)/;
export const isLasting = (reason) => LASTING.test(String(reason || ''));

/** One "fix:" line per provider for a summary: every failure when nothing won, only lasting ones otherwise. */
export function fixLines(attempts = [], { won = false } = {}) {
  const seen = new Set(), out = [];
  for (const a of attempts) {
    if (a.ok || !a.next || seen.has(a.provider) || (won && !isLasting(a.reason))) continue;
    seen.add(a.provider);
    out.push(`${a.provider}: ${a.next}`);
  }
  return out;
}

/** Reason patterns the table knows (for the test that every reason in the code has a step). */
export const KNOWN = RULES.map(([re]) => re);
