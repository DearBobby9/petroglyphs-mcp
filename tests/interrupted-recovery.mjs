import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSubmissionReply } from '../dist/codex-replies.js';
import { CodexAutoReply } from '../dist/codex-auto-reply.js';
import { startHttp } from '../dist/transport-http.js';

const id = '14c2c002-85c0-42c6-8de2-aaf4c55355df';
const genuineFailureId = '14c2c002-85c0-42c6-8de2-aaf4c55355d0';
const threadId = '00000000-0000-7000-8000-000000000003';
const otherThreadId = '00000000-0000-7000-8000-000000000004';
const turnId = '00000000-0000-7000-8000-000000000009';
const legacyError = 'The Codex response was interrupted. Open the chat on the Mac to continue.';
const user = { type: 'userMessage', id: 'input', content: [{ type: 'text', text: `Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ${id}。请读取。` }] };
const commentary = { type: 'agentMessage', id: 'progress', text: 'Reading this image', phase: 'commentary' };
const final = { type: 'agentMessage', id: 'final', text: 'The complete original response', phase: 'final_answer' };
const fixture = status => ({ turns: [{ id: turnId, status, error: null }],
  items: [user, commentary, ...(status === 'completed' ? [final] : [])].map(item => ({ turnId, item })) });

test('a provisional interrupted observation remains pollable and later completes in the same turn', async () => {
  let current = fixture('interrupted');
  const rpc = async (method, params) => {
    assert.equal(params.threadId, threadId);
    if (method === 'thread/turns/list') return { data: current.turns, nextCursor: null };
    assert.equal(method, 'thread/items/list');
    return { data: current.items, nextCursor: null };
  };
  const first = await readSubmissionReply(rpc, { id, threadId, knownSubmissionIds: [id] });
  assert.equal(first.state, 'unknown');
  assert.equal(first.error, undefined);
  assert.match(first.notice, /confirm|confirmation/);
  assert.deepEqual(first.messages.map(message => message.id), ['progress']);
  current = fixture('completed');
  const completed = await readSubmissionReply(rpc, { id, threadId, turnId: first.turnId, knownSubmissionIds: [id] });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.turnId, turnId);
  assert.equal(completed.messages.at(-1).text, final.text);
  assert.equal(completed.error, undefined);
});

test('legacy interrupted failures recover by reading the original receipt without queueing or changing its PNG', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-interrupted-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'jobs');
  await mkdir(dataDir);
  const tracePath = join(dir, 'trace.jsonl');
  const fixturePath = join(dir, 'fixture.json');
  const fake = join(dir, 'fake codex');
  await writeFile(tracePath, '');
  await writeFile(fixturePath, JSON.stringify(fixture('completed')));
  await writeFile(fake, String.raw`#!${process.execPath}
const fs=require('node:fs');
const readline=require('node:readline');
const trace=value=>fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify(value)+'\n');
trace({args:process.argv.slice(2)});
if(process.argv[2]==='queue') throw Error('This test must never queue a submission');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const req=JSON.parse(line); trace({method:req.method});
  if(req.method==='initialized') return;
  const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)},'utf8'));
  const result=req.method==='initialize'?{}:req.method==='thread/turns/list'
    ?{data:fixture.turns,nextCursor:null}:req.method==='thread/items/list'
    ?{data:fixture.items,nextCursor:null}:null;
  if(result===null) throw Error('Unexpected RPC');
  console.log(JSON.stringify({id:req.id,result}));
});
`, { mode: 0o700 });
  const pngPath = join(dataDir, `${id}.png`);
  const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(pngPath, originalPng);
  const original = { id, threadId, turnId, imagePath: pngPath, state: 'failed', error: legacyError,
    receipt: 'Queued message original receipt.', createdAt: '2026-10-16T03:29:00.000Z', updatedAt: '2026-10-16T03:29:21.000Z',
    messages: [{ id: commentary.id, text: commentary.text, phase: commentary.phase }] };
  await writeFile(join(dataDir, `${id}.json`), JSON.stringify(original));
  await writeFile(join(dataDir, `${genuineFailureId}.json`), JSON.stringify({ ...original, id: genuineFailureId,
    error: 'Codex reached a rate limit. Open the chat on the Mac to retry later.' }));
  const service = new CodexAutoReply({ deviceToken: 'a'.repeat(32), codexPath: fake, dataDir });
  const migrated = JSON.parse(await readFile(join(dataDir, `${id}.json`), 'utf8'));
  assert.equal(migrated.state, 'unknown');
  assert.equal(migrated.error, undefined);
  assert.match(migrated.notice, /confirm|confirmation/);
  const completed = await service.getSubmission(id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.messages.at(-1).text, final.text);
  const after = JSON.parse(await readFile(join(dataDir, `${id}.json`), 'utf8'));
  for (const key of ['id', 'threadId', 'turnId', 'imagePath', 'createdAt', 'receipt']) assert.equal(after[key], original[key]);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(pngPath)), hash(originalPng));
  const beforeFailureRead = await readFile(tracePath, 'utf8');
  assert.equal((await service.getSubmission(genuineFailureId)).state, 'failed');
  assert.equal(await readFile(tracePath, 'utf8'), beforeFailureRead, 'genuine failed replies remain terminal');
  const events = beforeFailureRead.trim().split('\n').map(JSON.parse);
  assert(events.filter(event => event.args).every(event => event.args[0] === 'app-server'));
  assert(events.filter(event => event.method).every(event => ['initialize', 'initialized', 'thread/turns/list', 'thread/items/list'].includes(event.method)));
});

test('authenticated recovery lists only the requested chat ledger and caps results at the newest twenty', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-recovery-list-'));
  const dataDir = join(dir, 'jobs');
  await mkdir(dataDir);
  const expected = [];
  for (let index = 0; index < 23; index++) {
    const receiptId = `14c2c002-85c0-42c6-8de2-${index.toString(16).padStart(12, '0')}`;
    const record = { id: receiptId, threadId, state: 'completed', imagePath: '/PRIVATE_IMAGE_PATH',
      createdAt: new Date(1700000000000 + index * 1000).toISOString(), updatedAt: new Date().toISOString(), messages: [] };
    await writeFile(join(dataDir, `${receiptId}.json`), JSON.stringify(record));
    expected.unshift({ id: receiptId, threadId, hostId: 'local', createdAt: record.createdAt });
  }
  await writeFile(join(dataDir, `${id}.json`), JSON.stringify({ id, threadId: otherThreadId, state: 'completed',
    imagePath: '/PRIVATE_OTHER_PATH', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }));
  const token = 'b'.repeat(32);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ deviceToken: token, codexPath: '/never-run/codex', dataDir }));
  process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = configPath;
  delete process.env.PETROGLYPHS_REMOTE_CONFIG;
  const server = await startHttp(0);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/api/codex/submissions?threadId=${threadId}&hostId=local`;
  assert.equal((await fetch(base + path)).status, 403);
  assert.equal((await fetch(`${base}/device/wrong${path}`)).status, 404);
  assert.equal((await fetch(`${base}/device/${token}/api/codex/submissions`)).status, 400);
  assert.equal((await fetch(`${base}/device/${token}/api/codex/submissions?threadId=bad`)).status, 400);
  const response = await fetch(`${base}/device/${token}${path}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { submissions: expected.slice(0, 20) });
  assert(!JSON.stringify(body).includes('PRIVATE_'));
  assert.equal((await fetch(`${base}/device/${token}/api/codex/submissions?threadId=${threadId}&hostId=remote-control%3Aenv_unknown`)).status, 404);
});

test('remote recovery forwards only GET and preserves the selected host and chat boundary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-remote-recovery-'));
  const remoteId = 'remote-control:env_recovery_test';
  const deviceToken = 'c'.repeat(32);
  const remoteToken = 'd'.repeat(32);
  const createdAt = '2026-10-16T03:29:00.000Z';
  const requests = [];
  let returnedThread = threadId;
  const upstream = createServer((req, res) => {
    requests.push({ method: req.method, url: new URL(req.url, 'http://helper') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ submissions: [{ id, threadId: returnedThread, hostId: 'local', createdAt }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const configPath = join(dir, 'config.json');
  const remotePath = join(dir, 'remote.json');
  await writeFile(configPath, JSON.stringify({ deviceToken, codexPath: '/never-run/codex', dataDir: join(dir, 'jobs') }));
  await writeFile(remotePath, JSON.stringify({ hosts: [{ id: remoteId, name: 'Recovery Mac',
    url: `http://127.0.0.1:${upstream.address().port}`, deviceToken: remoteToken }] }), { mode: 0o600 });
  process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = configPath;
  process.env.PETROGLYPHS_REMOTE_CONFIG = remotePath;
  const server = await startHttp(0);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/device/${deviceToken}`;
  const query = new URLSearchParams({ threadId, hostId: remoteId });
  const response = await fetch(`${base}/api/codex/submissions?${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { submissions: [{ id, threadId, hostId: remoteId, createdAt }] });
  assert.equal(requests[0].url.pathname, `/device/${remoteToken}/api/codex/submissions`);
  assert.equal(requests[0].url.searchParams.get('threadId'), threadId);
  assert.equal(requests[0].url.searchParams.get('hostId'), null);
  returnedThread = otherThreadId;
  assert.equal((await fetch(`${base}/api/codex/submissions?${query}`)).status, 503);
  assert(requests.every(request => request.method === 'GET'), 'recovery must never submit or queue an image');
});
