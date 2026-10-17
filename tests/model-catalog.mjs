import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexModelCatalog } from '../src/codex-model-catalog.ts';
import { MODEL_CATALOG_TTL_MS } from '../src/codex-model-catalog-source.ts';

const hostId = 'remote-control:env_catalogue_test';
const otherHost = 'remote-control:env_catalogue_other';
const tailUrl = 'http://100.64.2.3:19765';
const model = (name, images = true) => ({ id: name, model: name, displayName: name, description: '',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'max', description: '' }],
  defaultReasoningEffort: 'medium', inputModalities: images ? ['text', 'image'] : ['text'], isDefault: true });
const snapshot = (now, name = 'remote-model', images = true) => ({ version: 1, source: 'codex-app-server', observedAt: new Date(now).toISOString(), models: [model(name, images)] });

async function fixture(t, handler) {
  const intendedRequests = [];
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const actualUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options, callback) => {
    intendedRequests.push({ url, options });
    return httpRequest(actualUrl + new URL(url).pathname, options, callback);
  };
  return { request, intendedRequests };
}
function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}

test('host binding, concurrent reads and TTL keep local and remote capabilities isolated', async t => {
  let now = Date.now();
  let localReads = 0;
  let remoteReads = 0;
  let fail = false;
  const f = await fixture(t, (_request, response) => {
    remoteReads++;
    if (fail) return json(response, { error: 'PRIVATE_REMOTE_FAILURE' }, 503);
    json(response, { ...snapshot(now), hostId: 'local', credentials: 'PRIVATE_CREDENTIALS' });
  });
  const catalog = new CodexModelCatalog({ codexPath: '/test/codex', hosts: [{ id: hostId, url: tailUrl }], now: () => now,
    request: f.request, readLocal: async () => { localReads++; return snapshot(now, 'local-model'); } });
  const results = await Promise.all([catalog.list(hostId), catalog.list(hostId), catalog.list('local')]);
  assert.equal(remoteReads, 1); assert.equal(localReads, 1);
  assert.equal(results[0].hostId, hostId); assert.equal(results[0].source, 'tailscale-model-agent');
  assert.deepEqual(results[0].models.map(model => model.model), ['remote-model']);
  assert.deepEqual(results[2].models.map(model => model.model), ['local-model']);
  assert(!JSON.stringify(results).includes('PRIVATE_'));
  results[0].models[0].model = 'tampered';
  assert.equal((await catalog.list(hostId)).models[0].model, 'remote-model');
  assert.equal(f.intendedRequests[0].url, `${tailUrl}/models`);
  assert.equal(f.intendedRequests[0].options.method, 'GET');
  assert.equal(f.intendedRequests[0].options.agent, false);
  assert.equal((await catalog.list(otherHost)).reason, 'not_configured');
  assert.equal(remoteReads, 1);
  now += MODEL_CATALOG_TTL_MS; fail = true;
  const expired = await catalog.list(hostId);
  assert.equal(expired.status, 'unavailable'); assert.deepEqual(expired.models, []);
  assert.equal(expired.observedAt, null); assert.equal(remoteReads, 2);
  assert.equal(localReads, 1, 'a remote failure must not consult the local catalogue');
});

test('selection rejects unsupported host models, effort and image input before callers mutate settings', async () => {
  const catalog = new CodexModelCatalog({ codexPath: '/test/codex', readLocal: async () => snapshot(Date.now(), 'text-only', false) });
  assert.equal((await catalog.requireSelection('local', { model: 'text-only', reasoningEffort: 'max' })).model, 'text-only');
  await assert.rejects(catalog.requireSelection('local', { model: 'remote-only', reasoningEffort: 'max' }), error => error.code === 'unsupported_model');
  await assert.rejects(catalog.requireSelection('local', { model: 'text-only', reasoningEffort: 'ultra' }), error => error.code === 'unsupported_reasoning_effort');
  await assert.rejects(catalog.requireSelection('local', { model: 'text-only', reasoningEffort: 'medium', hasImages: true }), error => error.code === 'unsupported_input_modality');
  await assert.rejects(catalog.requireSelection(hostId, { model: 'text-only', reasoningEffort: 'max' }), error => error.status === 503);
  await assert.rejects(catalog.requireSelection('local', null), error => error.status === 400);
});

test('remote transport rejects redirects, excessive responses, invalid payloads and stale source times', async t => {
  const now = Date.now();
  let mode;
  const f = await fixture(t, (_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { location: `${tailUrl}/elsewhere` }); response.end(); return; }
    if (mode === 'length') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 }); response.end(); return; }
    if (mode === 'stream') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('a'.repeat(1024 * 1024 + 1)); return; }
    if (mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('PRIVATE_JSON'); return; }
    if (mode === 'timeout') return;
    if (mode === 'disconnect') { response.destroy(); return; }
    if (mode === 'stale') return json(response, snapshot(now - MODEL_CATALOG_TTL_MS));
    if (mode === 'future') return json(response, snapshot(now + 31_000));
    if (mode === 'invalid') return json(response, { ...snapshot(now), models: [{ ...model('remote'), defaultReasoningEffort: 'unlisted' }] });
  });
  for (mode of ['redirect', 'length', 'stream', 'malformed', 'timeout', 'disconnect', 'stale', 'future', 'invalid']) {
    const catalog = new CodexModelCatalog({ codexPath: '/test/codex', hosts: [{ id: hostId, url: tailUrl }], now: () => now,
      request: f.request, timeoutMs: 300, readLocal: async () => { throw new Error('Local must not be called'); } });
    const result = await catalog.list(hostId);
    assert.equal(result.status, 'unavailable', mode); assert.deepEqual(result.models, [], mode);
    if (mode === 'stale') assert.equal(result.reason, 'catalogue_stale');
    assert(!JSON.stringify(result).includes('PRIVATE_'));
  }
  assert.equal(f.intendedRequests.length, 9, 'no automatic redirects or retry requests');
});

test('private mapping rejects public, LAN, loopback, hostname and ambiguous endpoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-catalog-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  const load = () => CodexModelCatalog.fromEnvironment({ codexPath: '/test/codex', env: { PETROGLYPHS_MODEL_CATALOG_CONFIG: path } });
  const write = value => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  for (const url of ['http://127.0.0.1:19765', 'http://192.168.1.2:19765', 'http://100.63.2.3:19765', 'http://100.128.2.3:19765',
    'http://100.999.2.3:19765', 'http://peer.ts.net:19765', 'http://example.com:19765', 'http://100.64.2.3:19765/models',
    'http://user:PRIVATE_SECRET@100.64.2.3:19765', 'http://100.64.2.3:19765?token=PRIVATE_SECRET']) {
    await write({ hosts: [{ id: hostId, url }] });
    await assert.rejects(load(), error => error.code === 'invalid_configuration' && !error.message.includes('PRIVATE_'));
  }
  await write({ hosts: [{ id: hostId, url: tailUrl }, { id: otherHost, url: tailUrl }] });
  await assert.rejects(load(), error => error.code === 'invalid_configuration');
  await write({ hosts: [{ id: hostId, url: tailUrl }] });
  assert(await load());
  await chmod(path, 0o644);
  await assert.rejects(load(), error => error.code === 'invalid_configuration');
});
