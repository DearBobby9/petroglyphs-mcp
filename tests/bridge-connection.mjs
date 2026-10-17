import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
    version: 1, id: bridge.id, name: 'Paired-Mac',
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

test('publishes and proves only the owned MagicDNS name with a current Tailscale interface', async () => {
  let snapshot = { localHostname: 'paired-mac', addresses: ['100.64.0.10'], tailscaleAddresses: ['100.64.0.10'],
    tailscaleDNSName: 'Paired-Mac.Tail123.TS.NET.' };
  const bridge = new BridgeConnection(token, async () => snapshot);
  bridge.setPort(3333);
  const dnsOrigin = 'http://paired-mac.tail123.ts.net:3333';
  assert.deepEqual((await bridge.metadata()).tailscaleOrigins, [dnsOrigin, 'http://100.64.0.10:3333']);
  assert.equal((await bridge.proof(nonce, dnsOrigin)).origin, dnsOrigin);
  for (const origin of ['http://other-mac.tail123.ts.net:3333', 'http://paired-mac.tail999.ts.net:3333', 'http://paired-mac.tail123.ts.net:4444']) {
    assert.equal(await bridge.proof(nonce, origin), undefined);
  }
  for (const hostname of ['evil.example', 'mac.tail123.ts.net.evil.example', '-mac.tail123.ts.net', 'x'.repeat(64) + '.tail123.ts.net', 'mac.tail123.ts.net..']) {
    snapshot = { ...snapshot, tailscaleDNSName: hostname };
    assert.deepEqual((await bridge.metadata()).tailscaleOrigins, ['http://100.64.0.10:3333']);
  }
  snapshot = { ...snapshot, tailscaleDNSName: 'paired-mac.tail123.ts.net', addresses: ['192.168.1.10'] };
  assert.deepEqual((await bridge.metadata()).tailscaleOrigins, []);
  assert.equal(await bridge.proof(nonce, dnsOrigin), undefined, 'a disconnected Tailscale interface cannot sign a cached DNS candidate');
});

test('identity challenge works before pairing while authenticated connection metadata stays private', async () => {
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

test('paired identity and new routes initialize even when legacy receipt recovery fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'petroglyphs-isolated-bridge-'));
  const config = join(directory, 'settings.json'), dataDir = join(directory, 'data');
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'corrupt-legacy.json'), 'unrecoverable legacy receipt');
  await writeFile(config, JSON.stringify({ deviceToken: token, codexPath: '/not-used/codex', dataDir }));
  process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = config;
  let server;
  try {
    server = await startHttp(0);
    const base = `http://127.0.0.1:${server.address().port}`, paired = `${base}/device/${token}`;
    const identity = await fetch(`${base}/api/bridge/identity?${new URLSearchParams({ nonce, origin: base })}`).then(r => r.json());
    assert.equal(identity.id, new BridgeConnection(token).id);
    assert.equal((await fetch(`${paired}/api/codex/hosts`)).status, 200);
    assert.equal((await fetch(`${paired}/api/codex/conversation?hostId=local&threadId=00000000-0000-7000-8000-000000000001`)).status, 503);
    assert.equal((await fetch(`${paired}/api/codex/submissions?threadId=00000000-0000-7000-8000-000000000001`)).status, 503);
    await new Promise(resolve => server.close(resolve)); server = undefined;
    delete process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
    process.env.PETROGLYPHS_BRIDGE_CONFIG = config;
    process.env.PETROGLYPHS_LEGACY_SUBMISSIONS = '0';
    process.env.PETROGLYPHS_CODEX_DESKTOP = '1';
    server = await startHttp(0);
    const independent = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/mcp', '/mcp/', '/MCP']) {
      assert.equal((await fetch(`${independent}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    }
    const pairedMcp = await fetch(`${independent}/device/${token}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual(pairedMcp.status, 403);
    assert.notEqual(pairedMcp.status, 404);
    const modernHealth = await fetch(`${independent}/device/${token}/api/health`).then(r => r.json());
    assert.equal(modernHealth.autoReply.enabled, false);
    assert.equal(modernHealth.capabilities.conversations, true);

    const proof = await fetch(`${independent}/api/bridge/identity?${new URLSearchParams({ nonce, origin: independent })}`).then(r => r.json());
    assert.equal(proof.id, identity.id, 'configuration alias and worker opt-out preserve the existing pairing identity');
    assert.equal((await fetch(`${independent}/device/${token}/api/codex/hosts`)).status, 200);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    delete process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
    delete process.env.PETROGLYPHS_BRIDGE_CONFIG;
    delete process.env.PETROGLYPHS_LEGACY_SUBMISSIONS;
    delete process.env.PETROGLYPHS_CODEX_DESKTOP;
    await rm(directory, { recursive: true, force: true });
  }
});
