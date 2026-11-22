import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, tmpdir } from './helpers.js';

const home = isolateHome();
const { createUiServer } = await import('../src/ui/server.js');
const { accountDir } = await import('../src/accounts.js');

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
