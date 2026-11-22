import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers.js';

const home = isolateHome();
const { resolveChain } = await import('../src/core.js');
const { workerEnv } = await import('../src/providers.js');
const { loadConfig } = await import('../src/config.js');
const { addAccount, accountDir, markSignedIn } = await import('../src/accounts.js');
const { setCooldown, clearCooldowns } = await import('../src/cooldowns.js');

test('resolveChain expands accounts in order and skips account cooldowns and saved sign-in failures', () => {
  addAccount('codex-cli', 'a');
  addAccount('codex-cli', 'b');
  markSignedIn('codex-cli#a', false);
  setCooldown('codex-cli#b', 10, 'rate limited');
  const cfg = loadConfig();
  const chain = resolveChain(cfg, 'build', { chain: ['codex-cli'] });
  assert.deepEqual(chain.map((c) => [c.name, c.account?.label, c.key]), [
    ['codex-cli', 'default', 'codex-cli#default'],
    ['codex-cli', 'a', 'codex-cli#a'],
    ['codex-cli', 'b', 'codex-cli#b'],
  ]);
  assert.match(chain[1].skip, /^needs sign-in:/);
  assert.match(chain[2].skip, /^account cooling down until/);
  clearCooldowns();
  assert.equal(resolveChain({ ...cfg, providers: { ...cfg.providers, 'codex-cli': { ...cfg.providers['codex-cli'], accounts: undefined } } }, 'build', { chain: ['codex-cli'] })[0].key, 'codex-cli');
});

test('workerEnv applies account overrides after passEnv and leaves default login home alone', () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'secret';
  try {
    const preset = { passEnv: ['OPENAI_API_KEY'] };
    const homeEnv = workerEnv(preset, 'read', process.cwd(), { set: { CODEX_HOME: accountDir('codex-cli', 'work') }, drop: ['OPENAI_API_KEY'] });
    assert.equal(homeEnv.CODEX_HOME, accountDir('codex-cli', 'work'));
    assert.equal('OPENAI_API_KEY' in homeEnv, false);
    const defaultEnv = workerEnv(preset, 'read', process.cwd(), { set: {}, drop: [] });
    assert.equal(defaultEnv.CODEX_HOME, undefined);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
  }
});


// ---- end to end: a fake `codex` that runs as whichever account CODEX_HOME points at
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, fakeBins } from './helpers.js';

fakeBins({
  codex: `const home = process.env.CODEX_HOME || '';
const has = (f) => home && fs.existsSync(require('path').join(home, f));
if (args[0] !== 'exec') process.exit(0);
if (has('quota')) { console.error("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM."); process.exit(1); }
if (has('signedout')) { console.error('Not logged in. Run codex login.'); process.exit(1); }
const out = args[args.indexOf('-o') + 1];
fs.writeFileSync(out, 'Answer from ' + (home ? require('path').basename(home) : 'default') + '. OPENAI_API_KEY ' + (process.env.OPENAI_API_KEY ? 'present' : 'absent') + '. RESULT: DONE');`,
  'backup-agent': `console.log('## RESULT: DONE\\nanswered by the backup provider, which is long enough');`,
});
const { dispatch, formatSummary } = await import('../src/core.js');
const { getCooldowns } = await import('../src/cooldowns.js');
const { accountStatus, setAccountEnabled } = await import('../src/accounts.js');
const { SECRET_VARS } = await import('../src/util.js');

const resetAll = () => { for (const f of ['config.json', 'state.json', 'accounts', 'usage.jsonl']) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const mark = (label, file) => fs.writeFileSync(path.join(accountDir('codex-cli', label), file), '');
// three accounts; `default` is off here, so the user's real ~/.codex is never what a test depends on
function pool() {
  resetAll();
  addAccount('codex-cli', 'a'); addAccount('codex-cli', 'b');
  setAccountEnabled('codex-cli', 'default', false);
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['codex-cli'].enabled = true;
  cfg.providers.backup = { type: 'cli', enabled: true, bin: 'backup-agent', write: ['x'], read: ['x'] };
  return cfg;
}
// the next 3:05 PM local time after `from`
function next305(from) {
  const d = new Date(from); d.setHours(15, 5, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

test('a quota hit on one account moves the task to the next account, which cools down until the real reset', async () => {
  const cfg = pool();
  mark('a', 'quota');
  const t0 = Date.now();
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['codex-cli', 'backup'] });
  assert.equal(s.winner, 'codex-cli');
  assert.equal(s.account, 'b');
  const failed = s.attempts.find((x) => x.account === 'a');
  assert.match(failed.reason, /^quota/);
  const cd = getCooldowns();
  assert.ok(Math.abs(cd['codex-cli#a'].until - next305(t0)) <= 60_000, `until ${new Date(cd['codex-cli#a'].until)}`);
  assert.equal(cd['codex-cli'], undefined, 'the provider itself is not cooling down');
  const usage = fs.readFileSync(path.join(home, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(usage.at(-1).account, 'b');
  // each account keeps its own worker log in the run folder
  const runDir = path.join(cfg.root, path.dirname(s.report));
  assert.match(fs.readFileSync(path.join(runDir, 'codex-cli.a.log'), 'utf8'), /hit your usage limit/);
  assert.ok(fs.existsSync(path.join(runDir, 'codex-cli.b.log')));

  // the next run skips the cooling account without starting it
  const again = await dispatch(cfg, { role: 'ask', task: 'again?', chain: ['codex-cli', 'backup'] });
  assert.equal(again.account, 'b');
  assert.match(again.attempts.find((x) => x.account === 'a').reason, /^account cooling down until/);
});

test('when every account is out, the run falls to the next provider; only the accounts cool down', async () => {
  const cfg = pool();
  mark('a', 'quota'); mark('b', 'quota');
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['codex-cli', 'backup'] });
  assert.equal(s.winner, 'backup');
  assert.equal(s.account, undefined);
  const cd = getCooldowns();
  assert.ok(cd['codex-cli#a'] && cd['codex-cli#b']);
  assert.equal(cd['codex-cli'], undefined);
});

test('a signed-out account is marked "needs sign-in" and skipped; it does not cool down', async () => {
  const cfg = pool();
  mark('a', 'signedout');
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['codex-cli', 'backup'] });
  assert.equal(s.account, 'b');
  const failed = s.attempts.find((x) => x.account === 'a');
  assert.equal(failed.reason, 'needs sign-in');
  assert.match(failed.next, /conductor-ai accounts login codex-cli a/);
  assert.equal(getCooldowns()['codex-cli#a'], undefined);
  assert.equal(accountStatus(loadConfig(cfg.root), 'codex-cli').find((x) => x.label === 'a').state, 'needs-sign-in');
});

test('an account run gets its own CODEX_HOME and never the OpenAI key; the default login keeps both as they were', async () => {
  const cfg = pool();
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  SECRET_VARS.add('OPENAI_API_KEY'); // as if it came from conductor-ai's secrets.env (codex's passEnv lets it through)
  try {
    const report = (x) => fs.readFileSync(path.join(cfg.root, x.report), 'utf8');
    const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['codex-cli'] });
    assert.equal(s.account, 'a');
    assert.match(report(s), /Answer from a\. OPENAI_API_KEY absent/);
    setAccountEnabled('codex-cli', 'default', true);
    const d = await dispatch(loadConfig(cfg.root), { role: 'ask', task: 'what?', chain: ['codex-cli'] });
    assert.equal(d.account, 'default');
    assert.match(report(d), /Answer from default\. OPENAI_API_KEY present/);
    assert.match(formatSummary(d), /worker: +codex-cli \[default\]/);
  } finally {
    delete process.env.OPENAI_API_KEY; SECRET_VARS.delete('OPENAI_API_KEY');
  }
});

test('with no accounts the chain is exactly as before: one entry, keyed by the provider name', () => {
  resetAll();
  const cfg = loadConfig();
  const chain = resolveChain(cfg, 'build', { chain: ['codex-cli', 'codex-cli'] });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].key, 'codex-cli');
  assert.equal(chain[0].account, undefined);
});
