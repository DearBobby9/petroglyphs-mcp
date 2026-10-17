import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { installModelRoutes } from '../src/codex-model-routes.ts';

test('model routes require pairing, bind reads to one target and expose only public configuration', async t => {
  const app = express(), calls = [];
  app.use((req, res, next) => { res.locals.autoReplyAuthorized = req.headers.authorization === 'test-pair'; next(); });
  installModelRoutes(app, {
    catalog: { list: async hostId => { calls.push(['catalog', hostId]); return { hostId, status: 'unavailable', source: null,
      observedAt: null, expiresAt: null, models: [], reason: 'not_configured' }; } },
    readSettings: async (hostId, threadId) => {
      calls.push(['settings', hostId, threadId]);
      if (threadId.startsWith('ffffffff')) throw new Error('PRIVATE_NATIVE_DETAIL');
      return { model: 'host-model', reasoningEffort: 'high', modelProvider: 'PRIVATE_PROVIDER',
        mode: 'PRIVATE_MODE', developerInstructions: 'PRIVATE_INSTRUCTIONS' };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/codex`;
  const get = (path, paired = true) => fetch(base + path, { headers: paired ? { authorization: 'test-pair' } : {} });
  const host = 'remote-control:env_example', thread = '00000000-0000-7000-8000-000000000001';
  for (const path of [`/models?hostId=${host}`, `/model-settings?hostId=${host}&threadId=${thread}`]) {
    const denied = await get(path, false); assert.equal(denied.status, 403); await denied.json();
  }
  assert.equal(calls.length, 0);
  for (const path of ['/models?hostId=local&hostId=remote-control:env_example', '/model-settings?hostId=local&threadId=bad']) {
    const rejected = await get(path); assert.equal(rejected.status, 400); await rejected.json();
  }
  assert.equal(calls.length, 0);
  const catalog = await get(`/models?hostId=${host}`);
  assert.equal(catalog.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await catalog.json()).models, []);
  const settings = await (await get(`/model-settings?hostId=${host}&threadId=${thread}`)).json();
  assert.equal(settings.hostId, host); assert.equal(settings.threadId, thread);
  assert.equal(settings.model, 'host-model'); assert.equal(settings.reasoningEffort, 'high');
  assert(!JSON.stringify(settings).includes('PRIVATE_'));
  assert.deepEqual(calls, [['catalog', host], ['settings', host, thread]]);
  const failed = await get(`/model-settings?hostId=${host}&threadId=ffffffff-0000-7000-8000-000000000001`);
  assert.equal(failed.status, 503);
  assert(!JSON.stringify(await failed.json()).includes('PRIVATE_'));
});
