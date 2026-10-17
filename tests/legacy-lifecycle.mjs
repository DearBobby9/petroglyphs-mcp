import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startHttp } from '../src/transport-http.ts';
import { CodexAutoReply } from '../src/codex-auto-reply.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'petroglyphs-legacy-life-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const marker = join(root, 'calls'), release = join(root, 'release');
  const codexPath = join(root, 'fake-codex.cjs');
  await writeFile(codexPath, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== 'queue') throw Error('unexpected CLI command');
fs.appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('Queued message'); }
}, 10);
`, { mode: 0o700 });
  const jobs = [0, 1].map(index => ({ id: randomUUID(), threadId: randomUUID(), state: 'pending',
    imagePath: join(root, 'unused.png'), createdAt: new Date(index * 1000).toISOString(), updatedAt: new Date(index * 1000).toISOString() }));
  for (const job of jobs) await writeFile(join(dataDir, job.id + '.json'), JSON.stringify(job));
  const settings = { deviceToken: 'e'.repeat(32), codexPath, dataDir };
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify(settings));
  const env = { PETROGLYPHS_BRIDGE_CONFIG: config, PETROGLYPHS_AUTO_REPLY_CONFIG: undefined,
    PETROGLYPHS_CODEX_DESKTOP: '0', PETROGLYPHS_LEGACY_SUBMISSIONS: '1', PETROGLYPHS_BIND_HOST: '127.0.0.1' };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const calls = async () => (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const states = async () => Promise.all(jobs.map(async job => JSON.parse(await readFile(join(dataDir, job.id + '.json'), 'utf8')).state));
  t.after(async () => {
    for (const pid of await calls()) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { settings, calls, states, release: () => writeFile(release, '') };
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() > deadline) throw Error('Timed out waiting for fake CLI'); await delay(10); }
}
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

for (const failure of ['primary', 'secondary', 'invalid-port']) {
  test(`legacy recovery does not dispatch when ${failure} listener startup fails`, async t => {
    const f = await fixture(t);
    let occupied;
    let port = -1;
    if (failure !== 'invalid-port') {
      occupied = createServer();
      await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
      port = occupied.address().port;
      if (failure === 'secondary') process.env.PETROGLYPHS_BIND_HOST = '::1';
    }
    try {
      await assert.rejects(startHttp(port), error => failure === 'invalid-port' ? error.code === 'ERR_SOCKET_BAD_PORT' : error.code === 'EADDRINUSE');
      await delay(100);
      assert.deepEqual(await f.calls(), []);
      assert.deepEqual(await f.states(), ['pending', 'pending'], 'failed startup preserves undispatched receipts');
    } finally { if (occupied) await close(occupied); }
  });
}

for (const dual of [false, true]) {
  test(`closing ${dual ? 'dual' : 'single'} listeners stops the next legacy dispatch while an active request drains`, async t => {
    const f = await fixture(t);
    if (dual) process.env.PETROGLYPHS_BIND_HOST = '::1';
    const server = await startHttp(0);
    let socket;
    t.after(async () => { socket?.destroy(); await close(server); });
    await until(async () => (await f.calls()).length === 1);
    socket = connect(server.address().port, process.env.PETROGLYPHS_BIND_HOST);
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
    await delay(20);
    const closing = close(server), repeated = close(server);
    await f.release();
    await until(async () => (await f.states())[0] === 'queued');
    await delay(100);
    assert.equal((await f.calls()).length, 1, 'close prevents admission before socket-close completion');
    assert.deepEqual(await f.states(), ['queued', 'pending'], 'in-flight receipt finishes; undispatched work stays pending');
    socket.destroy();
    await Promise.all([closing, repeated]);
    await close(server);
    const restarted = new CodexAutoReply(f.settings);
    t.after(() => restarted.close());
    await until(async () => (await f.states())[1] === 'queued');
    assert.equal((await f.calls()).length, 2, 'restart resumes only the undispatched pending job');
  });
}

test('a deferred closed worker cannot start, and disabled legacy never loads receipts', async t => {
  const f = await fixture(t);
  const worker = new CodexAutoReply(f.settings, { deferStart: true });
  worker.close(); worker.start(); worker.start();
  await delay(50);
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(worker.accept({ imageBase64: '', id: randomUUID() }, randomUUID()), error => error.status === 503);
  process.env.PETROGLYPHS_LEGACY_SUBMISSIONS = '0';
  await writeFile(join(f.settings.dataDir, 'invalid.json'), 'not-json');
  const server = await startHttp(0);
  await close(server);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await f.states(), ['pending', 'pending']);
});
