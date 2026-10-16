import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSubmissionReply } from '../dist/codex-replies.js';
import { CodexAutoReply } from '../dist/codex-auto-reply.js';
import { startHttp } from '../dist/transport-http.js';

const a = '00000000-0000-7000-8000-000000000003';
const b = '00000000-0000-7000-8000-000000000004';
const absent = '00000000-0000-7000-8000-000000000008';
const threadId = '00000000-0000-7000-8000-000000000005';
const user = (id, text = `Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ${id}。请读图。`) =>
  ({ type: 'userMessage', id: `user-${id}`, content: [{ type: 'text', text }] });
const agent = (id, text, phase = 'final_answer') => ({ type: 'agentMessage', id, text, phase });
const entry = (turnId, item) => ({ turnId, item });
const turnA = { id: 'turn-a', status: 'completed', error: null };
const turnB = { id: 'turn-b', status: 'inProgress', error: null };
let turns = [turnB, turnA];
let items = [
  entry('turn-a', user(a)), entry('turn-a', { type: 'reasoning', id: 'reasoning-a', text: 'PRIVATE_REASONING' }),
  entry('turn-a', agent('comment-a', 'Reading A', 'commentary')),
  entry('turn-a', { type: 'functionCallOutput', id: 'tool-a', output: 'PRIVATE_TOOL_RESULT' }),
  entry('turn-a', agent('answer-a', 'Answer for A')),
  entry('turn-b', user(b)), entry('turn-b', agent('comment-b', 'Reading B', 'commentary')),
  entry('unrelated', user('unrelated', 'Unrelated later input')), entry('unrelated', agent('unrelated-answer', 'PRIVATE_UNRELATED_ANSWER')),
];
const calls = [];
const rpc = async (method, params) => {
  calls.push({ method, params });
  assert.equal(params.threadId, threadId);
  if (method === 'thread/turns/list') return { data: turns, nextCursor: null };
  assert.equal(method, 'thread/items/list');
  const selected = params.turnId ? items.filter(item => item.turnId === params.turnId) : [...items].reverse();
  return { data: selected, nextCursor: null };
};
const query = id => ({ id, threadId, knownSubmissionIds: [a, b] });

let reply = await readSubmissionReply(rpc, query(a));
assert.equal(reply.state, 'completed');
assert.equal(reply.turnId, 'turn-a');
assert.deepEqual(reply.messages.map(message => message.text), ['Reading A', 'Answer for A']);
assert(!JSON.stringify(reply).includes('PRIVATE_'));
reply = await readSubmissionReply(rpc, query(b));
assert.equal(reply.state, 'running');
assert.deepEqual(reply.messages, [{ id: 'comment-b', text: 'Reading B', phase: 'commentary' }]);
turnB.status = 'completed';
items.splice(items.length - 2, 0, entry('turn-b', agent('answer-b', 'Answer for B', null)));
reply = await readSubmissionReply(rpc, query(b));
assert.equal(reply.state, 'completed');
assert.equal(reply.messages.at(-1).phase, 'unknown');
assert.equal(reply.messages.at(-1).text, 'Answer for B');

// Mentioning the receipt in an assistant answer cannot establish association.
items.push(entry('unrelated', agent('quoted-id', `Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ${absent}。`)));
reply = await readSubmissionReply(rpc, query(absent));
assert.equal(reply.state, undefined);
assert.deepEqual(reply.messages, []);
assert.equal(reply.turnId, undefined);

// Two queued image messages can be coalesced by Codex into one public answer.
turns = [{ id: 'shared', status: 'completed', error: null }];
items = [entry('shared', user(a)), entry('shared', user(b)), entry('shared', agent('shared-answer', 'Combined A and B'))];
for (const id of [a, b]) {
  reply = await readSubmissionReply(rpc, query(id));
  assert.equal(reply.state, 'completed');
  assert.deepEqual(reply.coalescedSubmissionIds, [a, b]);
  assert.equal(reply.messages[0].text, 'Combined A and B');
  assert.match(reply.notice, /shared/);
}
const separateInputs = items;
items = [entry('shared', user(a, `${user(a).content[0].text}\n${user(b).content[0].text}`)), entry('shared', agent('shared-answer', 'Combined A and B'))];
reply = await readSubmissionReply(rpc, query(b));
assert.deepEqual(reply.coalescedSubmissionIds, [a, b], 'one coalesced user item may contain multiple submission markers');
items = separateInputs;
items.splice(2, 0, entry('shared', user('other', 'Unrelated instruction')));
reply = await readSubmissionReply(rpc, query(a));
assert.equal(reply.state, 'unknown');
assert.deepEqual(reply.messages, []);
assert.match(reply.notice, /Other input/);

turns = [{ id: 'failed', status: 'failed', error: { message: 'PRIVATE_FAILURE_DETAIL', codexErrorInfo: 'rateLimitExceeded' } }];
items = [entry('failed', user(a)), entry('failed', agent('progress', 'Started', 'commentary'))];
reply = await readSubmissionReply(rpc, query(a));
assert.equal(reply.state, 'failed');
assert.match(reply.error, /rate limit/);
assert(!JSON.stringify(reply).includes('PRIVATE_'));
turns[0].status = 'interrupted';
reply = await readSubmissionReply(rpc, query(a));
assert.equal(reply.state, 'unknown');
assert.equal(reply.error, undefined);
assert.match(reply.notice, /confirm/);

const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-reply-test-'));
const dataDir = join(dir, 'jobs');
await mkdir(dataDir);
const fixturePath = join(dir, 'fixture.json');
const tracePath = join(dir, 'trace.jsonl');
const fake = join(dir, 'fake codex');
const token = 'd'.repeat(32);
const settings = { deviceToken: token, codexPath: fake, dataDir };
const job = id => ({ id, threadId, imagePath: join(dataDir, `${id}.png`), state: 'queued',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
await writeFile(join(dataDir, `${a}.json`), JSON.stringify(job(a)));
await writeFile(join(dataDir, `${b}.json`), JSON.stringify(job(b)));
await writeFile(fixturePath, JSON.stringify({ turns: [{ id: 'saved-turn-a', status: 'completed', error: null }],
  items: [entry('saved-turn-a', user(a)), entry('saved-turn-a', agent('saved-answer-a', 'Saved A response'))] }));
await writeFile(tracePath, '');
await writeFile(fake, String.raw`#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(tracePath)}, 'start\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)},'utf8'));
  let result;
  if(request.method==='initialized') return;
  if(request.method==='initialize') result={userAgent:'test'};
  else if(request.method==='thread/turns/list') result={data:fixture.turns,nextCursor:null};
  else if(request.method==='thread/items/list') result={data:request.params.turnId
    ? fixture.items.filter(item=>item.turnId===request.params.turnId) : [...fixture.items].reverse(),nextCursor:null};
  else throw Error('unexpected method');
  console.log(JSON.stringify({id:request.id,result}));
});
`, { mode: 0o700 });

let server;
try {
  const service = new CodexAutoReply(settings);
  const saved = await service.getSubmission(a);
  assert.equal(saved.state, 'completed');
  assert.equal(saved.hostId, 'local');
  assert.equal(saved.messages[0].text, 'Saved A response');
  const persisted = JSON.parse(await readFile(join(dataDir, `${a}.json`), 'utf8'));
  assert.equal(persisted.turnId, 'saved-turn-a');
  assert.equal(persisted.messages[0].text, 'Saved A response');
  const concurrent = await Promise.all([service.getSubmission(b), service.getSubmission(b)]);
  assert(concurrent.every(status => status.state === 'queued' && status.messages.length === 0));
  const starts = (await readFile(tracePath, 'utf8')).trim().split('\n').length;
  assert.equal(starts, 2, 'concurrent polls must share one lookup');
  await service.getSubmission(b);
  assert.equal((await readFile(tracePath, 'utf8')).trim().split('\n').length, starts, 'rapid polls use cached status');
  await writeFile(fixturePath, JSON.stringify({ turns: [], items: [] }));
  const restarted = new CodexAutoReply(settings);
  assert.deepEqual(await restarted.getSubmission(a), saved, 'completed reply survives restart without reading unrelated newer turns');
  assert.equal((await readFile(tracePath, 'utf8')).trim().split('\n').length, starts);
  await assert.rejects(restarted.getSubmission(absent), error => error.status === 404);

  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(settings));
  process.env.PETROGLYPHS_AUTO_REPLY_CONFIG = configPath;
  server = await startHttp(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/codex/submissions/${a}`)).status, 403);
  assert.equal((await fetch(`${base}/device/wrong/api/codex/submissions/${a}`)).status, 404);
  assert.equal((await fetch(`${base}/device/${token}/api/codex/submissions/${absent}`)).status, 404);
  const response = await fetch(`${base}/device/${token}/api/codex/submissions/${a}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), saved);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH = '1';
  process.env.PETROGLYPHS_BIND_HOST = '127.0.0.1';
  server = await startHttp(0);
  assert.equal(server.address().address, '127.0.0.1');
  const helper = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/api/health', '/mcp']) assert.equal((await fetch(helper + path)).status, 403);
  assert.equal((await fetch(`${helper}/device/${token}/api/health`)).status, 200);
  console.log('PASS: exact user-message association; independent same-chat replies; active/completed/failed/interrupted states; no unrelated/tool/reasoning leakage; explicit shared turns; durable completed reply; poll deduplication/cache; authenticated known-receipt API.');
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(dir, { recursive: true, force: true });
}
