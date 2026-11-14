// MCP: run reports as resources. A controller can list recent runs and read one (or the latest) like a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { listRunResources, readRunResource } = await import('../src/mcp.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

test('runs are listed newest first with conductor://runs/latest; reading one gives its summary, checklist and report', async () => {
  fakeBins({ 'res-worker': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{fs.writeFileSync(args[args.indexOf('-o')+1],'## VERDICT: APPROVE\\nThe code looks right to me.');});` });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers = { w: { type: 'cli', preset: 'codex', enabled: true, bin: 'res-worker' } };
  const s1 = await dispatch(cfg, { role: 'ask', task: 'first', chain: ['w'] });
  await new Promise((r) => setTimeout(r, 1100)); // a later second, so the order is certain
  const s2 = await dispatch(cfg, { role: 'ask', task: 'second', chain: ['w'] });
  const list = listRunResources(dir);
  assert.equal(list[0].uri, 'conductor://runs/latest');
  assert.deepEqual(list.slice(1).map((r) => r.uri), [`conductor://runs/${s2.runDir.split('/').pop()}`, `conductor://runs/${s1.runDir.split('/').pop()}`]);
  assert.match(list[1].name, /^ask: done$/);
  assert.equal(list[1].mimeType, 'text/markdown');
  const latest = readRunResource(dir, 'conductor://runs/latest');
  assert.match(latest.text, /^# conductor run .*-ask\n/);
  assert.match(latest.text, /CONDUCTOR RESULT[\s\S]*checks:[\s\S]*## Worker report\n\n## VERDICT: APPROVE/);
  assert.ok(readRunResource(dir, list[2].uri).text.startsWith(`# conductor run ${s1.runDir.split('/').pop()}\n`), 'the older run by its id');
  for (const bad of ['conductor://runs/../x', 'conductor://runs/', 'file:///etc/passwd', 'conductor://runs/nope']) assert.equal(readRunResource(dir, bad), null, bad);
});
