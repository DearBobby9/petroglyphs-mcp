import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('explicit model pairs remain fixed across queueing, body retries and restart, including image messages', async t => {
  const selected = { model: 'test-model-a', reasoningEffort: 'high' };
  const checks = [];
  const f = await fixture(t, { requireSelection: async (hostId, selection, hasImages) => {
    checks.push({ hostId, selection: { ...selection }, hasImages });
  } });
  f.mode = 'busy';
  const first = input('First selection', { selection: selected, attachments: [image()] });
  const accepted = await f.service.accept(first);
  assert.deepEqual(accepted.receipt.selection, selected);
  assert.equal(accepted.receipt.modelVerification, 'pending');
  await f.waitForAttempts(1);
  selected.model = 'test-model-b';
  await assert.rejects(f.service.accept(first), error => error.status === 409);
  const original = { ...first, selection: { model: 'test-model-a', reasoningEffort: 'high' } };
  assert.equal((await f.service.accept(original)).duplicate, true);
  const attemptsBeforeRestart = f.attempts.length;
  f.mode = 'normal';
  const restored = f.restart();
  await f.waitForAttempts(attemptsBeforeRestart + 1);
  assert(f.attempts.every(attempt => JSON.stringify(attempt.selection) === JSON.stringify(original.selection)));
  assert(checks.length >= 3);
  assert(checks.every(check => check.hostId === host && check.selection.model === 'test-model-a' && check.hasImages));
  const turn = f.turns.get(`${host}:${thread}`)[0];
  turn.params.model = 'test-model-a'; turn.params.effort = 'high'; turn.status = 'completed';
  const receipt = await restored.get(host, thread, first.id);
  assert.equal(receipt.modelVerification, 'confirmed');
  assert.deepEqual(receipt.modelEvidence, { model: 'test-model-a', reasoningEffort: 'high', reroutes: [] });
  assert.equal((await f.restart().get(host, thread, first.id)).modelVerification, 'confirmed');
});

test('explicit configuration needs the host directory and is revalidated before any native write', async t => {
  const pair = { model: 'test-model', reasoningEffort: 'high' };
  const noCatalog = await fixture(t);
  await assert.rejects(noCatalog.service.accept(input('No catalogue', { selection: pair })),
    error => error.code === 'catalogue_unavailable');
  assert.equal(noCatalog.attempts.length, 0);
  let checks = 0, revalidated;
  const checked = new Promise(resolve => { revalidated = resolve; });
  const f = await fixture(t, { requireSelection: async () => {
    if (++checks > 1) {
      revalidated();
      throw new ConversationError('Selected model was removed.', 400, 'invalid_model_selection');
    }
  } });
  const message = input('Removed before dispatch', { selection: pair });
  await f.service.accept(message);
  await checked;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts.length, 0);
  const receipt = await f.service.get(host, thread, message.id);
  assert.equal(receipt.state, 'failed');
  assert.match(receipt.error, /model/i);
});

test('model verification uses matched turn evidence, surfaces reroutes and does not infer missing effort', async t => {
  for (const kind of ['missing', 'missing-effort', 'different', 'rerouted']) {
    const f = await fixture(t, { requireSelection: async () => {} });
    const message = input(kind, { selection: { model: 'test-model', reasoningEffort: 'high' } });
    await f.service.accept(message); await f.waitForAttempts(1);
    const turn = f.turns.get(`${host}:${thread}`)[0];
    turn.status = 'completed';
    if (kind !== 'missing') turn.params.model = kind === 'different' ? 'another-model' : 'test-model';
    if (kind !== 'missing-effort') turn.params.effort = 'high';
    if (kind === 'rerouted') turn.items.push({ type: 'modelRerouted', fromModel: 'test-model', toModel: 'another-model', reason: 'capacity' });
    const receipt = await f.service.get(host, thread, message.id);
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.modelVerification, kind.startsWith('missing') ? 'unverified' : 'different');
    assert.equal(f.attempts.length, 1, 'configuration differences must not replay a completed message');
  }
});

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

test('a created chat keeps first-turn model evidence current after creation has already completed', async t => {
  const requestId = randomUUID(), selection = { model: 'test-model', reasoningEffort: 'high' };
  const first = nativeTurn(randomUUID(), 'NATIVE_DELEGATION_WRAPPER', 'inProgress');
  first.params = { model: selection.model, effort: selection.reasoningEffort };
  first.items = first.items.filter(item => item.type !== 'userMessage');
  const f = await fixture(t, { verifiedFirstMessage: () => ({ id: requestId, turnId: first.turnId,
    text: 'First message', createdAt: new Date().toISOString(), selection }) });
  f.turns.set(`${host}:${thread}`, [first]);
  const initial = await f.service.conversation(host, thread);
  assert.equal(initial.receipts[0].id, requestId);
  assert.equal(initial.receipts[0].modelVerification, 'confirmed');
  assert.equal(initial.receipts[0].state, 'running');
  first.items.push({ type: 'modelRerouted', fromModel: 'test-model', toModel: 'fallback-model', reason: 'capacity' });
  first.status = 'completed';
  const final = await f.service.conversation(host, thread);
  assert.equal(final.receipts[0].modelVerification, 'different');
  assert.equal(final.receipts[0].modelEvidence.reroutes[0].toModel, 'fallback-model');
  assert.equal(final.receipts[0].state, 'completed');
  assert.equal(f.attempts.length, 0, 'history reconciliation never creates or sends another message');
});

test('a late native first message uses its real identity when the creation receipt has no source message ID', async t => {
  const requestId = randomUUID(), selection = { model: 'gpt-6-luna', reasoningEffort: 'max' };
  const text = 'Reply only IPAD_NATIVE_CREATE_OK.';
  const first = nativeTurn(requestId, text, 'inProgress', { items: [] });
  first.params = { clientUserMessageId: requestId, collaborationMode: { mode: 'default', settings: {
    model: selection.model, reasoning_effort: selection.reasoningEffort, developer_instructions: null } } };
  const f = await fixture(t, { verifiedFirstMessage: (hostId, threadId) => hostId === 'local' && threadId === thread
    ? { id: requestId, turnId: first.turnId, text, createdAt: new Date().toISOString(), selection } : undefined });
  f.turns.set(`local:${thread}`, [first]);
  const pending = await f.service.conversation('local', thread);
  assert.equal(pending.messages[0].id, `project:${requestId}`);

  first.status = 'completed';
  first.items = [{ id: randomUUID(), type: 'userMessage', clientId: requestId, content: [{ type: 'text', text }] },
    { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'IPAD_NATIVE_CREATE_OK' }];
  const realUserId = historyMessages(historyTurns(state('local', thread, [first]), thread))[0].id;
  const page = await f.service.conversation('local', thread);
  assert.deepEqual(page.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(page.messages.filter(message => message.clientMessageId === requestId).length, 1);
  assert.equal(page.messages[0].id, realUserId);
  assert.equal(page.messages[1].text, 'IPAD_NATIVE_CREATE_OK');
  assert.equal(page.receipts[0].message.id, realUserId);
  assert.equal(page.receipts[0].turnId, first.turnId);
  assert.equal(page.receipts[0].modelVerification, 'confirmed');
  assert.equal(f.attempts.length, 0);
});

test('an uncertain created first message joins the durable queue without dispatching again', async t => {
  const f = await fixture(t);
  const first = input('First image', { attachments: [image()] });
  f.service.adoptFirstMessage(first, { state: 'unknown', createdAt: new Date().toISOString() });
  assert.equal((await f.service.get(host, thread, first.id)).state, 'unknown');
  assert.equal((await f.service.accept(first)).duplicate, true);
  const next = input('Later message');
  await f.service.accept(next); await f.service.drain();
  assert.equal(f.attempts.length, 0);
  f.service.releaseWait(host, thread, first.id);
  const restored = f.restart();
  await restored.drain();
  assert.deepEqual(f.attempts.map(attempt => attempt.clientUserMessageId), [next.id]);
  const firstTurn = nativeTurn(first.id, first.text);
  f.turns.get(`${host}:${thread}`).unshift(firstTurn);
  const receipt = await restored.get(host, thread, first.id);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.message.attachments.length, 1);
  restored.adoptFirstMessage(first, { state: 'unknown', createdAt: receipt.createdAt });
  assert.equal((await restored.get(host, thread, first.id)).state, 'completed');
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

test('durable admission order survives identical timestamps, reversed IDs and clock rollback', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const first = input('First', { id: 'ffffffff-ffff-7fff-8fff-ffffffffffff' });
  const second = input('Second', { id: '00000000-0000-7000-8000-000000000001' });
  await f.service.accept(first);
  await f.service.accept(second);
  t.mock.timers.setTime(1_700_000_000_000);
  const third = input('Third after clock rollback');
  await f.service.accept(third);
  const restored = f.restart();
  for (const [index, expected] of [first, second, third].entries()) {
    await restored.drain();
    assert.equal(f.attempts[index]?.clientUserMessageId, expected.id);
    f.turns.get(`${host}:${thread}`).at(-1).status = 'completed';
  }
  await restored.drain();
  assert.equal(f.attempts.length, 3);
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

test('releasing an uncertain delivery survives restart, unblocks once and associates a late result with the original request', async t => {
  const f = await fixture(t);
  const first = input('Uncertain'), second = input('Continue after uncertainty');
  await f.service.accept(first);
  f.service.close();
  const path = join(f.dir, 'messages', `${first.id}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.state = 'dispatching';
  await writeFile(path, JSON.stringify(saved));
  const recovered = f.open();
  await recovered.accept(second);
  await recovered.drain();
  assert.equal(f.attempts.length, 0);
  const released = recovered.releaseWait(host, thread, first.id);
  assert.equal(released.state, 'unknown');
  assert.equal(released.queueBlocking, false);
  assert(released.waitReleasedAt);
  assert.equal(recovered.releaseWait(host, thread, first.id).waitReleasedAt, released.waitReleasedAt);
  recovered.close();
  const restarted = f.open();
  await restarted.drain();
  assert.deepEqual(f.attempts.map(attempt => attempt.clientUserMessageId), [second.id]);
  f.turns.get(`${host}:${thread}`).unshift(nativeTurn(first.id, first.text));
  const late = await restarted.get(host, thread, first.id);
  assert.equal(late.state, 'completed');
  assert.equal(late.message.clientMessageId, first.id);
  assert.equal(late.waitReleasedAt, released.waitReleasedAt);
  restarted.releaseWait(host, thread, first.id);
  await restarted.drain();
  assert.deepEqual(f.attempts.map(attempt => attempt.clientUserMessageId), [second.id]);
});

test('pending cancellation wins a paused preflight and cannot cancel a dispatched request', async t => {
  let unblock, entered;
  const paused = new Promise(resolve => { unblock = resolve; });
  const checking = new Promise(resolve => { entered = resolve; });
  let checks = 0;
  const f = await fixture(t, { requireTarget: async () => {
    if (++checks === 2) { entered(); await paused; }
  } });
  const first = input('Cancel before transport');
  await f.service.accept(first);
  const draining = f.service.drain();
  await checking;
  assert.equal(f.service.cancel(host, thread, first.id).state, 'cancelled');
  unblock(); await draining;
  assert.equal(f.attempts.length, 0);
  const restored = f.restart();
  assert.equal((await restored.get(host, thread, first.id)).state, 'cancelled');
  const second = input('Already dispatched');
  await restored.accept(second);
  await f.waitForAttempts(1);
  assert.throws(() => restored.cancel(host, thread, second.id), error => error.code === 'cannot_cancel');
  assert.throws(() => restored.releaseWait('local', thread, second.id), error => error.status === 404);
});

test('a failed queue-release save cannot let a later message pass the unresolved request', async t => {
  const f = await fixture(t);
  const first = input('Uncertain delivery');
  f.mode = 'unknown';
  await f.service.accept(first); await f.waitForAttempts(1);
  const next = input('Still waiting'); await f.service.accept(next); await f.service.drain();
  const blockedWrite = join(f.dir, 'messages', `${first.id}.json.tmp`);
  await mkdir(blockedWrite);
  assert.throws(() => f.service.releaseWait(host, thread, first.id));
  await rm(blockedWrite, { recursive: true });
  f.mode = 'normal'; await f.service.drain();
  assert.equal((await f.service.get(host, thread, first.id)).queueBlocking, true);
  assert.deepEqual(f.attempts.map(attempt => attempt.clientUserMessageId), [first.id]);
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

test('assistant result images become pinned paired assets without exposing source data', async t => {
  const f = await fixture(t);
  const turn = nativeTurn(randomUUID(), 'Image result');
  const generated = { id: randomUUID(), type: 'imageGeneration', result: png, status: 'completed' };
  const markdown = { id: randomUUID(), type: 'agentMessage', text: `Rendered: ![Mockup](${`data:image/png;base64,${png}`})`, phase: 'final_answer' };
  turn.items.push(generated, markdown);
  f.turns.set(`${host}:${thread}`, [turn]);

  let page = await f.service.conversation(host, thread);
  const imageMessage = page.messages.find(message => message.id === createHash('sha256').update(`${turn.turnId}\0${generated.id}`).digest('hex'));
  assert.equal(imageMessage.attachments[0].availability, 'available');
  const assetId = imageMessage.attachments[0].assetPath.split('/').at(-1).split('?')[0];
  assert.deepEqual(f.service.asset(host, thread, assetId).bytes, Buffer.from(png, 'base64'));
  const rendered = page.messages.find(message => message.id === createHash('sha256').update(`${turn.turnId}\0${markdown.id}`).digest('hex'));
  assert.equal(rendered.text, 'Rendered: [Image: Mockup]');
  assert.equal(rendered.attachments[0].availability, 'available');
  const serialized = JSON.stringify(page);
  assert(!serialized.includes('data:image'));
  assert(!serialized.includes('/tmp/'));

  generated.result = Buffer.from(png, 'base64').map((byte, index) => index === 30 ? byte ^ 1 : byte).toString('base64');
  const restored = f.restart();
  page = await restored.conversation(host, thread);
  const pinned = page.messages.find(message => message.id === imageMessage.id).attachments[0];
  assert.equal(pinned.assetPath, imageMessage.attachments[0].assetPath);
  assert.deepEqual(restored.asset(host, thread, assetId).bytes, Buffer.from(png, 'base64'));
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

test('history projection reuse follows owner and revision and resynchronizes after a failed read', async t => {
  const metrics = [];
  let ownerClientId = 'owner-a', revision = 1, offline = false;
  let turns = [nativeTurn(randomUUID(), 'First')];
  const f = await fixture(t, { onHistoryRead: metric => metrics.push(metric), connect: async () => ({ close() {},
    async startMessageTurn() { assert.fail('History reads must not send'); },
    async readSnapshot(hostId, threadId) {
      if (offline) throw new Error('Disconnected');
      return { hostId, threadId, ownerClientId, revision, conversationState: state(hostId, threadId, turns) };
    } }) });
  const initial = await f.service.conversation(host, thread);
  assert.deepEqual((await f.service.conversation(host, thread)).messages, initial.messages);
  assert.equal(metrics.at(-1).cacheHit, true);
  turns = [...turns, nativeTurn(randomUUID(), 'Added')]; revision++;
  assert.equal((await f.service.conversation(host, thread)).messages.at(-1).text, 'Answer Added');
  assert.equal(metrics.at(-1).cacheHit, false);
  ownerClientId = 'owner-b'; // A replacement owner may reuse the same revision.
  turns = [nativeTurn(randomUUID(), 'Replacement owner')];
  assert.equal((await f.service.conversation(host, thread)).messages.at(-1).text, 'Answer Replacement owner');
  offline = true;
  await assert.rejects(f.service.conversation(host, thread), /Disconnected/);
  offline = false; turns = [nativeTurn(randomUUID(), 'Reconnected')];
  assert.equal((await f.service.conversation(host, thread)).messages.at(-1).text, 'Answer Reconnected');
  assert.equal(metrics.at(-1).cacheHit, false);
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
