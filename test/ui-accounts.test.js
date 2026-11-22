import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, tmpdir, fakeBins } from './helpers.js';

const home = isolateHome();
const { createUiServer } = await import('../src/ui/server.js');
const { accountDir, accountKey } = await import('../src/accounts.js');
const { setCooldown } = await import('../src/cooldowns.js');

test('UI manages global CLI accounts and requires confirmation before deleting a login', async () => {
  const dir = tmpdir('conductor-ui-accounts-');
  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const call = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    let r = await call('POST', '/api/accounts/add', { provider: 'codex-cli', label: 'work2' });
    assert.equal(r.status, 200);
    assert.ok(r.json.accounts.some((a) => a.label === 'work2'));
    r = await call('POST', '/api/accounts/add', { provider: 'codex-cli', label: '../x' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /label is 1-32 characters/);
    r = await call('POST', '/api/accounts/order', { provider: 'codex-cli', labels: ['work2', 'default'] });
    assert.deepEqual(r.json.accounts.map((a) => a.label), ['work2', 'default']);
    r = await call('POST', '/api/accounts/remove', { provider: 'codex-cli', label: 'work2' });
    assert.equal(r.status, 400);
    assert.equal(fs.existsSync(accountDir('codex-cli', 'work2')), true);
    const get = await call('GET', '/api/accounts');
    assert.ok(get.json.providers['codex-cli']);
    assert.match(fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8'), /conductor-ai accounts login/);
    assert.ok(home);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }
});

test('UI account status shows cooldowns and the other account actions work', async () => {
  fakeBins({ codex: 'process.exit(0)' });
  const dir = tmpdir('conductor-ui-accounts-more-');
  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const call = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    assert.equal((await call('POST', '/api/accounts/add', { provider: 'codex-cli', label: 'workx' })).status, 200);
    setCooldown(accountKey('codex-cli', 'workx'), 60, 'rate limited');
    let r = await call('GET', '/api/accounts');
    const cooling = r.json.providers['codex-cli'].find((a) => a.label === 'workx');
    assert.equal(cooling.state, 'cooling');
    assert.ok(cooling.until > Date.now());
    r = await call('POST', '/api/accounts/rename', { provider: 'codex-cli', from: 'workx', to: 'worky' });
    assert.ok(r.json.accounts.some((a) => a.label === 'worky'));
    await call('POST', '/api/cooldowns/clear', { name: accountKey('codex-cli', 'worky') });
    r = await call('POST', '/api/accounts/check', { provider: 'codex-cli', label: 'worky' });
    assert.equal(r.json.accounts.find((a) => a.label === 'worky').state, 'ready');
    r = await call('POST', '/api/accounts/toggle', { provider: 'codex-cli', label: 'worky', enabled: false });
    assert.equal(r.json.accounts.find((a) => a.label === 'worky').state, 'disabled');
    r = await call('POST', '/api/accounts/remove', { provider: 'codex-cli', label: 'worky', confirm: true });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(accountDir('codex-cli', 'worky')), false);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }
});
