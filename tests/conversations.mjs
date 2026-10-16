import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import express from 'express';
import { CodexConversations } from '../src/codex-conversations.ts';
import { CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';
import { ConversationError, parseMessageInput } from '../src/codex-message-input.ts';
import { submissionMarker } from '../src/codex-replies.ts';
import { installConversationRoutes } from '../src/codex-conversation-routes.ts';
import { historyMessages, historyTurns } from '../src/codex-conversation-history.ts';

const host = 'remote-control:env_test';
const thread = '00000000-0000-7000-8000-000000000003';
const otherThread = '00000000-0000-7000-8000-000000000004';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const input = (text = 'Continue.', extras = {}) => ({ id: randomUUID(), hostId: host, threadId: thread, text, attachments: [], ...extras });
const image = (extras = {}) => ({ id: randomUUID(), name: 'Drawing.png', mimeType: 'image/png', dataBase64: png, ...extras });
const nativeTurn = (id, text, status = 'completed', extras = {}) => ({ turnId: randomUUID(), status, turnStartedAtMs: 1792125567935,
  params: { clientUserMessageId: id }, items: [
    { id: randomUUID(), clientId: id, type: 'userMessage', content: [{ type: 'text', text }] },
    { id: randomUUID(), type: 'reasoning', text: 'PRIVATE_REASONING' },
    { id: randomUUID(), type: 'agentMessage', text: 'PRIVATE_REASONING_PHASE', phase: 'analysis' },
    { id: randomUUID(), type: 'commandExecution', aggregatedOutput: 'PRIVATE_TOOL' },
    { id: randomUUID(), type: 'agentMessage', text: 'Working…', phase: 'commentary' },
    { id: randomUUID(), type: 'agentMessage', text: `Answer ${text}`, phase: 'final_answer', memoryCitation: 'PRIVATE_INTERNAL' },
  ], ...extras });
const state = (hostId, threadId, turns = [], busy = false) => ({ id: threadId, hostId, resumeState: 'resumed',
  threadRuntimeStatus: { type: busy ? 'active' : 'idle' }, requests: [], turns: [],
  privateField: 'PRIVATE_DESKTOP_STATE', turnHistory: { history: { isComplete: true,
    islands: [{ entries: turns.map(turn => ({ key: turn.turnId, value: turn.turnId })) }],
    entitiesByKey: Object.fromEntries(turns.map(turn => [turn.turnId, turn])),
  } } });

test('verified project creation projects the first user prompt once and keeps unrelated tool outputs private', async t => {
  for (const format of ['toolOutput', 'wrapped-user']) {
    const requestId = randomUUID();
    const originalText = 'The real first prompt <with> & characters';
    const first = nativeTurn(randomUUID(), 'NATIVE_DELEGATION_WRAPPER');
    first.params = { toolOutput: { namespace: 'codex_app', name: 'create_thread', output: 'PRIVATE_DELEGATION' } };
    if (format === 'toolOutput') first.items = first.items.filter(item => item.type !== 'userMessage');
    const sourceMessageId = historyMessages(historyTurns(state(host, thread, [first]), thread)).find(message => message.role === 'user')?.id;
    const f = await fixture(t, { verifiedFirstMessage: (hostId, threadId) => hostId === host && threadId === thread
      ? { id: requestId, turnId: first.turnId, sourceMessageId, text: originalText, createdAt: new Date().toISOString() } : undefined });
    const later = nativeTurn(randomUUID(), 'My next message');
    later.params.toolOutput = { namespace: 'secret_tool', name: 'private', output: 'PRIVATE_OTHER_TOOL_OUTPUT' };
    f.turns.set(`${host}:${thread}`, [first, later]);
    const page = await f.service.conversation(host, thread);
    assert.deepEqual(page.messages.filter(message => message.role === 'user').map(message => message.text), [originalText, 'My next message']);
    assert.equal(page.messages.filter(message => message.clientMessageId === requestId).length, 1);
    assert(!JSON.stringify(page).includes('PRIVATE_DELEGATION')); assert(!JSON.stringify(page).includes('PRIVATE_OTHER_TOOL_OUTPUT'));
    assert(!page.messages.some(message => message.role === 'user' && message.text.includes('WRAPPER')));
    const again = await f.service.conversation(host, thread);
    assert.deepEqual(again.messages.map(message => message.id), page.messages.map(message => message.id));
  }
});

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-conversation-'));
  const turns = new Map();
  const attempts = [];
  const waits = [];
  let service;
  const controls = { dir, turns, attempts, mode: 'normal', targetChecks: [],
    async waitForAttempts(count) {
      if (attempts.length >= count) return;
      await new Promise(resolve => waits.push({ count, resolve }));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  const connection = {
    close() {},
    async startMessageTurn(message) {
      attempts.push(message);
      for (const waiter of waits.filter(waiter => attempts.length >= waiter.count)) waiter.resolve();
      if (controls.mode === 'busy') throw new CodexDesktopIpcError('Busy', 409);
      if (controls.mode === 'unknown') throw new CodexDesktopIpcError('Lost confirmation', 503, 'unknown');
      const turn = nativeTurn(message.clientUserMessageId, message.text, 'inProgress');
      turn.items[0].content.push(...message.attachments.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.dataBase64}` })));
      const key = `${message.hostId}:${message.threadId}`;
      turns.set(key, [...turns.get(key) ?? [], turn]);
      return { turnId: turn.turnId, clientUserMessageId: message.clientUserMessageId };
    },
    async readSnapshot(hostId, threadId) {
      return { hostId, threadId, conversationState: state(hostId, threadId, turns.get(`${hostId}:${threadId}`) ?? []) };
    },
  };
  const options = { dataDir: dir, retryMs: 60_000, connect: async () => connection, requireTarget: async (hostId, threadId) => {
    controls.targetChecks.push([hostId, threadId]);
    if (hostId !== host && hostId !== 'local') throw new ConversationError('Unavailable chat.', 404, 'target_not_found');
  }, ...overrides };
  controls.open = () => { service = new CodexConversations(options); return service; };
  controls.service = controls.open();
  controls.restart = () => { service.close(); return controls.open(); };
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return controls;
}

test('concurrent UUID retries dispatch once, conflicting body or target is rejected, and new images survive restart', async t => {
  const f = await fixture(t);
  const message = input('Compare', { attachments: [image(), image({ name: 'Second.png' })] });
  const receipts = await Promise.all([f.service.accept(message), f.service.accept(message)]);
  assert.equal(receipts.filter(result => !result.duplicate).length, 1);
  await f.waitForAttempts(1);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].attachments.length, 2);
  await assert.rejects(f.service.accept({ ...message, text: 'Different' }), error => error.status === 409);
  await assert.rejects(f.service.accept({ ...message, hostId: 'local' }), error => error.status === 409);
  assert.equal((await f.service.get(host, thread, message.id)).state, 'running');
  const restored = f.restart();
  const receipt = await restored.get(host, thread, message.id);
  const attachment = receipt.message.attachments[0];
  const assetId = attachment.assetPath.split('/').at(-1).split('?')[0];
  assert.deepEqual(restored.asset(host, thread, assetId).bytes, Buffer.from(png, 'base64'));
  assert.throws(() => restored.asset('local', thread, assetId), error => error.status === 404);
  assert.throws(() => restored.asset(host, otherThread, assetId), error => error.status === 404);
  assert.equal((await restored.accept(message)).duplicate, true);
  assert.equal(f.attempts.length, 1, 'restart and HTTP retries must not replay admitted input');
  const page = await restored.conversation(host, thread);
  assert.equal(page.messages.filter(item => item.clientMessageId === message.id).length, 1);
  assert.equal(page.messages.find(item => item.clientMessageId === message.id).attachments.length, 2);
});

test('a lost receipt is reconciled by native clientId, never by matching text, and releases the next queued message', async t => {
  const f = await fixture(t);
  f.mode = 'unknown';
  const first = input('Same text');
  await f.service.accept(first); await f.waitForAttempts(1);
  assert.equal((await f.service.get(host, thread, first.id)).state, 'unknown');
  const second = input('Same text');
  await f.service.accept(second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts.length, 1);
  const turn = nativeTurn(first.id, first.text, 'interrupted');
  // Live Desktop uses item.clientId, not item.id, for this association. A turn
  // can contain another desktop user message, so do not rely on a single input.
  turn.items.push({ id: randomUUID(), clientId: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: first.text }] });
  f.turns.set(`${host}:${thread}`, [turn]);
  const restored = f.restart();
  f.mode = 'normal';
  assert.equal((await restored.get(host, thread, first.id)).state, 'unknown');
  turn.status = 'completed';
  assert.equal((await restored.get(host, thread, first.id)).state, 'completed');
  await f.waitForAttempts(2);
  assert.deepEqual(f.attempts.map(item => item.clientUserMessageId), [first.id, second.id]);
});

test('busy targets preserve FIFO, pending survives restart, and another host can proceed', async t => {
  const f = await fixture(t);
  f.mode = 'busy';
  const first = input('First'); const second = input('Second');
  await f.service.accept(first); await f.waitForAttempts(1);
  await f.service.accept(second); await f.waitForAttempts(2);
  assert(f.attempts.every(item => item.clientUserMessageId === first.id));
  assert.equal((await f.service.get(host, thread, first.id)).state, 'pending');
  assert.equal((await f.service.get(host, thread, second.id)).state, 'pending');
  f.mode = 'normal';
  const restored = f.restart();
  await f.waitForAttempts(3);
  const local = input('Local', { hostId: 'local' });
  await restored.accept(local); await f.waitForAttempts(4);
  assert.deepEqual(f.attempts.slice(2).map(item => item.clientUserMessageId), [first.id, local.id]);
  assert(!f.attempts.some(item => item.clientUserMessageId === second.id));
  await assert.rejects(restored.accept(input('Unavailable', { hostId: 'remote-control:env_disabled' })), error => error.status === 404);
});

test('a crash after the durable dispatch boundary recovers as unknown and never repeats the send', async t => {
  const f = await fixture(t);
  f.mode = 'busy';
  const message = input('Before crash');
  await f.service.accept(message); await f.waitForAttempts(1);
  f.service.close();
  const attemptsBeforeRestart = f.attempts.length;
  const path = join(f.dir, 'messages', `${message.id}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.state = 'dispatching';
  await writeFile(path, JSON.stringify(saved));
  f.mode = 'normal';
  const restored = f.open();
  assert.equal((await restored.get(host, thread, message.id)).state, 'unknown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts.length, attemptsBeforeRestart);
  f.turns.set(`${host}:${thread}`, [nativeTurn(message.id, message.text)]);
  assert.equal((await restored.get(host, thread, message.id)).state, 'completed');
  assert.equal(f.attempts.length, attemptsBeforeRestart);
});

test('legacy drawing prompts become image messages without removing ordinary user text', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const prompt = `${submissionMarker(id)}请查看本条消息附带的画布图片，用中文回复：若图中有明确问题就回答；否则简要说明看到了什么，意图不清楚时询问。请以本条消息的图片为准。`;
  const old = nativeTurn(id, prompt);
  old.items[0].content.push({ type: 'image', url: `data:image/png;base64,${png}` });
  const ordinary = nativeTurn(randomUUID(), `${submissionMarker(id)}This is ordinary text.`);
  f.turns.set(`${host}:${thread}`, [old, ordinary]);
  const page = await f.service.conversation(host, thread);
  const users = page.messages.filter(message => message.role === 'user');
  assert.equal(users[0].text, '');
  assert.equal(users[0].attachments[0].availability, 'available');
  assert.equal(users[1].text, `${submissionMarker(id)}This is ordinary text.`);
  assert.equal(users.length, 2);
});

test('history is chronological and bounded, hides internal events, serves only safe image assets and scopes cursors', async t => {
  const f = await fixture(t);
  const turns = Array.from({ length: 4 }, (_, index) => nativeTurn(randomUUID(), `Message ${index}`));
  turns[3].items[0].content.push({ type: 'localImage', path: '/private/secret.png' },
    { type: 'image', url: 'https://private.example/credential' }, { type: 'image', url: `data:image/png;base64,${png}` },
    { type: 'image', url: `data:image/png;base64,${png}` });
  f.turns.set(`${host}:${thread}`, turns);
  const page = await f.service.conversation(host, thread, { limit: 4 });
  assert.equal(page.messages.length, 4);
  assert.deepEqual(page.messages.map(item => item.text), ['Answer Message 2', 'Message 3', 'Working…', 'Answer Message 3']);
  assert.equal(page.messages[1].createdAt, '2026-10-16T04:39:27.935Z');
  assert.deepEqual(page.messages[1].attachments.map(image => image.availability), ['unavailable', 'unavailable', 'available', 'available']);
  assert.equal(new Set(page.messages[1].attachments.map(image => image.id)).size, 4, 'repeated historical images retain separate view identities');
  const serialized = JSON.stringify(page);
  for (const forbidden of ['PRIVATE_', '/private/', 'private.example', 'data:image', 'reasoning', 'commandExecution', 'memoryCitation']) assert(!serialized.includes(forbidden));
  const older = await f.service.conversation(host, thread, { before: page.beforeCursor, limit: 4 });
  assert.equal(older.messages.length, 4);
  assert(!older.messages.some(message => page.messages.some(newer => newer.id === message.id)));
  await assert.rejects(f.service.conversation('local', thread, { before: page.beforeCursor }), error => error.status === 400);
  await assert.rejects(f.service.conversation(host, otherThread, { before: page.beforeCursor }), error => error.status === 400);
  await assert.rejects(f.service.conversation(host, thread, { limit: 101 }), error => error.status === 400);
});

test('validation rejects empty, oversized and forged attachment inputs before native dispatch', () => {
  for (const invalid of [input(' '), input('a'.repeat(20001)), input('Hi', { attachments: Array.from({ length: 5 }, () => image()) }),
    input('Hi', { attachments: [image({ dataBase64: 'notbase64' })] }), input('Hi', { attachments: [image({ mimeType: 'image/jpeg' })] }),
    input('Hi', { attachments: [image({ name: '../secret' })] }), input('Hi', { hostId: 'http://arbitrary' })]) {
    assert.throws(() => parseMessageInput(invalid), ConversationError);
  }
  assert.equal(parseMessageInput(input('', { attachments: [image()] })).text, '');
  const duplicate = image();
  assert.throws(() => parseMessageInput(input('Two', { attachments: [duplicate, duplicate] })));
  const large = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from(png, 'base64').copy(large);
  const three = Array.from({ length: 3 }, () => image({ dataBase64: large.toString('base64') }));
  assert.equal(parseMessageInput(input('', { attachments: three })).attachments.length, 3, '24 MiB is accepted without regex stack overflow');
  assert.throws(() => parseMessageInput(input('', { attachments: [...three, image()] })), error => error.status === 413);
});

test('HTTP conversation and asset routes require pairing and preserve fixed targets and idempotent status codes', async t => {
  const f = await fixture(t);
  const app = express();
  app.use((req, res, next) => {
    if (req.path.startsWith('/device/test/api/')) { res.locals.autoReplyAuthorized = true; req.url = req.url.slice('/device/test'.length); }
    next();
  });
  app.use(express.json());
  installConversationRoutes(app, f.service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paired = `${base}/device/test`;
  const query = new URLSearchParams({ hostId: host, threadId: thread });
  const message = input('HTTP', { attachments: [image()] });
  const post = url => fetch(`${url}/api/codex/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  assert.equal((await post(base)).status, 403);
  assert.equal((await fetch(`${base}/api/codex/conversation?${query}`)).status, 403);
  const accepted = await post(paired); assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal((await post(paired)).status, 200);
  await f.waitForAttempts(1);
  assert.equal((await fetch(`${paired}/api/codex/messages/${message.id}?${query}`)).status, 200);
  assert.equal((await fetch(`${paired}/api/codex/messages/${message.id}?hostId=local&threadId=${thread}`)).status, 404);
  assert.equal((await fetch(`${paired}/api/codex/conversation?${query}&hostId=local`)).status, 400);
  const assetPath = receipt.message.attachments[0].assetPath;
  assert.equal((await fetch(`${base}${assetPath}`)).status, 403);
  const asset = await fetch(`${paired}${assetPath}`);
  assert.equal(asset.status, 200); assert.equal(asset.headers.get('cache-control'), 'no-store');
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal(f.attempts.length, 1);
});
