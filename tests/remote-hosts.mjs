import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteHosts, RemoteHostError } from '../src/remote-hosts.ts';

const hostId = 'remote-control:env_test_remote';
const unavailableId = 'remote-control:env_discovered_only';
const threadId = '00000000-0000-7000-8000-000000000003';
const otherThreadId = '00000000-0000-7000-8000-000000000004';
const submissionId = '00000000-0000-7000-8000-000000000005';
const token = 'a'.repeat(48);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const drawing = { image: png, threadId,
  strokeMetadata: { strokeCount: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, duration: 1 } };

async function fixture(t, handler, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const item = { method: request.method, url: new URL(request.url, 'http://localhost'),
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined };
      requests.push(item);
      await handler(item, response, request);
    } catch { response.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(dir, 'remote.json');
  const cachePath = join(dir, 'cache.json');
  const config = { hosts: [{ id: hostId, name: 'Test remote', url: base, deviceToken: token }] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(cachePath, JSON.stringify({
    'remote-connection-auto-connect-by-host-id': { [unavailableId]: false, local: true, 'http://evil': true },
    'remote-projects': [{ hostId, remotePath: 'PRIVATE_PROJECT_PATH' }],
    'electron-remote-control-client-enrollments': { secret: 'PRIVATE_ENROLLMENT' },
    'electron-persisted-atom-state': { history: 'PRIVATE_HISTORY' },
  }));
  const load = (overrides = {}) => RemoteHosts.fromEnvironment({ env: { PETROGLYPHS_REMOTE_CONFIG: configPath },
    cachePath, ...options, ...overrides });
  return { dir, config, configPath, cachePath, requests, base, load, hosts: await load() };
}

const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

test('remote routing preserves the drawing and receipt while keeping credentials and proxy selection server-side', async t => {
  const f = await fixture(t, (request, response) => {
    assert(request.url.pathname.startsWith(`/device/${token}/api/`));
    if (request.method === 'POST') return json(response, { id: submissionId, threadId, status: 'received', hostId: 'local' });
    if (request.url.pathname.endsWith('/threads')) {
      return json(response, { threads: [{ id: threadId, title: 'Remote sketch', cwd: 'C:\\Project', updatedAt: 100,
        preview: 'PRIVATE_PREVIEW', turns: ['PRIVATE_HISTORY'] }], nextCursor: 'page 2 & 3' });
    }
    return json(response, { id: submissionId, threadId, hostId: 'local', state: 'completed',
      messages: [{ id: 'answer', text: '看到了一个三角形。', phase: 'final_answer' }],
      coalescedSubmissionIds: [submissionId, otherThreadId],
      imagePath: 'PRIVATE_IMAGE_PATH', error: `PRIVATE_ERROR ${f.base}/device/${token}`, notice: 'PRIVATE_NOTICE' });
  });
  const hosts = await f.hosts.listHosts();
  assert.deepEqual(hosts.find(host => host.id === hostId), {
    id: hostId, name: 'Test remote', kind: 'remote', configured: true, available: true,
  });
  assert.equal(hosts.find(host => host.id === unavailableId).available, false);
  assert.equal(hosts.length, 2);
  assert(!JSON.stringify(hosts).includes('PRIVATE_'));
  assert(!JSON.stringify(hosts).includes(token));
  assert(!JSON.stringify(hosts).includes(f.base));

  const page = await f.hosts.listThreads(hostId, { search: 'A & B', cursor: 'page ? 1' });
  assert.equal(f.requests[0].url.searchParams.get('search'), 'A & B');
  assert.equal(f.requests[0].url.searchParams.get('cursor'), 'page ? 1');
  assert.equal(page.nextCursor, 'page 2 & 3');
  assert(!JSON.stringify(page).includes('PRIVATE_'));

  const receipt = await f.hosts.submit(hostId, { ...drawing, hostId: 'remote-control:env_loop', pairing_code: 'LOCAL_CODE' });
  assert.deepEqual(receipt, { id: submissionId, threadId, status: 'received', hostId });
  assert.deepEqual(f.requests[1].body, { ...drawing, combo: null });
  assert.equal(Buffer.from(f.requests[1].body.image, 'base64').toString('base64'), png);
  assert.equal(f.requests[1].body.hostId, undefined);
  assert.equal(f.requests[1].body.pairing_code, undefined);

  const status = await f.hosts.submission(hostId, submissionId);
  assert.equal(status.id, submissionId);
  assert.equal(status.hostId, hostId);
  assert.equal(status.messages[0].text, '看到了一个三角形。');
  assert.deepEqual(status.coalescedSubmissionIds, [submissionId, otherThreadId]);
  assert.match(status.notice, /reply is shared/);
  assert(!JSON.stringify(status).includes('PRIVATE_'));
  assert(!JSON.stringify(status).includes(token));
  assert(!JSON.stringify(status).includes(f.base));
  assert.equal(f.requests[2].url.searchParams.has('hostId'), false);

  await assert.rejects(f.hosts.listThreads(unavailableId, {}), error => error instanceof RemoteHostError && error.status === 503);
  await assert.rejects(f.hosts.listThreads('remote-control:env_unknown', {}), error => error.status === 404);
  await assert.rejects(f.hosts.listThreads('http://unregistered.invalid', {}), error => error.status === 404);
  assert.equal(f.requests.length, 3, 'unknown or unconfigured hosts must never reach the network');
});

test('failed, redirected, timed out and mismatched remote submissions never report success or retry', async t => {
  let mode = 'failed';
  let receivedTimeout;
  const timeoutReceived = new Promise(resolve => { receivedTimeout = resolve; });
  const f = await fixture(t, (request, response) => {
    if (mode === 'failed') return json(response, { error: `PRIVATE_ERROR /device/${token}` }, 500);
    if (mode === 'redirect') { response.writeHead(302, { location: `${f.base}/credential-leak` }); response.end(); return; }
    if (mode === 'mismatch') return json(response, { id: submissionId, threadId: otherThreadId, status: 'received' });
    if (mode === 'timeout') { receivedTimeout(); return; }
    if (mode === 'malformed') { response.end('PRIVATE_BAD_JSON'); return; }
    response.destroy();
  });
  for (const next of ['failed', 'redirect', 'mismatch', 'malformed', 'disconnect']) {
    mode = next;
    const before = f.requests.length;
    await assert.rejects(f.hosts.submit(hostId, drawing), error => {
      assert.equal(error.status, 503);
      assert(!error.message.includes('PRIVATE_'));
      assert(!error.message.includes(token));
      assert(!error.message.includes(f.base));
      return true;
    });
    assert.equal(f.requests.length, before + 1, 'POST must be attempted only once, including redirects');
  }
  mode = 'timeout';
  const bounded = await f.load({ timeoutMs: 80 });
  const pending = bounded.submit(hostId, drawing);
  const assertion = assert.rejects(pending, error => error.status === 503 && error.message.includes('before retrying'));
  await timeoutReceived;
  await assertion;
  assert.equal(f.requests.length, 6);
});

test('configuration rejects public HTTP, embedded credentials, extra paths, duplicate IDs and exposed secret files', async t => {
  const f = await fixture(t, (_request, response) => json(response, {}));
  for (const url of ['http://example.com', 'ftp://127.0.0.1', `https://user:${token}@example.com`,
    `https://example.com/device/${token}`, `https://example.com?token=${token}`, 'https://example.com/#secret']) {
    await writeFile(f.configPath, JSON.stringify({ hosts: [{ ...f.config.hosts[0], url }] }));
    await assert.rejects(f.load(), error => error instanceof RemoteHostError && !error.message.includes(token)
      && !error.message.includes(url));
  }
  await writeFile(f.configPath, JSON.stringify({ hosts: [f.config.hosts[0], f.config.hosts[0]] }));
  await assert.rejects(f.load(), /configuration is invalid/);
  await writeFile(f.configPath, JSON.stringify(f.config));
  if (process.platform !== 'win32') {
    await chmod(f.configPath, 0o644);
    await assert.rejects(f.load(), /configuration is invalid/);
    await chmod(f.configPath, 0o600);
  }
  const noConfig = await f.load({ env: {} });
  assert((await noConfig.listHosts()).every(host => !host.configured));
  assert.equal(f.requests.length, 0);
});

test('submission polling rejects a different receipt and bounds oversized remote responses', async t => {
  let mode = 'mismatch';
  const f = await fixture(t, (_request, response) => {
    if (mode === 'mismatch') return json(response, { id: otherThreadId, threadId, state: 'completed', messages: [] });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('x'.repeat(4 * 1024 * 1024 + 1));
  });
  await assert.rejects(f.hosts.submission(hostId, submissionId), error => error.status === 503);
  await assert.rejects(f.hosts.submission(hostId, '../invalid'), error => error.status === 400);
  mode = 'oversized';
  await assert.rejects(f.hosts.listThreads(hostId, {}), error => error.status === 503);
  assert.equal(f.requests.length, 2);
});
