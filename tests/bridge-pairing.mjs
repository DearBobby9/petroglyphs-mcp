import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, hkdfSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { BridgeConnection } from '../src/bridge-connection.ts';
import { BridgeDiscovery } from '../src/bridge-discovery.ts';
import { BridgePairings, installBridgePairingRoutes, loopbackApprovalRequest } from '../src/bridge-pairing.ts';
import { startHttp } from '../src/transport-http.ts';

const token = 'e'.repeat(64);

// Node fetch replaces custom Host headers. Raw HTTP exercises the actual Host
// validation boundary without silently testing a different request.
function rawRequest(url, options, body = '') {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end(body);
  });
}

async function fixture() {
  let now = Date.parse('2026-10-17T12:00:00Z');
  const approvals = [];
  const bridge = new BridgeConnection(token, async () => ({ localHostname: 'test-mac', addresses: ['192.168.50.10', '100.64.0.10'],
    tailscaleAddresses: ['100.64.0.10'], tailscaleDNSName: 'test-mac.tail123.ts.net' }));
  const discovery = new BridgeDiscovery(bridge, { readTailscaleStatus: async () => undefined });
  const pairings = new BridgePairings(bridge, token, { now: () => now, openApproval: async url => { approvals.push(url); } });
  const app = express();
  installBridgePairingRoutes(app, pairings, discovery);
  app.use((_req, res) => { res.status(403).json({ error: 'Paired device required.' }); });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  bridge.setPort(server.address().port);
  const base = `http://127.0.0.1:${bridge.listenPort}`;
  const newClient = () => { const client = createECDH('prime256v1'); client.generateKeys(); return client; };
  const body = (client, fields = {}) => ({ clientName: 'My iPad', clientPublicKey: client.getPublicKey().toString('base64'), origin: base, ...fields });
  const create = (client = newClient(), fields = {}, headers = {}) => fetch(`${base}/api/bridge/pairings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body(client, fields)),
  });
  const poll = receipt => fetch(`${base}/api/bridge/pairings/${receipt.id}`, { headers: { 'X-Pairing-Token': receipt.pollToken } });
  const decide = (receipt, decision, headers = {}, capability) => {
    const approval = new URL(approvals.find(url => new URL(url).pathname.endsWith(receipt.id)));
    const body = new URLSearchParams({ decision, cap: capability ?? approval.searchParams.get('cap') }).toString();
    const options = { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...headers,
    } };
    return headers.Host ? rawRequest(approval.origin + approval.pathname, options, body)
      : fetch(approval.origin + approval.pathname, { ...options, body });
  };
  return { server, bridge, base, pairings, approvals, newClient, body, create, poll, decide,
    advance: amount => { now += amount; },
    close: async () => { pairings.close(); await new Promise(resolve => server.close(resolve)); } };
}

function clientKey(client, receipt) {
  return Buffer.from(hkdfSync('sha256', client.computeSecret(Buffer.from(receipt.serverPublicKey, 'base64')), Buffer.from(receipt.salt, 'base64'), 'petroglyphs-wireless-pairing-v1', 32));
}

test('a verified P256 client receives only encrypted credentials after Mac confirmation, with a key-derived code', async () => {
  const f = await fixture();
  try {
    const client = f.newClient();
    const response = await f.create(client, { clientName: '<img src=x onerror=alert(1)>' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const receipt = await response.json();
    assert(!JSON.stringify(receipt).includes(token));
    assert.equal(receipt.expiresAt, '2026-10-17T12:05:00.000Z');
    assert.equal(f.approvals.length, 1);
    assert.equal(receipt.pollToken.length, 43);
    const key = clientKey(client, receipt);
    const expectedCode = String(createHmac('sha256', key).update(`petroglyphs-pairing-code-v1\n${receipt.id}`).digest().readUInt32BE(0) % 1_000_000).padStart(6, '0');
    assert.equal(receipt.code, expectedCode);
    assert.deepEqual(await f.poll(receipt).then(r => r.json()), { state: 'pending' });

    const page = await fetch(f.approvals[0]);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'a same-origin HTTP form must retain its Origin header');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert(!html.includes(token));
    assert(!html.includes(receipt.pollToken));
    assert(html.includes(expectedCode));
    assert.deepEqual(await f.poll(receipt).then(r => r.json()), { state: 'pending' }, 'viewing the approval page grants nothing');
    assert.equal((await f.decide(receipt, 'allow')).status, 200);
    const approved = await f.poll(receipt).then(r => r.json());
    assert.equal(approved.state, 'approved');
    assert(!JSON.stringify(approved).includes(token));
    const decrypt = (aad, decryptKey = key) => {
      const decipher = createDecipheriv('aes-256-gcm', decryptKey, Buffer.from(approved.encrypted.nonce, 'base64'));
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(approved.encrypted.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(approved.encrypted.ciphertext, 'base64')), decipher.final()]);
    };
    assert.deepEqual(JSON.parse(decrypt(receipt.id)), { baseURL: `${f.base}/device/${token}`, bridgeId: f.bridge.id, name: 'test-mac' });
    assert.throws(() => decrypt('a different pairing'), /authenticate|auth/i);
    assert.throws(() => decrypt(receipt.id, clientKey(f.newClient(), receipt)), /authenticate|auth/i);
    assert.deepEqual(await f.poll(receipt).then(r => r.json()), approved, 'repeated polls return the same approved envelope');
  } finally { await f.close(); }
});

test('poll and confirmation capabilities are distinct, wrong credentials and cross-origin requests cannot approve', async () => {
  const f = await fixture();
  try {
    const receipt = await f.create().then(r => r.json());
    assert.equal((await fetch(`${f.base}/api/bridge/pairings/${receipt.id}`, { headers: { 'X-Pairing-Token': 'x'.repeat(43) } })).status, 404);
    const approvalCap = new URL(f.approvals[0]).searchParams.get('cap');
    assert.equal((await fetch(`${f.base}/api/bridge/pairings/${receipt.id}`, { headers: { 'X-Pairing-Token': approvalCap } })).status, 404);
    assert.equal((await fetch(`${f.base}/api/bridge/pairings/${receipt.id}?pollToken=${receipt.pollToken}`)).status, 404);
    assert.equal((await f.decide(receipt, 'allow', {}, receipt.pollToken)).status, 404);
    assert.equal((await f.decide(receipt, 'allow', { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.decide(receipt, 'allow', { Origin: '' })).status, 403);
    assert.equal((await f.decide(receipt, 'allow', { Origin: 'null' })).status, 403);
    assert.equal((await f.decide(receipt, 'allow', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.decide(receipt, 'allow', { Host: `100.64.0.10:${f.bridge.listenPort}` })).status, 403);
    assert.equal((await f.create(undefined, {}, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await rawRequest(`${f.base}/api/bridge/pairings`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Host: `attacker.example:${f.bridge.listenPort}`,
    } }, JSON.stringify(f.body(f.newClient())))).status, 403);
    assert.deepEqual(await f.poll(receipt).then(r => r.json()), { state: 'pending' });
    assert.equal(loopbackApprovalRequest({ socket: { remoteAddress: '100.64.0.2' }, headers: {
      host: `127.0.0.1:${f.bridge.listenPort}`, origin: f.base, 'x-forwarded-for': '127.0.0.1',
    } }, f.bridge.listenPort, true), false, 'a remote socket cannot spoof loopback approval with headers');
  } finally { await f.close(); }
});

test('pairing binds credentials to the owned MagicDNS origin and rejects other tailnet hosts', async () => {
  const f = await fixture();
  try {
    const client = f.newClient(), origin = `http://test-mac.tail123.ts.net:${f.bridge.listenPort}`;
    const response = await f.create(client, { origin });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal((await f.create(undefined, { origin: `http://other-mac.tail123.ts.net:${f.bridge.listenPort}` })).status, 400);
    await f.decide(receipt, 'allow');
    const { encrypted } = await f.poll(receipt).then(r => r.json());
    const decipher = createDecipheriv('aes-256-gcm', clientKey(client, receipt), Buffer.from(encrypted.nonce, 'base64'));
    decipher.setAAD(Buffer.from(receipt.id)); decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]);
    assert.equal(JSON.parse(plaintext).baseURL, `${origin}/device/${token}`);
  } finally { await f.close(); }
});

test('reject, cancel, expiry and moved interfaces never release credentials', async () => {
  const f = await fixture();
  try {
    const rejected = await f.create().then(r => r.json());
    await f.decide(rejected, 'reject');
    assert.deepEqual(await f.poll(rejected).then(r => r.json()), { state: 'rejected' });
    await f.decide(rejected, 'allow');
    assert.deepEqual(await f.poll(rejected).then(r => r.json()), { state: 'rejected' });
    const cancelled = await f.create().then(r => r.json());
    assert.equal((await fetch(`${f.base}/api/bridge/pairings/${cancelled.id}`, { method: 'DELETE', headers: { 'X-Pairing-Token': cancelled.pollToken } })).status, 204);
    assert.deepEqual(await f.poll(cancelled).then(r => r.json()), { state: 'rejected' });
    const expired = await f.create().then(r => r.json());
    f.advance(5 * 60_000);
    await f.decide(expired, 'allow');
    assert.deepEqual(await f.poll(expired).then(r => r.json()), { state: 'expired' });
    f.advance(60_000);
    assert.equal((await f.poll(expired)).status, 404);

    let addresses = ['192.168.1.10'];
    const bridge = new BridgeConnection(token, async () => ({ localHostname: 'test', addresses, tailscaleAddresses: [] }));
    bridge.setPort(3333);
    let approval;
    const service = new BridgePairings(bridge, token, { openApproval: async url => { approval = new URL(url); } });
    try {
      const receipt = await service.create(f.body(f.newClient(), { origin: 'http://192.168.1.10:3333' }), 'test');
      addresses = ['192.168.1.20'];
      await service.decide(receipt.id, approval.searchParams.get('cap'), 'allow');
      assert.deepEqual(service.poll(receipt.id, receipt.pollToken), { state: 'expired' });
    } finally { service.close(); }
  } finally { await f.close(); }
});

test('invalid origins, invalid curve points, oversized bodies and request floods fail safely', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.pairings.create(f.body(f.newClient()), '100.64.0.50'), error => error.code === 'invalid_pairing',
      'a remote client cannot request loopback credentials intended for local setup and tests');
    for (const origin of ['http://8.8.8.8:3333', `${f.base}/path`, `${f.base}?query=1`, 'http://100.64.0.99:3333']) {
      assert.equal((await f.create(undefined, { origin })).status, 400);
    }
    assert.equal((await f.create(undefined, { clientPublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64') })).status, 400);
    assert.equal((await f.create()).status, 429);
    assert.equal(f.approvals.length, 0);
    f.advance(60_000);
    assert.equal((await fetch(`${f.base}/api/bridge/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(9000) }) })).status, 413);
    assert.equal((await fetch(`${f.base}/api/bridge/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    const receipts = await Promise.all(Array.from({ length: 7 }, (_, i) => f.pairings.create(f.body(f.newClient(), {
      origin: `http://100.64.0.10:${f.bridge.listenPort}`,
    }), `source-${i}`).then(value => ({ value }), error => ({ error }))));
    assert.equal(receipts.filter(result => result.value).length, 5, 'concurrent creation cannot exceed five pending confirmations');
    assert.equal(receipts.filter(result => result.error?.code === 'pairing_busy').length, 2);
    assert.equal(f.approvals.length, 5);
  } finally { await f.close(); }
});

for (const ipv6Only of [false, true]) test(`an explicit ${ipv6Only ? 'IPv6 loopback' : 'private'} bind keeps a local approval socket and preserves the approval boundary`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'petroglyphs-pairing-bind-'));
  const token = 'f'.repeat(32);
  const config = join(directory, 'bridge.json');
  await writeFile(config, JSON.stringify({ deviceToken: token, codexPath: '/not-used/codex', dataDir: join(directory, 'data') }));
  const bindAddress = ipv6Only ? '::1' : Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .find(entry => entry.family === 'IPv4' && !entry.internal)?.address ?? '127.0.0.2';
  const saved = {
    bridgeConfig: process.env.PETROGLYPHS_BRIDGE_CONFIG,
    autoReplyConfig: process.env.PETROGLYPHS_AUTO_REPLY_CONFIG,
    bindHost: process.env.PETROGLYPHS_BIND_HOST,
    requireAuth: process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH,
    legacy: process.env.PETROGLYPHS_LEGACY_SUBMISSIONS,
  };
  let server;
  process.env.PETROGLYPHS_BRIDGE_CONFIG = config;
  delete process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
  process.env.PETROGLYPHS_BIND_HOST = bindAddress;
  process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH = '1';
  process.env.PETROGLYPHS_LEGACY_SUBMISSIONS = '0';
  try {
    try { server = await startHttp(0); }
    catch (error) {
      if (bindAddress === '127.0.0.2' && error?.code === 'EADDRNOTAVAIL') {
        t.skip('No nonloopback IPv4 interface is available for the listener fixture.');
        return;
      }
      throw error;
    }
    const address = server.address();
    assert.equal(address.address, bindAddress);
    const port = address.port;
    const pairingPath = `/bridge/pairing/00000000-0000-4000-8000-000000000001?cap=${'x'.repeat(43)}`;

    // The URL opened on the Mac reaches the pairing route through the
    // secondary listener. The unknown capability is intentionally tested only
    // after the loopback gate, so this would be 403 if the socket were absent.
    const localApproval = await fetch(`http://127.0.0.1:${port}${pairingPath}`);
    assert.equal(localApproval.status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 403, 'the local socket does not bypass device auth');
    assert.equal((await fetch(`http://127.0.0.1:${port}/device/${token}/api/health`)).status, 200);

    // The same approval URL is never accepted on the private-interface
    // listener: its Host is not canonical loopback even when the test process
    // itself originates from a loopback address.
    const privateApproval = await fetch(`http://${ipv6Only ? '[::1]' : bindAddress}:${port}${pairingPath}`);
    assert.equal(privateApproval.status, 403);

    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed|ECONNREFUSED|closed/i);
    await assert.rejects(fetch(`http://${ipv6Only ? '[::1]' : bindAddress}:${port}/`), /fetch failed|ECONNREFUSED|closed/i);
    server = undefined;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (saved.bridgeConfig === undefined) delete process.env.PETROGLYPHS_BRIDGE_CONFIG;
    else process.env.PETROGLYPHS_BRIDGE_CONFIG = saved.bridgeConfig;
    if (saved.autoReplyConfig === undefined) delete process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
    else process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = saved.autoReplyConfig;
    if (saved.bindHost === undefined) delete process.env.PETROGLYPHS_BIND_HOST;
    else process.env.PETROGLYPHS_BIND_HOST = saved.bindHost;
    if (saved.requireAuth === undefined) delete process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH;
    else process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH = saved.requireAuth;
    if (saved.legacy === undefined) delete process.env.PETROGLYPHS_LEGACY_SUBMISSIONS;
    else process.env.PETROGLYPHS_LEGACY_SUBMISSIONS = saved.legacy;
    await rm(directory, { recursive: true, force: true });
  }
});
