import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopSubmissions, readDesktopSubmissionReply } from '../dist/codex-desktop-submissions.js';
import { submissionMarker } from '../dist/codex-replies.js';

const host = 'remote-control:env_test_mini';
const otherHost = 'remote-control:env_test_other';
const thread = '00000000-0000-7000-8000-000000000001';
const turn = '00000000-0000-7000-8000-000000000002';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id, status = 'completed', extraItems = []) => ({
  hostId: host, threadId: thread, conversationState: { id: thread, turnHistory: { kind: 'canonical', history: {
    isComplete: true,
    islands: [{ entries: [{ value: 'turn:1' }] }],
    entitiesByKey: { 'turn:1': { turnId: turn, status, error: null, items: [
      { type: 'agentMessage', id: 'older', text: 'Earlier unrelated answer', phase: 'final_answer' },
      { type: 'userMessage', id: 'input', content: [{ type: 'text', text: submissionMarker(id) }, { type: 'image', url: 'data:image/png;base64,' + image }] },
      { type: 'reasoning', id: 'private', text: 'Must stay private' },
      { type: 'mcpToolCall', id: 'tool', text: 'Must stay private' },
      { type: 'agentMessage', id: 'answer', text: 'Remote drawing received.', phase: 'final_answer' },
      ...extraItems,
    ] } },
  } } },
});
const oldSubmissionSnapshot = id => {
  const result = snapshot(id);
  const history = result.conversationState.turnHistory.history;
  // The reply is beyond the local RPC reader's item limit, and this completed
  // turn is older than its turn-discovery window. Desktop already hydrated all.
  history.entitiesByKey['turn:1'].items.splice(4, 0, ...Array.from({ length: 600 }, (_, index) => ({
    type: 'mcpToolCall', id: `old-tool-${index}`, text: 'PRIVATE_LONG_TURN_TOOL_RESULT',
  })));
  for (let index = 0; index < 151; index++) {
    const key = `later:${index}`;
    history.islands[0].entries.push({ value: key });
    history.entitiesByKey[key] = { turnId: key, status: 'completed', error: null, items: [
      { type: 'userMessage', id: `later-input-${index}`, content: [{ type: 'text', text: 'Unrelated newer request' }] },
      { type: 'agentMessage', id: `later-answer-${index}`, text: 'PRIVATE_NEWER_ANSWER', phase: 'final_answer' },
    ] };
  }
  return result;
};
const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-desktop-jobs-'));
const stores = [];
try {
  const id = '00000000-0000-7000-8000-000000000004';
  const result = await readDesktopSubmissionReply(snapshot(id).conversationState, { id, threadId: thread, knownSubmissionIds: [id] });
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.messages, [{ id: 'answer', text: 'Remote drawing received.', phase: 'final_answer' }]);
  const race = snapshot(id);
  race.conversationState.turnHistory.history.entitiesByKey['turn:1'].items.unshift(
    { type: 'userMessage', id: 'concurrent-input', content: [{ type: 'text', text: 'Another input won the idle race' }] });
  const shared = await readDesktopSubmissionReply(race.conversationState, { id, threadId: thread, knownSubmissionIds: [id] });
  assert.equal(shared.state, 'completed');
  assert.match(shared.notice, /combined this drawing/);
  const mixed = await readDesktopSubmissionReply(snapshot(id, 'completed', [
    { type: 'userMessage', id: 'other', content: [{ type: 'text', text: 'A different request' }] },
    { type: 'agentMessage', id: 'different-answer', text: 'Not the drawing response', phase: 'final_answer' },
  ]).conversationState, { id, threadId: thread, knownSubmissionIds: [id] });
  assert.equal(mixed.state, 'unknown');
  assert.deepEqual(mixed.messages, []);
  await assert.rejects(readDesktopSubmissionReply({ ...snapshot(id).conversationState, id: 'wrong' },
    { id, threadId: thread, knownSubmissionIds: [id] }), /different chat/);

  let sent = [];
  let current;
  const connection = {
    close() {},
    async startImageTurn(input) {
      sent.push(input); current = input.submissionId;
      throw Object.assign(new Error('Connection lost after write'), { status: 503, outcome: 'unknown' });
    },
    async readSnapshot() { return snapshot(current); },
  };
  const dataDir = join(dir, 'unknown');
  const store = new DesktopSubmissions({ dataDir, connect: async () => connection, retryMs: 60_000 }); stores.push(store);
  const receipt = await store.accept(host, thread, image);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].hostId, host);
  assert.equal(sent[0].threadId, thread);
  assert.equal(sent[0].imageBase64, image);
  assert(sent[0].prompt.includes(submissionMarker(receipt.id)));
  assert.equal(JSON.parse(await readFile(join(dataDir, `${receipt.id}.json`))).state, 'unknown');
  assert.deepEqual(store.list(otherHost, thread).submissions, []);
  await assert.rejects(store.get(otherHost, receipt.id), error => error.status === 404);
  store.close();
  const restored = new DesktopSubmissions({ dataDir, connect: async () => connection, retryMs: 60_000 }); stores.push(restored);
  const recovered = await restored.get(host, receipt.id);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.messages[0].text, 'Remote drawing received.');
  assert.equal(sent.length, 1, 'uncertain sends must be reconciled without replay');
  assert.equal(restored.list(host, thread).submissions[0].id, receipt.id);

  const oldCalls = [];
  const oldDataDir = join(dir, 'old-unknown');
  const oldConnection = {
    close() {},
    async startImageTurn(input) {
      oldCalls.push(input.submissionId);
      if (oldCalls.length === 1) throw Object.assign(new Error('Receipt lost after write'), { outcome: 'unknown' });
      return { turnId: 'next-turn', clientUserMessageId: input.submissionId };
    },
    async readSnapshot() { return oldSubmissionSnapshot(oldCalls[0]); },
  };
  const oldStore = new DesktopSubmissions({ dataDir: oldDataDir, connect: async () => oldConnection, retryMs: 60_000 }); stores.push(oldStore);
  const oldReceipt = await oldStore.accept(host, thread, image); await tick();
  assert.equal(JSON.parse(await readFile(join(oldDataDir, `${oldReceipt.id}.json`))).state, 'unknown');
  oldStore.close();
  const oldRestored = new DesktopSubmissions({ dataDir: oldDataDir, connect: async () => oldConnection, retryMs: 60_000 }); stores.push(oldRestored);
  const oldRecovered = await oldRestored.get(host, oldReceipt.id);
  assert.equal(oldRecovered.state, 'completed', 'a lost receipt must recover beyond 300 newer items and 150 newer turns');
  assert.deepEqual(oldRecovered.messages, [{ id: 'answer', text: 'Remote drawing received.', phase: 'final_answer' }]);
  assert(!JSON.stringify(oldRecovered).includes('PRIVATE_'));
  const oldSaved = JSON.parse(await readFile(join(oldDataDir, `${oldReceipt.id}.json`)));
  assert.equal(oldSaved.turnId, turn);
  assert.equal(oldSaved.turnFinished, true, 'terminal turn lifecycle must still release the queue');
  const nextReceipt = await oldRestored.accept(host, thread, image); await tick();
  assert.deepEqual(oldCalls, [oldReceipt.id, nextReceipt.id], 'recovery must release the next drawing without replaying the old one');

  const sharedCalls = [];
  const sharedQueue = new DesktopSubmissions({ dataDir: join(dir, 'shared-terminal'), retryMs: 60_000, connect: async () => ({
    close() {},
    async startImageTurn(input) {
      sharedCalls.push(input.submissionId);
      return { turnId: turn, clientUserMessageId: input.submissionId };
    },
    async readSnapshot() { return snapshot(sharedCalls[0], 'completed', [
      { type: 'userMessage', id: 'later-input', content: [{ type: 'text', text: 'A simultaneous desktop request' }] },
      { type: 'agentMessage', id: 'shared-answer', text: 'Combined response', phase: 'final_answer' },
    ]); },
  }) }); stores.push(sharedQueue);
  const sharedFirst = await sharedQueue.accept(host, thread, image); await tick();
  const sharedSecond = await sharedQueue.accept(host, thread, image); await tick();
  assert.deepEqual(sharedCalls, [sharedFirst.id, sharedSecond.id],
    'a completed turn with uncertain reply attribution must release the next drawing');

  let busy = true;
  let admitted = [];
  const waiting = new DesktopSubmissions({ dataDir: join(dir, 'busy'), retryMs: 60_000, connect: async () => ({
    close() {},
    async startImageTurn(input) {
      if (busy) throw Object.assign(new Error('Busy'), { status: 409, outcome: 'not_sent' });
      admitted.push(input.submissionId);
      return { turnId: turn, clientUserMessageId: input.submissionId };
    },
    async readSnapshot() { return snapshot(admitted[0], 'inProgress'); },
  }) }); stores.push(waiting);
  const first = await waiting.accept(host, thread, image); await tick();
  const second = await waiting.accept(host, thread, image); await tick();
  assert.equal((await waiting.get(host, first.id)).state, 'pending');
  assert.equal((await waiting.get(host, second.id)).state, 'pending');
  assert.deepEqual(admitted, []);
  busy = false;
  // A later accepted drawing wakes the same durable queue without a test-only API.
  await waiting.accept(otherHost, thread, image); await tick();
  assert.equal(admitted[0], first.id, 'busy drawings retain their order');
  assert(!admitted.includes(second.id), 'a second drawing waits for the first reply');
  console.log('PASS: Desktop history privacy and association; remote host isolation; uncertain dispatch recovery beyond local paging windows without resend; terminal turn queue release; busy queue ordering.');
} finally {
  stores.forEach(store => store.close());
  await rm(dir, { recursive: true, force: true });
}
