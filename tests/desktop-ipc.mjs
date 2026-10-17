import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexDesktopIpc, CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';
import * as desktopIpc from '../src/codex-desktop-ipc.ts';

const host = 'remote-control:env_test_remote';
const otherHost = 'remote-control:env_other_remote';
const thread = '00000000-0000-7000-8000-000000000003';
const turn = '00000000-0000-7000-8000-000000000004';
const submission = '00000000-0000-7000-8000-000000000005';
const owner = 'desktop-owner';
const clientId = 'petroglyphs-assigned-client';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const imageTurn = { hostId: host, threadId: thread, submissionId: submission,
  imageBase64: png, prompt: `Petroglyphs submission ${submission}: describe this drawing.` };
const initialState = () => ({ id: thread, hostId: host, resumeState: 'resumed', requests: [], turns: [],
  threadRuntimeStatus: { type: 'idle' },
  turnsPagination: { olderCursor: null, hasLoadedOldest: true, isLoadingOlder: false },
  turnHistory: { kind: 'canonical', history: { isComplete: true, entitiesByKey: {
    [`turn:${turn}`]: { turnId: turn, status: 'completed', params: { input: [] }, items: [
      { id: 'answer', type: 'agentMessage', text: 'old answer', phase: 'final_answer' },
    ] },
  } } },
});

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

async function fixture(t, custom = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-ipc-'));
  await chmod(dir, 0o700);
  const socketPath = join(dir, 'ipc.sock');
  const sockets = new Set();
  const requests = [];
  const failures = [];
  const selectedHost = custom.hostId ?? host;
  const controls = { state: { ...initialState(), hostId: selectedHost }, revision: 1, requests, sockets, socketPath, failures };
  const send = (socket, value) => socket.write(frame(value));
  const reply = (socket, request, result) => send(socket, { type: 'response', requestId: request.requestId,
    resultType: 'success', method: request.method, handledByClientId: owner, result });
  const publish = (socket, change, overrides = {}) => send(socket, { type: 'broadcast', sourceClientId: owner,
    targetClientIds: [clientId], version: 11, method: 'thread-stream-state-changed',
    params: { hostId: selectedHost, conversationId: thread, change }, ...overrides });
  Object.assign(controls, { send, reply, publish });
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
        const length = pending.readUInt32LE(0);
        const request = JSON.parse(pending.subarray(4, length + 4).toString('utf8'));
        pending = pending.subarray(length + 4); requests.push(request);
        Promise.resolve().then(async () => {
          if (request.type !== 'request') { await custom.nonRequest?.(request, socket, controls); return; }
          if (request.method === 'initialize') {
            assert.equal(request.sourceClientId, 'initializing-client');
            assert.equal(request.version, 0);
            assert.deepEqual(request.params, { clientType: 'petroglyphs' });
            if (custom.initialize) await custom.initialize(request, socket, controls);
            else reply(socket, request, { clientId });
            return;
          }
          assert.equal(request.sourceClientId, clientId);
          assert.equal(request.hostId, selectedHost);
          assert.equal(request.params.conversationId, thread);
          assert.equal(request.version, request.method === 'thread-follower-start-turn' ? 3 : 2);
          if (custom.request && await custom.request(request, socket, controls)) return;
          if (request.method === 'thread-follower-read-model-settings') {
            reply(socket, request, { settings: { model: 'gpt-6-astra', reasoningEffort: 'max', resumeState: 'resumed', privateDiagnostic: 'PRIVATE_SECRET' } });
          } else if (request.method === 'thread-follower-load-complete-history') {
            publish(socket, { type: 'snapshot', revision: controls.revision, conversationState: controls.state });
            reply(socket, request, { revision: controls.revision });
          } else if (request.method === 'thread-follower-start-turn') {
            reply(socket, request, { result: { turn: { id: turn } } });
          } else throw Error('Unexpected IPC method');
        }).catch(error => { failures.push(error); socket.destroy(); });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  controls.connect = async options => {
    const client = await CodexDesktopIpc.connect({ socketPath, timeoutMs: 500, ...options });
    t.after(() => client.close()); return client;
  };
  return controls;
}

test('IPC uses its own identity, frames split responses, refuses discovery, and isolates a fixed host/chat subscription', async t => {
  let discovery;
  const discoverySeen = new Promise(resolve => { discovery = resolve; });
  const f = await fixture(t, {
    initialize: async (request, socket, c) => {
      c.send(socket, { type: 'client-discovery-request', requestId: 'probe-discovery', request: { method: 'arbitrary-tool' } });
      const bytes = frame({ type: 'response', requestId: request.requestId, resultType: 'success', method: 'initialize', result: { clientId } });
      socket.write(bytes.subarray(0, 2));
      await new Promise(resolve => setImmediate(resolve));
      socket.write(bytes.subarray(2, 7));
      await new Promise(resolve => setImmediate(resolve));
      socket.write(bytes.subarray(7));
    },
    nonRequest: (request) => { if (request.type === 'client-discovery-response') discovery(request); },
  });
  const ipc = await f.connect();
  assert.deepEqual((await discoverySeen).response, { canHandle: false });
  assert.deepEqual(await ipc.readSettings(host, thread), { model: 'gpt-6-astra', reasoningEffort: 'max', resumeState: 'resumed' });
  const updates = [];
  let patched;
  const updated = new Promise(resolve => { patched = resolve; });
  const stop = await ipc.subscribe(host, thread, snapshot => {
    updates.push(snapshot); if (snapshot.revision === 2) patched(snapshot);
  });
  const socket = [...f.sockets][0];
  f.publish(socket, { type: 'snapshot', revision: 99, conversationState: { ...initialState(), hostId: otherHost } },
    { params: { hostId: otherHost, conversationId: thread, change: { type: 'snapshot', revision: 99, conversationState: initialState() } } });
  f.publish(socket, { type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', `turn:${turn}`, 'items', 0, 'text'], value: 'streamed answer' },
    { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', `turn:${turn}`, 'items', 1], value: { id: 'second', type: 'agentMessage', text: 'second' } },
  ] });
  const current = await updated;
  assert.equal(current.conversationState.turnHistory.history.entitiesByKey[`turn:${turn}`].items[0].text, 'streamed answer');
  assert.equal(updates[0].conversationState.turnHistory.history.entitiesByKey[`turn:${turn}`].items[0].text, 'old answer', 'published snapshots must remain stable');
  assert.equal(updates.length, 2, 'another host must not publish into this subscription');
  stop();
  assert(f.requests.every(request => request.method !== 'thread-owner-discovery'));
});

test('an incompatible Desktop stream version reports protocol mismatch rather than a disconnected host', async t => {
  const f = await fixture(t);
  const ipc = await f.connect();
  let failed;
  const error = new Promise(resolve => { failed = resolve; });
  const stop = await ipc.subscribe(host, thread, () => {}, failed);
  f.publish([...f.sockets][0], { type: 'snapshot', revision: 2, conversationState: f.state }, { version: 12 });
  const result = await error;
  assert.equal(result.code, 'protocol_mismatch');
  assert.equal(result.outcome, 'not_sent');
  stop();
});

test('startImageTurn hydrates a fresh snapshot and sends the exact PNG to the fixed remote chat with inherited settings', async t => {
  const f = await fixture(t);
  const ipc = await f.connect();
  assert.deepEqual(await ipc.startImageTurn(imageTurn), { turnId: turn, clientUserMessageId: submission });
  const send = f.requests.find(request => request.method === 'thread-follower-start-turn');
  assert.equal(send.targetClientId, owner);
  assert.deepEqual(send.params, { conversationId: thread, turnStart: {
    request: { threadId: thread, clientUserMessageId: submission, input: [
      { type: 'text', text: imageTurn.prompt, text_elements: [] },
      { type: 'image', url: `data:image/png;base64,${png}` },
    ] }, context: { inheritThreadSettings: true },
  } });
  assert(f.requests.findIndex(request => request.method === 'thread-follower-load-complete-history')
    < f.requests.findIndex(request => request.method === 'thread-follower-start-turn'));
  assert(!JSON.stringify(send).includes('permissions'));
  assert(!f.requests.some(request => /steer|set-queued/.test(request.method)));
});

test('text-only and multiple images use native input with the same fixed local or remote target and settings', async t => {
  for (const hostId of ['local', host]) {
    await t.test(hostId, async t => {
      const f = await fixture(t, { hostId });
      const ipc = await f.connect();
      await ipc.startMessageTurn({ hostId, threadId: thread, clientUserMessageId: submission, text: 'Continue this conversation.', attachments: [] });
      const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
      await ipc.startMessageTurn({ hostId, threadId: thread, clientUserMessageId: submission, text: 'Compare these images.', attachments: [
        { mimeType: 'image/png', dataBase64: png }, { mimeType: 'image/jpeg', dataBase64: jpeg },
      ] });
      const requests = f.requests.filter(request => request.method === 'thread-follower-start-turn');
      assert.deepEqual(requests[0].params.turnStart.request.input, [{ type: 'text', text: 'Continue this conversation.', text_elements: [] }]);
      assert.deepEqual(requests[1].params.turnStart.request.input, [
        { type: 'text', text: 'Compare these images.', text_elements: [] },
        { type: 'image', url: `data:image/png;base64,${png}` }, { type: 'image', url: `data:image/jpeg;base64,${jpeg}` },
      ]);
      for (const request of requests) {
        assert.equal(request.hostId, hostId);
        assert.equal(request.params.turnStart.request.threadId, thread);
        assert.equal(request.params.turnStart.request.clientUserMessageId, submission);
        assert.deepEqual(request.params.turnStart.context, { inheritThreadSettings: true });
      }
      await assert.rejects(ipc.startMessageTurn({ hostId, threadId: thread, clientUserMessageId: submission, text: '', attachments: [] }));
      assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 2);
    });
  }
});

test('a selected model travels with the turn while preserving the native mode, instructions and permission inheritance', async t => {
  for (const hostId of ['local', host]) {
    await t.test(hostId, async t => {
      const f = await fixture(t, { hostId });
      const nativeMode = { mode: 'plan', settings: { model: 'previous-model', reasoning_effort: 'medium',
        developer_instructions: 'Preserve the existing planning instructions.', futureSetting: { enabled: true } } };
      f.state.latestThreadSettings = { collaborationMode: structuredClone(nativeMode), approvalPolicy: 'on-request' };
      f.state.latestCollaborationMode = { mode: 'default', settings: { model: 'older-model', reasoning_effort: 'low', developer_instructions: null } };
      const selection = { model: 'host-catalog-model', reasoningEffort: 'host-catalog-effort' };
      const ipc = await f.connect();
      await ipc.startMessageTurn({ hostId, threadId: thread, clientUserMessageId: submission,
        text: 'Use the selected configuration.', attachments: [], selection });
      const sent = f.requests.find(request => request.method === 'thread-follower-start-turn');
      assert.deepEqual(sent.params.turnStart.request.collaborationMode, { ...nativeMode,
        settings: { ...nativeMode.settings, model: selection.model, reasoning_effort: selection.reasoningEffort } });
      assert.deepEqual(f.state.latestThreadSettings.collaborationMode, nativeMode, 'preparing a send must not edit the observed native settings');
      assert.deepEqual(sent.params.turnStart.context, { inheritThreadSettings: true });
      assert(!Object.hasOwn(sent.params.turnStart.request, 'approvalPolicy'));
      assert(!Object.hasOwn(sent.params.turnStart.request, 'sandboxPolicy'));
      assert(!f.requests.some(request => request.method === 'thread-follower-update-thread-settings'));
    });
  }
});

test('an image send freezes its selection before asynchronous history loading and supports the older mode location', async t => {
  let releaseHistory, historyRequested;
  const reachedHistory = new Promise(resolve => { historyRequested = resolve; });
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const f = await fixture(t, { request: async (request) => {
    if (request.method === 'thread-follower-load-complete-history') {
      historyRequested();
      await historyGate;
    }
    return false;
  } });
  f.state.latestCollaborationMode = { mode: 'default', settings: { model: 'previous-model', reasoning_effort: 'low', developer_instructions: null } };
  const selection = { model: 'selected-model', reasoningEffort: 'max' };
  const ipc = await f.connect();
  const sending = ipc.startImageTurn({ ...imageTurn, selection });
  await reachedHistory;
  selection.model = 'later-draft-model'; selection.reasoningEffort = 'low';
  releaseHistory();
  await sending;
  const sent = f.requests.find(request => request.method === 'thread-follower-start-turn');
  assert.deepEqual(sent.params.turnStart.request.collaborationMode, { mode: 'default', settings: {
    model: 'selected-model', reasoning_effort: 'max', developer_instructions: null,
  } });
});

test('explicit selections fail before sending when the pair or inherited mode is unavailable', async t => {
  const f = await fixture(t);
  const ipc = await f.connect();
  for (const selection of [null, { model: '', reasoningEffort: 'max' }, { model: ' model', reasoningEffort: 'max' },
    { model: 'model', reasoningEffort: '' }, { model: 'model', reasoningEffort: 'max', approvalPolicy: 'never' }]) {
    await assert.rejects(ipc.startMessageTurn({ hostId: host, threadId: thread, clientUserMessageId: submission,
      text: 'Test selection validation.', attachments: [], selection }),
    error => error.outcome === 'not_sent' && error.code === 'invalid_model_selection');
  }
  const input = { hostId: host, threadId: thread, clientUserMessageId: submission,
    text: 'Do not replace missing instructions with defaults.', attachments: [], selection: { model: 'selected-model', reasoningEffort: 'max' } };
  await assert.rejects(ipc.startMessageTurn(input), error => error.outcome === 'not_sent' && error.code === 'model_settings_unavailable');
  f.state.latestCollaborationMode = { mode: 'default', settings: { developer_instructions: null } };
  f.state.latestThreadSettings = { collaborationMode: { mode: 'plan', settings: { developer_instructions: 123 } } };
  await assert.rejects(ipc.startMessageTurn(input), error => error.outcome === 'not_sent' && error.code === 'model_settings_unavailable');
  assert(!f.requests.some(request => request.method === 'thread-follower-start-turn'));
});

test('native first-message defaults preserve an explicitly unset effort and Desktop developer instructions', async t => {
  const f = await fixture(t, { hostId: 'local' });
  f.state.latestThreadSettings = { collaborationMode: { mode: 'default', settings: {
    model: 'desktop-global-model', reasoning_effort: 'high', developer_instructions: 'Keep Desktop context.' } } };
  const ipc = await f.connect();
  await ipc.startMessageTurn({ hostId: 'local', threadId: thread, clientUserMessageId: submission,
    text: 'First native message.', attachments: [], initialModelSettings: { model: 'native-default-model', reasoningEffort: null } });
  const sent = f.requests.find(request => request.method === 'thread-follower-start-turn');
  assert.deepEqual(sent.params.turnStart.request.collaborationMode, { mode: 'default', settings: {
    model: 'native-default-model', reasoning_effort: null, developer_instructions: 'Keep Desktop context.' } });
  assert.deepEqual(sent.params.turnStart.context, { inheritThreadSettings: true });
  await assert.rejects(ipc.startMessageTurn({ hostId: 'local', threadId: thread, clientUserMessageId: submission,
    text: 'Ambiguous settings.', attachments: [], selection: { model: 'one', reasoningEffort: 'max' },
    initialModelSettings: { model: 'two', reasoningEffort: null } }), error => error.code === 'invalid_model_selection');
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('turn model evidence comes from that turn and retains native rerouting instead of assuming the requested model ran', () => {
  const nativeTurn = { params: { model: null, effort: null, collaborationMode: { mode: 'plan', settings: {
    model: 'selected-model', reasoning_effort: 'max', developer_instructions: 'Private instructions must not enter evidence.',
  } } }, items: [{ type: 'modelRerouted', fromModel: 'selected-model', toModel: 'native-routed-model', reason: 'nativeReason' }] };
  assert.deepEqual(desktopIpc.readTurnModelEvidence(nativeTurn), { model: 'selected-model', reasoningEffort: 'max',
    reroutes: [{ fromModel: 'selected-model', toModel: 'native-routed-model', reason: 'nativeReason' }] });
  assert.deepEqual(desktopIpc.readTurnModelEvidence({ params: { model: 'remote-model', effort: 'high', collaborationMode: null }, items: [] }),
    { model: 'remote-model', reasoningEffort: 'high', reroutes: [] });
  assert.deepEqual(desktopIpc.readTurnModelEvidence({ params: { model: 'remote-model', effort: null }, items: [] }),
    { model: 'remote-model', reasoningEffort: null, reroutes: [] });
  assert.equal(desktopIpc.readTurnModelEvidence({ latestModel: 'current-model', latestReasoningEffort: 'max', items: [] }), undefined);
  assert.equal(desktopIpc.readTurnModelEvidence({ params: { model: 'different-model', effort: 'max',
    collaborationMode: nativeTurn.params.collaborationMode }, items: [] }), undefined);
  assert.equal(desktopIpc.readTurnModelEvidence({ ...nativeTurn, items: [{ type: 'modelRerouted', toModel: 'unknown-origin' }] }), undefined);
});

test('busy and incomplete chats reject before mutation, and a later idle attempt can proceed', async t => {
  const f = await fixture(t);
  const ipc = await f.connect();
  f.state.threadRuntimeStatus.type = 'active';
  await assert.rejects(ipc.startImageTurn(imageTurn), error => error.status === 409 && error.outcome === 'not_sent');
  f.state.threadRuntimeStatus.type = 'idle';
  f.state.turnHistory.history.isComplete = false;
  await assert.rejects(ipc.startImageTurn(imageTurn), error => error.outcome === 'not_sent' && error.message.includes('fully load'));
  assert(!f.requests.some(request => request.method === 'thread-follower-start-turn'));
  f.state.turnHistory.history.isComplete = true;
  await ipc.startImageTurn(imageTurn);
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('snapshot revision gaps trigger a fresh history request and malformed prototype patches cannot alter state', async t => {
  const f = await fixture(t);
  const ipc = await f.connect();
  let refreshed, invalid;
  const fresh = new Promise(resolve => { refreshed = resolve; });
  const rejected = new Promise(resolve => { invalid = resolve; });
  const stop = await ipc.subscribe(host, thread, snapshot => { if (snapshot.revision === 5) refreshed(snapshot); }, invalid);
  f.revision = 5;
  f.state.title = 'refreshed';
  const socket = [...f.sockets][0];
  f.publish(socket, { type: 'patches', baseRevision: 3, revision: 4, patches: [] });
  assert.equal((await fresh).conversationState.title, 'refreshed');
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-load-complete-history').length, 2);
  f.publish(socket, { type: 'patches', baseRevision: 5, revision: 6, patches: [{ op: 'add', path: ['__proto__', 'polluted'], value: true }] });
  assert.equal((await rejected).outcome, 'not_sent');
  assert.equal({}.polluted, undefined);
  stop();
});

test('after-send timeouts, disconnects and invalid receipts are unknown and never replayed', async t => {
  for (const mode of ['timeout', 'disconnect', 'invalid', 'rejected']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { request: (request, socket, c) => {
        if (request.method !== 'thread-follower-start-turn') return false;
        if (mode === 'disconnect') socket.destroy();
        if (mode === 'invalid') c.reply(socket, request, { result: { turn: { id: 'invalid' } } });
        if (mode === 'rejected') c.send(socket, { type: 'response', requestId: request.requestId,
          resultType: 'error', error: 'PRIVATE_DESKTOP_ERROR /secret/path' });
        return true;
      } });
      const ipc = await f.connect({ timeoutMs: 100 });
      await assert.rejects(ipc.startImageTurn(imageTurn), error => error instanceof CodexDesktopIpcError
        && error.outcome === 'unknown' && !error.message.includes('PRIVATE_'));
      assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
    });
  }
});

test('a desktop follower timeout remains recoverable when the original send completes later', async t => {
  const f = await fixture(t, { request: (request, socket, c) => {
    if (request.method !== 'thread-follower-start-turn') return false;
    c.send(socket, { type: 'response', requestId: request.requestId,
      resultType: 'error', error: 'thread-follower-start-turn-timeout' });
    return true;
  } });
  const ipc = await f.connect();
  await assert.rejects(ipc.startImageTurn(imageTurn), error => error instanceof CodexDesktopIpcError
    && error.outcome === 'unknown' && error.code === 'follower_timeout');

  // Desktop's inner timeout does not cancel the remote turn. Reconciliation
  // must remain possible without dispatching the image a second time.
  f.revision++;
  f.state.turnHistory.history.entitiesByKey[`turn:${turn}`] = {
    turnId: turn, status: 'completed', params: { clientUserMessageId: submission, input: [] },
    items: [
      { id: submission, type: 'userMessage', content: [{ type: 'text', text: imageTurn.prompt }] },
      { id: 'late-answer', type: 'agentMessage', text: 'Original send completed.', phase: 'final_answer' },
    ],
  };
  const snapshot = await ipc.readSnapshot(host, thread);
  assert.equal(snapshot.conversationState.turnHistory.history.entitiesByKey[`turn:${turn}`].params.clientUserMessageId, submission);
  assert.equal(snapshot.conversationState.turnHistory.history.entitiesByKey[`turn:${turn}`].status, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('a receipt without its snapshot times out, private endpoint permissions are enforced, and oversized frames fail safely', async t => {
  const f = await fixture(t, { request: (request, socket, c) => {
    if (request.method === 'thread-follower-load-complete-history') { c.reply(socket, request, { revision: 2 }); return true; }
    return false;
  } });
  const ipc = await f.connect({ timeoutMs: 80 });
  await assert.rejects(ipc.readSnapshot(host, thread), error => error.outcome === 'not_sent' && error.message.includes('snapshot'));
  await chmod(f.socketPath, 0o644);
  await assert.rejects(f.connect(), error => error.outcome === 'not_sent');
  await chmod(f.socketPath, 0o600);
  const bounded = await f.connect({ maxFrameBytes: 1024 });
  const result = bounded.readSettings(host, thread);
  const header = Buffer.alloc(4); header.writeUInt32LE(2048);
  [...f.sockets].at(-1).write(header);
  await assert.rejects(result, error => error.outcome === 'not_sent');
});
