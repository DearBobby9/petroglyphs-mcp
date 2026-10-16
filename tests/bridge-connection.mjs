import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeConnection } from '../dist/bridge-connection.js';
import { startHttp } from '../dist/transport-http.js';

const token = 'c'.repeat(32);
const nonce = '7'.repeat(64);

test('publishes current private interfaces and a stable hostname, only verified Tailscale addresses', async () => {
  let snapshot = { localHostname: 'Paired-Mac', addresses: ['192.168.1.10', '100.64.0.10', '8.8.8.8', '169.254.1.1'], tailscaleAddresses: ['100.64.0.10', '100.64.0.99'] };
  const bridge = new BridgeConnection(token, async () => snapshot);
  bridge.setPort(3333);
  assert.deepEqual(await bridge.metadata(), {
    version: 1, id: bridge.id,
    lanOrigins: ['http://paired-mac.local:3333', 'http://192.168.1.10:3333'],
    tailscaleOrigins: ['http://100.64.0.10:3333'],
  });
  snapshot = { ...snapshot, addresses: ['192.168.1.20', '100.64.0.10'] };
  assert.equal(await bridge.proof(nonce, 'http://192.168.1.10:3333'), undefined, 'cannot sign an expired DHCP lease');
  assert((await bridge.metadata()).lanOrigins.includes('http://192.168.1.20:3333'));
});

test('identity proofs bind the challenge and owned origin and do not disclose credentials', async () => {
  const bridge = new BridgeConnection(token, async () => ({ localHostname: 'paired-mac', addresses: ['192.168.1.20'], tailscaleAddresses: [] }));
  bridge.setPort(3333);
  const origin = 'http://paired-mac.local:3333';
  const proof = await bridge.proof(nonce, origin);
  assert.equal(proof.proof, createHmac('sha256', token).update(`petroglyphs-bridge-proof-v1\n${nonce}\n${origin}\n${bridge.id}`).digest('hex'));
  assert(!JSON.stringify(proof).includes(token));
  for (const other of ['http://192.168.1.99:3333', 'http://paired-mac.local:4444', origin + '/path', origin + '?query=1', 'http://user@paired-mac.local:3333', 'https://paired-mac.local:3333']) {
    assert.equal(await bridge.proof(nonce, other), undefined, `refuses relayed/unowned origin: ${other}`);
  }
  assert.equal(await bridge.proof('short', origin), undefined);
  assert.notEqual((await bridge.proof('8'.repeat(64), origin)).proof, proof.proof);
  assert.equal(new BridgeConnection(token).id, bridge.id, 'identity survives process restarts');
  assert.notEqual(new BridgeConnection('e'.repeat(32)).id, bridge.id, 'new pairing uses a new identity');
});

test('only identity challenge bypasses required pairing; connection metadata stays private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'petroglyphs-bridge-'));
  const config = join(directory, 'auto.json');
  await writeFile(config, JSON.stringify({ deviceToken: token, codexPath: '/not-used/codex', dataDir: join(directory, 'data') }));
  process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = config;
  process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH = '1';
  let server;
  try {
    server = await startHttp(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const query = new URLSearchParams({ nonce, origin: base });
    const identity = await fetch(`${base}/api/bridge/identity?${query}`);
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await identity.json()).sort(), ['id', 'nonce', 'origin', 'proof']);
    assert.equal((await fetch(`${base}/api/health`)).status, 403);
    const health = await fetch(`${base}/device/${token}/api/health`).then(response => response.json());
    assert.equal(health.bridge.version, 1);
    assert(!JSON.stringify(health.bridge).includes(token));
    assert.equal((await fetch(`${base}/api/bridge/identity?${new URLSearchParams({ nonce, origin: 'http://attacker.local:3333' })}`)).status, 400);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    delete process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH;
    delete process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
    await rm(directory, { recursive: true, force: true });
  }
});
