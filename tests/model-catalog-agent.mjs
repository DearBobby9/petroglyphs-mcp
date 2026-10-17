import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createModelCatalogAgentHandler, parseModelCatalogAgentConfiguration, startModelCatalogAgent } from '../src/codex-model-catalog-agent.ts';

const config = { codexPath: '/test/codex', bindAddress: '100.64.2.3', port: 19765, allowedSourceAddresses: ['100.64.2.4'] };
const data = () => ({ version: 1, source: 'codex-app-server', observedAt: new Date().toISOString(), models: [{
  id: 'remote-model', model: 'remote-model', displayName: 'Remote', description: '',
  supportedReasoningEfforts: [{ reasoningEffort: 'max', description: '' }], defaultReasoningEffort: 'max',
  inputModalities: ['text', 'image'], isDefault: true, instructions: 'PRIVATE_INSTRUCTIONS',
}], identity: 'PRIVATE_ACCOUNT' });

async function fixture(t, reader) {
  let peer = config.allowedSourceAddresses[0];
  const handler = createModelCatalogAgentHandler(config, reader);
  const server = createServer((request, response) => {
    // Simulate the kernel-provided peer at the external transport boundary.
    Object.defineProperty(request.socket, 'remoteAddress', { value: peer, configurable: true });
    handler(request, response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, setPeer: value => { peer = value; } };
}

test('agent only serves GET /models to configured socket peers and ignores forwarded identity', async t => {
  let reads = 0;
  const f = await fixture(t, async () => { reads++; return data(); });
  f.setPeer('100.64.2.5');
  const denied = await fetch(`${f.base}/models`, { headers: { 'x-forwarded-for': config.allowedSourceAddresses[0] } });
  assert.equal(denied.status, 403); assert.equal(reads, 0);
  f.setPeer(config.allowedSourceAddresses[0]);
  assert.equal((await fetch(`${f.base}/other`)).status, 404);
  assert.equal((await fetch(`${f.base}/models?hostId=local`)).status, 404);
  assert.equal((await fetch(`${f.base}/models`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal(reads, 0);
  const result = await fetch(`${f.base}/models`);
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.equal(body.models.length, 1); assert(!JSON.stringify(body).includes('PRIVATE_'));
  assert.equal(Object.hasOwn(body, 'hostId'), false);
  await fetch(`${f.base}/models`); assert.equal(reads, 1);
});

test('concurrent reads share one host request and source errors expose no private details', async t => {
  let reads = 0;
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const source = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => { reads++; started(); return source; });
  const first = fetch(`${f.base}/models`);
  const second = fetch(`${f.base}/models`);
  await ready;
  release(data());
  assert.equal((await first).status, 200); assert.equal((await second).status, 200); assert.equal(reads, 1);
  const failing = await fixture(t, async () => { throw new Error('PRIVATE_ACCOUNT /secret/path'); });
  const response = await fetch(`${failing.base}/models`);
  assert.equal(response.status, 503); assert(!JSON.stringify(await response.json()).includes('PRIVATE_'));
});

test('agent refuses non-Tailscale bind or source addresses before listening', async () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '192.168.1.2', '::', 'peer.ts.net', '100.63.2.3']) {
    assert.throws(() => parseModelCatalogAgentConfiguration({ ...config, bindAddress: address }), error => error.code === 'invalid_configuration');
    await assert.rejects(startModelCatalogAgent({ ...config, allowedSourceAddresses: [address] }), error => error.code === 'invalid_configuration');
  }
  assert.throws(() => parseModelCatalogAgentConfiguration({ ...config, allowedSourceAddresses: [] }), error => error.code === 'invalid_configuration');
  assert.throws(() => parseModelCatalogAgentConfiguration({ ...config, codexPath: 'codex' }), error => error.code === 'invalid_configuration');
});
