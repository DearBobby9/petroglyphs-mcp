import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import express from 'express';
import { BridgeConnection } from '../src/bridge-connection.ts';
import { BridgeDiscovery, installBridgeDiscoveryRoute, privateBridgeOrigin } from '../src/bridge-discovery.ts';

const token = 'a'.repeat(64);
const bridge = (snapshot = {}) => {
  const result = new BridgeConnection(token, async () => ({ localHostname: 'test-mac', addresses: ['192.168.1.10', '100.64.0.1'], tailscaleAddresses: ['100.64.0.1'], ...snapshot }));
  result.setPort(3333); return result;
};
const peer = (ip, extra = {}) => ({ OS: 'darwin', Online: true, TailscaleIPs: [ip], ...extra });

test('MagicDNS directory origins come from trusted status only after exact IP-origin peer validation', async () => {
  const visited = [];
  const discovery = new BridgeDiscovery(bridge({ tailscaleDNSName: 'test-mac.tail123.ts.net' }), {
    readTailscaleStatus: async () => ({ BackendState: 'Running', Peer: {
      currentMac: peer('100.64.0.2', { OS: 'macOS', DNSName: 'Mini.Tail123.ts.net.' }),
      oldMac: peer('100.64.0.3'),
      injectedOrigin: peer('100.64.0.4', { OS: 'macOS', DNSName: 'other.tail123.ts.net.' }),
      invalidDNS: peer('100.64.0.5', { DNSName: 'evil.example' }),
    } }),
    fetchPeer: async origin => {
      visited.push(origin);
      const last = new URL(origin).hostname.split('.').at(-1);
      return { version: 1, bridge: { id: last.repeat(64), name: 'Mac ' + last,
        origin: last === '4' ? 'http://other.tail123.ts.net:3333' : origin,
        dnsName: 'attacker.tail999.ts.net' }, bridges: [{ origin: 'http://attacker.tail999.ts.net:3333' }] };
    },
  });
  const result = await discovery.read(false, 'http://100.64.0.1:3333');
  assert.equal(result.bridge.origin, 'http://100.64.0.1:3333');
  assert.deepEqual(visited, [2, 3, 4, 5].map(last => `http://100.64.0.${last}:3333`));
  assert.deepEqual(result.bridges.map(item => item.origin), ['http://test-mac.tail123.ts.net:3333',
    'http://mini.tail123.ts.net:3333', 'http://100.64.0.3:3333', 'http://100.64.0.5:3333']);
  assert.equal(privateBridgeOrigin('http://mini.tail123.ts.net:3333', 3333), 'http://mini.tail123.ts.net:3333');
  for (const origin of ['http://evil.example:3333', 'http://mini.tail123.ts.net.evil.example:3333', 'http://-mini.tail123.ts.net:3333']) {
    assert.equal(privateBridgeOrigin(origin, 3333), undefined);
  }
});

test('recognizes current macOS and legacy darwin Tailscale labels without admitting other peers', async () => {
  const visited = [];
  const discovery = new BridgeDiscovery(bridge(), {
    readTailscaleStatus: async () => ({ BackendState: 'Running', Peer: {
      currentMac: peer('100.64.0.2', { OS: 'macOS' }), legacyMac: peer('100.64.0.3'),
      offlineMac: peer('100.64.0.4', { OS: 'macOS', Online: false }),
      localOnlyMac: peer('192.168.1.20', { OS: 'macOS' }),
      ipad: peer('100.64.0.5', { OS: 'iOS' }), linux: peer('100.64.0.6', { OS: 'linux' }),
      unknown: peer('100.64.0.7', { OS: '' }),
    } }),
    fetchPeer: async origin => {
      visited.push(origin);
      return { version: 1, bridge: { id: (origin.includes('.2:') ? '2' : '3').repeat(64), name: 'Mac', origin } };
    },
  });
  const result = await discovery.read();
  assert.deepEqual(visited, ['http://100.64.0.2:3333', 'http://100.64.0.3:3333']);
  assert.equal(result.tailscale.availablePeers, 2);
  assert.equal(result.bridges.length, 3);
});

test('discovery probes only online Mac tailnet IPv4 peers at the bridge port and rejects redirected identities', async () => {
  const visited = [];
  const discovery = new BridgeDiscovery(bridge(), {
    readTailscaleStatus: async () => ({ BackendState: 'Running', Peer: {
      valid: peer('100.64.0.2'), badOrigin: peer('100.64.0.3'), oversizedName: peer('100.64.0.4'),
      offline: peer('100.64.0.5', { Online: false }), windows: peer('100.64.0.6', { OS: 'windows' }),
      public: peer('8.8.8.8'), ipv6: peer('fd7a:115c:a1e0::1'), loopback: peer('127.0.0.1'),
      duplicate: peer('100.64.0.2'),
    } }),
    fetchPeer: async origin => {
      visited.push(origin);
      return { version: 1, bridge: { id: origin.includes('.2:') ? '2'.repeat(64) : '3'.repeat(64),
        name: origin.includes('.4:') ? 'x'.repeat(101) : 'Other Mac', origin: origin.includes('.3:') ? 'http://127.0.0.1:3333' : origin },
        ignoredSecrets: 'not copied' };
    },
  });
  const result = await discovery.read();
  assert.deepEqual(visited, ['http://100.64.0.2:3333', 'http://100.64.0.3:3333', 'http://100.64.0.4:3333']);
  assert.equal(result.bridges.length, 2);
  assert.equal(result.bridge.origin, 'http://100.64.0.1:3333');
  assert.equal(result.tailscale.availablePeers, 3);
  assert.deepEqual(Object.keys(result.bridges[1]).sort(), ['id', 'name', 'origin']);
  assert(!JSON.stringify(result).includes(token));
  assert(!JSON.stringify(result).includes('not copied'));
});

test('directory limits concurrency and total results, caches peers, and self queries never recurse', async () => {
  let now = 0, active = 0, maximumActive = 0, calls = 0, reads = 0;
  const peers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i, peer(`100.64.1.${i + 1}`)]));
  const discovery = new BridgeDiscovery(bridge(), { now: () => now,
    readTailscaleStatus: async () => { reads++; return { BackendState: 'Running', Peer: peers }; },
    fetchPeer: async origin => {
      calls++; active++; maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      const address = new URL(origin).hostname.split('.').at(-1);
      return { version: 1, bridge: { id: address.padStart(64, '0'), name: 'Mac ' + address, origin } };
    },
  });
  const local = await discovery.read(true, 'http://192.168.1.10:3333');
  assert.equal(local.bridge.origin, 'http://192.168.1.10:3333');
  assert.equal(local.bridges[0].origin, 'http://100.64.0.1:3333', 'a LAN discovery can offer the same Mac over Tailscale');
  assert.equal(local.bridges.length, 1);
  assert.equal(calls, 0);
  const all = await discovery.read();
  assert.equal(all.bridges.length, 32);
  assert.equal(maximumActive, 4);
  assert.equal(calls, 31);
  assert.equal(reads, 1);
  await discovery.read();
  assert.equal(calls, 31);
  now = 15_001;
  await discovery.read();
  assert.equal(calls, 62);
  assert.equal(reads, 2);
});

test('production peer fetch refuses redirects and bounds even streamed JSON bodies', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false, calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'http://100.64.0.2:3333/api/bridge/discovery?self=1');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16_385)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const discovery = new BridgeDiscovery(bridge(), { readTailscaleStatus: async () => ({ BackendState: 'Running', Peer: { other: peer('100.64.0.2') } }) });
    assert.equal((await discovery.read()).bridges.length, 1);
    assert.equal(calls, 1); assert(cancelled);
  } finally { globalThis.fetch = originalFetch; }
});

test('public discovery validates Host and browser Origin, supports own MagicDNS, and adds no CORS grant', async () => {
  const own = bridge({ tailscaleDNSName: 'test-mac.tail123.ts.net' });
  const discovery = new BridgeDiscovery(own, { readTailscaleStatus: async () => ({ BackendState: 'Running', Self: { DNSName: 'test-mac.tail123.ts.net.' }, Peer: {} }) });
  const app = express(); installBridgeDiscoveryRoute(app, discovery);
  app.use((_req, res) => res.status(403).json({ error: 'Paired device required.' }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  own.setPort(server.address().port);
  const base = `http://127.0.0.1:${own.listenPort}`;
  try {
    const result = await fetch(`${base}/api/bridge/discovery?self=1`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
    assert.equal((await result.json()).bridge.origin, `http://test-mac.tail123.ts.net:${own.listenPort}`);
    const hostRequest = host => new Promise((resolve, reject) => {
      const req = request(`${base}/api/bridge/discovery?self=1`, { headers: { Host: host } }, res => {
        let body = '';
        res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(body) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal((await hostRequest(`evil.example:${own.listenPort}`)).status, 403);
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await fetch(`${base}/api/bridge/discovery`, { headers })).status, 403);
    }
    const dnsResponse = await hostRequest(`test-mac.tail123.ts.net:${own.listenPort}`);
    assert.equal(dnsResponse.status, 200);
    assert.equal(dnsResponse.payload.bridge.origin, `http://test-mac.tail123.ts.net:${own.listenPort}`);
    assert.equal((await fetch(`${base}/api/bridge/discovery?self=all`)).status, 400);
    assert.equal((await fetch(`${base}/api/health`)).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
