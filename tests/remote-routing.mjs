import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttp } from '../dist/transport-http.js';

const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-remote-route-'));
const token = 'c'.repeat(32);
const remoteToken = 'e'.repeat(32);
const hostId = 'remote-control:env_test_remote';
const threadId = '00000000-0000-7000-8000-000000000003';
const id = '00000000-0000-7000-8000-000000000004';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const strokeMetadata = { strokeCount: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, duration: 0 };
const calls = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, 'http://upstream');
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  calls.push({ method: req.method, url, body });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === `/device/${remoteToken}/api/codex/threads`) {
    res.end(JSON.stringify({ threads: [{ id: threadId, title: 'Remote drawing', cwd: '/remote/project', updatedAt: 1234 }], nextCursor: 'opaque-next' }));
  } else if (url.pathname === `/device/${remoteToken}/api/submit`) {
    res.end(JSON.stringify({ id, threadId, hostId: 'local', status: 'received' }));
  } else if (url.pathname === `/device/${remoteToken}/api/codex/submissions/${id}`) {
    res.end(JSON.stringify({ id, threadId, hostId: 'local', state: 'completed', messages: [{ id: 'reply', text: 'Remote answer', phase: 'final_answer' }] }));
  } else { res.statusCode = 404; res.end('{}'); }
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const configPath = join(dir, 'config.json');
const remotePath = join(dir, 'remote.json');
const dataDir = join(dir, 'jobs');
await writeFile(configPath, JSON.stringify({ deviceToken: token, codexPath: '/not-used/codex', dataDir }), { mode: 0o600 });
await writeFile(remotePath, JSON.stringify({ hosts: [{ id: hostId, name: 'Remote Mac',
  url: `http://127.0.0.1:${upstream.address().port}`, deviceToken: remoteToken }] }), { mode: 0o600 });
process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = configPath;
process.env.PETROGLYPHS_REMOTE_CONFIG = remotePath;
let server;
try {
  server = await startHttp(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const paired = `${base}/device/${token}`;
  assert.equal((await fetch(`${base}/api/codex/hosts`)).status, 403);
  const hosts = await fetch(`${paired}/api/codex/hosts`).then(r => r.json());
  assert(hosts.hosts.some(host => host.id === 'local' && host.kind === 'local'));
  assert(hosts.hosts.some(host => host.id === hostId && host.name === 'Remote Mac' && host.configured));
  assert(!JSON.stringify(hosts).includes(remoteToken));
  assert(!JSON.stringify(hosts).includes('http://'));
  const query = new URLSearchParams({ hostId, search: 'diagram', cursor: 'opaque cursor' });
  const list = await fetch(`${paired}/api/codex/threads?${query}`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).threads[0].id, threadId);
  assert.equal(calls[0].url.searchParams.get('search'), 'diagram');
  assert.equal(calls[0].url.searchParams.get('cursor'), 'opaque cursor');
  assert.equal(calls[0].url.searchParams.get('hostId'), null, 'upstream cannot proxy recursively');

  const payload = { image, strokeMetadata, threadId, hostId, pairing_code: 'LOCAL_ONLY_CODE' };
  const post = url => fetch(`${url}/api/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post(base)).status, 403);
  const sent = await post(paired);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { id, threadId, hostId, status: 'received' });
  const forwarded = calls.find(call => call.method === 'POST');
  assert.deepEqual(forwarded.body, { image, strokeMetadata, combo: null, threadId });
  assert.deepEqual(await readdir(dataDir), [], 'remote images and receipts belong to the remote service');
  const reply = await fetch(`${paired}/api/codex/submissions/${id}?${new URLSearchParams({ hostId })}`);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { id, threadId, hostId, state: 'completed', messages: [{ id: 'reply', text: 'Remote answer', phase: 'final_answer' }] });
  assert.equal((await fetch(`${paired}/api/codex/submissions/${id}`)).status, 404, 'remote receipts must not resolve to a local job');
  assert.equal((await fetch(`${paired}/api/codex/threads?hostId=local&hostId=other`)).status, 400);
  assert.equal((await fetch(`${paired}/api/codex/submissions/${id}?hostId=local&hostId=other`)).status, 400);
  assert.equal((await fetch(`${paired}/api/codex/threads?hostId=remote-control%3Aenv_unknown`)).status, 404);
  console.log('PASS: authenticated host catalog; remote list/payload/reply forwarding; captured host identity; PNG stays remote; local receipt isolation; invalid host rejection.');
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  await rm(dir, { recursive: true, force: true });
}
