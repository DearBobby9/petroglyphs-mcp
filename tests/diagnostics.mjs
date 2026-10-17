import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { CodexDiagnostics, DESKTOP_COMPATIBILITY_BASELINE, diagnosticFailure, installDiagnosticsRoutes, matchingDesktopCompatibilityBaseline } from '../src/codex-diagnostics.ts';
import { CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';

const hostId = 'remote-control:env_fixture';
const threadId = '00000000-0000-7000-8000-000000000001';

test('inspected mini and original artifacts match only their full version, build, bytes and bundled CLI identity', () => {
  const mini = { version: '26.1013.31256', build: '20586',
    asarSha256: 'bf9c41fa9770fbfacfba93042ff71c24cb65c82935819377275faac08103383f',
    bundledCliVersion: '0.163.0-alpha.10.2' };
  const baseline = matchingDesktopCompatibilityBaseline(mini);
  assert.equal(baseline?.desktopVersion, mini.version, 'the inspected mini artifact must be recognized');
  assert.equal(baseline?.asarSha256, mini.asarSha256);
  assert.equal(baseline?.protocol.interruptTurn, 4);
  for (const field of Object.keys(mini)) {
    assert.equal(matchingDesktopCompatibilityBaseline({ ...mini, [field]: null }), undefined);
    assert.equal(matchingDesktopCompatibilityBaseline({ ...mini, [field]: 'uninspected' }), undefined);
  }
  const original = DESKTOP_COMPATIBILITY_BASELINE;
  assert.equal(matchingDesktopCompatibilityBaseline({ version: original.desktopVersion, build: original.desktopBuild,
    asarSha256: original.asarSha256, bundledCliVersion: original.bundledCliVersion }), original);
});

test('diagnostics separate installed versions from verified host reads and omit private state', async () => {
  const calls = [];
  const service = new CodexDiagnostics({
    runtime: async () => ({ compatibility: { state: 'unverified', evidence: 'installed_artifact' } }),
    requireTarget: async (...args) => calls.push(['target', ...args]),
    connect: async () => ({
      readSettings: async (...args) => { calls.push(['settings', ...args]); return { modelProvider: 'PRIVATE_PROVIDER' }; },
      readSnapshot: async (...args) => { calls.push(['snapshot', ...args]); return { hostId, threadId, revision: 7,
        ownerClientId: 'PRIVATE_OWNER', conversationState: { text: 'PRIVATE_PROMPT' } }; },
      close: () => calls.push(['close']),
    }),
    catalog: { list: async (...args) => { calls.push(['catalog', ...args]); return {
      status: 'unavailable', source: null, observedAt: null, expiresAt: null, reason: 'not_configured',
      models: [{ description: 'PRIVATE_MODEL_DATA' }],
    }; } },
  });
  const result = await service.read({ hostId, threadId, appCommit: 'a'.repeat(40) });
  assert.equal(result.app.commit, 'a'.repeat(40));
  assert.equal(result.app.evidence, 'client_reported');
  assert.equal(result.compatibility.state, 'unverified', 'successful reads do not bless a different installed artifact');
  assert.deepEqual(result.host.probe, { status: 'verified_read', operations: ['read_settings', 'read_history'], revision: 7 });
  assert.deepEqual(Object.values(result.host.execution), ['not_tested', 'not_tested', 'not_tested', 'not_tested']);
  assert.equal(result.host.modelCatalog.source, null, 'remote hosts must not inherit a local model source');
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(calls, [['target', hostId, threadId], ['settings', hostId, threadId], ['snapshot', hostId, threadId], ['close'], ['catalog', hostId]]);
});

test('diagnostics preserve safe delivery categories and reject a mismatched snapshot target', async () => {
  const samples = JSON.parse(await readFile(new URL('./fixtures/diagnostic-outcomes.json', import.meta.url)));
  for (const sample of samples.filter(sample => sample.error)) {
    const error = new CodexDesktopIpcError('PRIVATE_PATH_OR_TOKEN', 503, sample.error.delivery, sample.error.code);
    assert.deepEqual(diagnosticFailure(error), sample.expected);
  }
  assert.equal(diagnosticFailure(new Error('PRIVATE_SECRET')).code, 'desktop_unavailable');
  let closed = false;
  const service = new CodexDiagnostics({ runtime: async () => ({}), requireTarget: async () => {},
    connect: async () => ({ readSettings: async () => ({}), readSnapshot: async () => ({ hostId: 'local', threadId, revision: 1 }),
      close: () => { closed = true; } }),
    catalog: { list: async () => { throw new Error('PRIVATE_CATALOGUE'); } },
  });
  const result = await service.read({ hostId, threadId });
  assert.equal(result.host.probe.code, 'protocol_mismatch');
  assert.equal(result.host.probe.outcome, 'not_sent');
  assert(closed);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
});

test('diagnostic route is paired, validates target and build fields, and never returns native exception text', async t => {
  const app = express(), calls = [];
  app.use((req, res, next) => { res.locals.autoReplyAuthorized = req.headers.authorization === 'test-pair'; next(); });
  installDiagnosticsRoutes(app, { read: async input => {
    calls.push(input);
    if (input.appBuild === 'fail') throw new Error('PRIVATE_TOKEN');
    return { hostId: input.hostId, threadId: input.threadId };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/codex/diagnostics`;
  const target = `?hostId=${hostId}&threadId=${threadId}`;
  assert.equal((await fetch(url + target)).status, 403);
  for (const suffix of ['', target + '&hostId=local', target + '&appCommit=not-a-commit', target + '&extra=private']) {
    assert.equal((await fetch(url + suffix, { headers: { authorization: 'test-pair' } })).status, 400);
  }
  assert.equal(calls.length, 0);
  const success = await fetch(url + target + '&appVersion=1.0&appCommit=' + 'b'.repeat(40), { headers: { authorization: 'test-pair' } });
  assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].appCommit, 'b'.repeat(40));
  const failed = await fetch(url + target + '&appBuild=fail', { headers: { authorization: 'test-pair' } });
  assert.equal(failed.status, 503); assert(!JSON.stringify(await failed.json()).includes('PRIVATE_'));
});
