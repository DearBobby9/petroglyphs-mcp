import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { CodexAutoReply } from '../dist/codex-auto-reply.js';
import { CodexThreads } from '../dist/codex-threads.js';

const transportUrl = new URL('../dist/transport-http.js', import.meta.url).href;
const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-check-'));
const token = 'a'.repeat(32);
const a = '00000000-0000-7000-8000-000000000003';
const b = '00000000-0000-7000-8000-000000000004';
const archived = '00000000-0000-7000-8000-000000000005';
const subagent = '00000000-0000-7000-8000-000000000006';
const ephemeral = '00000000-0000-7000-8000-000000000007';
const fake = join(dir, 'fake codex');
const fixturePath = join(dir, 'fixture.json');
const tracePath = join(dir, 'calls.jsonl');
const releasePath = join(dir, 'release-queue');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = { image: png, strokeMetadata: { strokeCount: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, duration: 0 } };
const thread = (id, name, extra = {}) => ({ id, name, cwd: '/tmp/project with spaces', updatedAt: 1792110000,
  source: 'vscode', parentThreadId: null, ephemeral: false, archived: false,
  preview: 'PRIVATE_FULL_PREVIEW', turns: [{ content: 'PRIVATE_TURN_HISTORY' }], ...extra });
const fixture = { holdQueue: true, pageSize: 1, threads: [thread(a, 'Alpha sketch'), thread(b, 'Beta diagram'),
  thread(archived, 'Old archived', { archived: true }), thread(subagent, 'Helper', { parentThreadId: a }),
  thread(ephemeral, 'Temporary', { ephemeral: true })] };
await writeFile(fixturePath, JSON.stringify(fixture));
await writeFile(tracePath, '');

// Preserve JSONL escapes in the generated script and a real shebang newline.
await writeFile(fake, String.raw`#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const fixturePath = ${JSON.stringify(fixturePath)};
const tracePath = ${JSON.stringify(tracePath)};
const releasePath = ${JSON.stringify(releasePath)};
const trace = value => fs.appendFileSync(tracePath, JSON.stringify(value) + '\n');
const settings = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'queue') {
  trace({ kind: 'queue', args });
  const finish = () => { console.log('Queued message test for thread ' + args[2] + '.'); process.exit(0); };
  if (!settings().holdQueue || fs.existsSync(releasePath)) finish();
  else fs.watch(${JSON.stringify(dir)}, () => { if (fs.existsSync(releasePath)) finish(); });
} else if (JSON.stringify(args) === JSON.stringify(['app-server', '--listen', 'stdio://'])) {
  trace({ kind: 'start', pid: process.pid });
  process.on('SIGTERM', () => { trace({ kind: 'stop', pid: process.pid }); process.exit(0); });
  let initialized = false;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    trace({ kind: 'rpc', method: request.method, params: request.params });
    const current = settings();
    const reply = result => console.log(JSON.stringify({ id: request.id, result }));
    if (current.hang) return;
    if (request.method === 'initialize') reply({ userAgent: 'test' });
    else if (request.method === 'initialized') initialized = true;
    else if (request.method === 'thread/list') {
      if (!initialized) throw Error('missing initialized notification');
      if (current.rpcError) {
        console.error('PRIVATE_STDERR_SECRET');
        console.log(JSON.stringify({ id: request.id, error: { code: -32603, message: 'PRIVATE_RPC_SECRET' } }));
        return;
      }
      const params = request.params;
      if (params.archived !== false || params.sortKey !== 'updated_at' || params.sortDirection !== 'desc') throw Error('unsafe list filters');
      const selected = current.threads.filter(t => !t.archived && params.sourceKinds.includes(t.source)
        && (!params.searchTerm || t.name.toLowerCase().includes(params.searchTerm.toLowerCase())));
      const offset = params.cursor ? Number(params.cursor.slice('opaque page '.length)) : 0;
      const data = selected.slice(offset, offset + current.pageSize);
      reply({ data, nextCursor: offset + current.pageSize < selected.length ? 'opaque page ' + (offset + current.pageSize) : null });
    } else throw Error('unexpected RPC method');
  });
} else { throw Error('unexpected CLI arguments'); }
`, { mode: 0o700 });

const settings = { threadId: a, deviceToken: token, codexPath: fake, dataDir: join(dir, 'images with spaces') };
await writeFile(join(dir, 'config.json'), JSON.stringify(settings));
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import { startHttp } from ${JSON.stringify(transportUrl)};
  const server = await startHttp(0);
  process.send({ port: server.address().port });
`], { env: { ...process.env, PETROGLYPHS_AUTO_REPLY_CONFIG: join(dir, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let serverLogs = '';
child.stdout.on('data', data => { serverLogs += data; });
child.stderr.on('data', data => { serverLogs += data; });
const childExited = new Promise(resolve => child.once('exit', resolve));

async function trace() {
  return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

// Watch the external boundary, then recheck after subscribing so no event is lost.
async function waitFor(check, directory = dir) {
  let notify = () => {};
  let version = 0;
  const watcher = watch(directory, () => { version++; notify(); });
  let timeout;
  const expired = new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timed out waiting for fake Codex')), 5000); });
  try {
    return await Promise.race([expired, (async () => {
      while (true) {
        const previous = version;
        const result = await check();
        if (result) return result;
        await new Promise(resolve => { notify = resolve; if (version !== previous) resolve(); });
      }
    })()]);
  } finally { clearTimeout(timeout); watcher.close(); }
}

try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('HTTP startup timed out')), 5000);
    child.once('message', message => { clearTimeout(timeout); resolve(message.port); });
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`HTTP exited ${code}: ${serverLogs}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  const base = `http://127.0.0.1:${port}`;
  const paired = `${base}/device/${token}`;
  const post = async (url, body) => fetch(`${url}/api/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const list = async suffix => {
    const response = await fetch(`${paired}/api/codex/threads${suffix}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  assert.equal((await post(base, image)).status, 200);
  assert.deepEqual(await readdir(settings.dataDir), []);
  assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).autoReply, undefined);
  assert.equal((await fetch(`${paired}/api/health`).then(r => r.json())).autoReply.enabled, true);
  assert.equal((await fetch(`${base}/api/codex/threads`)).status, 403);
  assert.equal((await fetch(`${base}/device/wrong/api/codex/threads`)).status, 404);
  assert.equal((await post(base, { ...image, threadId: a })).status, 403);
  assert.equal((await post(paired, image)).status, 400, 'legacy config must not select a default chat');
  assert.equal((await post(paired, { ...image, threadId: '../bad' })).status, 400);
  assert.equal((await fetch(`${paired}/api/codex/threads?search=a&search=b`)).status, 400);
  assert.equal((await fetch(`${paired}/api/codex/threads?cursor=${'x'.repeat(4097)}`)).status, 400);

  const first = await list('');
  assert.deepEqual(first.threads, [{ id: a, title: 'Alpha sketch', cwd: '/tmp/project with spaces', updatedAt: 1792110000 }]);
  assert.equal(first.nextCursor, 'opaque page 1');
  assert.equal((await list(`?cursor=${encodeURIComponent(first.nextCursor)}`)).threads[0].id, b);
  const search = await list('?search=Beta');
  assert.deepEqual(search.threads.map(t => t.id), [b]);
  assert.equal(search.nextCursor, null);
  assert(!JSON.stringify(first).includes('PRIVATE_'), 'only metadata may leave the backend');

  for (const id of [archived, subagent, ephemeral, randomUUID()]) {
    assert.equal((await post(paired, { ...image, threadId: id })).status, 404);
  }
  assert.deepEqual(await readdir(settings.dataDir), [], 'rejected targets must not persist an image');

  fixture.rpcError = true;
  await writeFile(fixturePath, JSON.stringify(fixture));
  const failed = await fetch(`${paired}/api/codex/threads`);
  assert.equal(failed.status, 503);
  assert(!(await failed.text()).includes('PRIVATE_'));
  assert.equal((await post(paired, { ...image, threadId: a })).status, 503);
  fixture.rpcError = false;
  await writeFile(fixturePath, JSON.stringify(fixture));

  const ids = [];
  for (const target of [a, b]) {
    const response = await post(paired, { ...image, threadId: target });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.threadId, target);
    ids.push(receipt.id);
  }
  await waitFor(async () => (await trace()).filter(event => event.kind === 'queue').length === 1);
  for (let i = 0; i < ids.length; i++) {
    const job = JSON.parse(await readFile(join(settings.dataDir, `${ids[i]}.json`), 'utf8'));
    assert.equal(job.threadId, [a, b][i]);
    assert.equal(job.state, i === 0 ? 'dispatching' : 'pending');
  }
  await writeFile(releasePath, 'release');
  await waitFor(async () => (await Promise.all(ids.map(async id =>
    JSON.parse(await readFile(join(settings.dataDir, `${id}.json`), 'utf8')).state))).every(state => state === 'queued'), settings.dataDir);
  const calls = (await trace()).filter(event => event.kind === 'queue').map(event => event.args);
  assert.equal(calls.length, 2);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(calls[i][2], [a, b][i]);
    const saved = join(settings.dataDir, `${ids[i]}.png`);
    assert(calls[i][4].includes(ids[i]));
    assert(calls[i][4].includes(saved));
    assert.equal(calls[i].length, 5);
    assert.equal((await readFile(saved)).toString('base64'), png);
  }

  // Restart must resume every pending target, not just the legacy config target.
  const restartDir = join(dir, 'restart');
  await mkdir(restartDir);
  const jobs = [a, b, archived].map((threadId, index) => ({
    id: randomUUID(), threadId, state: index === 2 ? 'dispatching' : 'pending',
    createdAt: new Date(index * 1000).toISOString(), updatedAt: new Date(index * 1000).toISOString(),
  }));
  for (const job of jobs) {
    job.imagePath = join(restartDir, `${job.id}.png`);
    await writeFile(job.imagePath, Buffer.from(png, 'base64'));
    await writeFile(join(restartDir, `${job.id}.json`), JSON.stringify(job));
  }
  const restarted = new CodexAutoReply({ ...settings, dataDir: restartDir });
  await waitFor(async () => restarted.status().pending === 0, restartDir);
  assert.equal(restarted.status().latest.state, 'unknown');
  const resumed = (await trace()).filter(event => event.kind === 'queue').slice(2);
  assert.deepEqual(resumed.map(event => event.args[2]), [a, b]);
  assert.equal(resumed.length, 2, 'uncertain dispatch must not be replayed');

  const beforeTimeout = (await trace()).filter(event => event.kind === 'start').length;
  fixture.hang = true;
  await writeFile(fixturePath, JSON.stringify(fixture));
  await assert.rejects(new CodexThreads(fake, 300).list({}), /timed out/);
  const lifecycle = await trace();
  const started = lifecycle.filter(event => event.kind === 'start');
  assert.equal(started.length, beforeTimeout + 1);
  assert.throws(() => process.kill(started.at(-1).pid, 0),
    error => error.code === 'ESRCH', 'timed out lookup must wait for child exit, including EOF exits');
  assert(!serverLogs.includes('PRIVATE_'), 'RPC and stderr details must not enter HTTP logs');
  assert(lifecycle.filter(event => event.kind === 'rpc').every(event => ['initialize', 'initialized', 'thread/list'].includes(event.method)));

  console.log('PASS: authenticated metadata search and pagination; missing, invalid, archived and unavailable targets rejected; A/B targets stay fixed while queued; all targets resume after restart without uncertain replay; bounded lookup timeout cleans up its process.');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await childExited;
  await rm(dir, { recursive: true, force: true });
}
