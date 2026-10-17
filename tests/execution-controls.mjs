import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { CodexExecutionControls, installControlRoutes } from '../src/codex-execution-controls.ts';
import { CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';

const hostId = 'local';
const threadId = '00000000-0000-7000-8000-000000000001';
const turnId = '00000000-0000-7000-8000-000000000002';
const nextTurnId = '00000000-0000-7000-8000-000000000003';
const input = { hostId, threadId, turnId };
const state = () => ({ id: threadId, turns: [{ id: turnId, status: 'inProgress', items: [] }], requests: [
  { id: 'PRIVATE_REQUEST_ID', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: ['PRIVATE_PROMPT'] } },
  { id: 'PRIVATE_APPROVAL_ID', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'PRIVATE_COMMAND' } },
  { id: 'PRIVATE_OTHER_ID', method: 'PRIVATE_METHOD', params: { threadId, turnId } },
  { id: 'resolved', completed: true, method: 'item/fileChange/requestApproval', params: { threadId, turnId } },
] });
const runtime = async () => ({ compatibility: { state: 'baseline_match' } });

test('a local binary match and readable remote history do not prove that remote stop is supported', async () => {
  const remoteHost = 'remote-control:env_fixture';
  let interrupted = false;
  const service = new CodexExecutionControls({ runtime, requireTarget: async () => {}, connect: async () => ({
    readSnapshot: async () => ({ hostId: remoteHost, threadId, ownerClientId: 'remote-owner', conversationState: state() }),
    verifyLocalInterrupt: async () => { throw new Error('Remote capability must not use a local probe'); },
    interruptTurn: async () => { interrupted = true; return { interruptedTurnId: turnId }; }, close() {},
  }) });
  const result = await service.read(remoteHost, threadId);
  assert.equal(result.capabilities.stop.supported, false);
  assert.equal(result.capabilities.stop.reason, 'capability_unverified');
  await assert.rejects(service.stop({ ...input, hostId: remoteHost }), error => error.code === 'capability_unverified' && error.outcome === 'not_sent');
  assert.equal(interrupted, false);
});

test('controls use fresh target state, hide resolved interactions, and keep unsupported decisions in Desktop', async () => {
  let current = state(), closes = 0;
  const calls = [];
  const service = new CodexExecutionControls({ runtime, requireTarget: async (...args) => calls.push(args),
    connect: async () => ({ readSnapshot: async () => ({ hostId, threadId, ownerClientId: 'owner', conversationState: current }),
      verifyLocalInterrupt: async snapshot => snapshot.ownerClientId === 'owner',
      close: () => closes++, interruptTurn: async () => { throw new Error('Unexpected mutation'); } }) });
  const result = await service.read(hostId, threadId);
  assert.equal(result.activeTurnId, turnId);
  assert.equal(result.capabilities.stop.supported, true);
  assert.equal(result.capabilities.answer.supported, false);
  assert.equal(result.capabilities.approve.reason, 'no_authoritative_receipt');
  assert.deepEqual(result.pendingInteractions.map(value => value.kind), ['input', 'approval', 'other']);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  current = { id: threadId, turns: [{ id: turnId, status: 'completed', items: [] }], requests: [] };
  const refreshed = await service.read(hostId, threadId);
  assert.equal(refreshed.activeTurnId, null);
  assert.equal(refreshed.capabilities.stop.reason, 'no_active_turn');
  assert.deepEqual(refreshed.pendingInteractions, []);
  assert.equal(closes, 2);
  assert.deepEqual(calls, [[hostId, threadId], [hostId, threadId]]);
});

test('a readable local owner must negotiate the interrupt contract before the UI enables stop', async () => {
  const snapshots = [];
  const service = new CodexExecutionControls({ runtime, requireTarget: async () => {}, connect: async () => ({
    readSnapshot: async () => ({ hostId, threadId, ownerClientId: 'owner', revision: 8, conversationState: state() }),
    verifyLocalInterrupt: async snapshot => { snapshots.push(snapshot); return false; }, close() {},
  }) });
  const result = await service.read(hostId, threadId);
  assert.equal(result.capabilities.stop.supported, false);
  assert.equal(result.capabilities.stop.reason, 'capability_unverified');
  assert.equal(snapshots[0].hostId, hostId); assert.equal(snapshots[0].ownerClientId, 'owner');
});

test('concurrent duplicate stops share delivery and a later stale stop cannot target the new turn', async () => {
  let deliver;
  const barrier = new Promise(resolve => { deliver = resolve; });
  let started;
  const admitted = new Promise(resolve => { started = resolve; });
  let active = turnId, calls = 0, closes = 0;
  const service = new CodexExecutionControls({ runtime, requireTarget: async () => {}, connect: async () => ({
    interruptTurn: async target => {
      assert.deepEqual(target, input); calls++; started(); await barrier;
      const stopped = active === target.turnId ? active : null;
      if (stopped) active = nextTurnId;
      return { interruptedTurnId: stopped };
    }, close: () => closes++,
  }) });
  const first = service.stop(input), duplicate = service.stop({ ...input });
  await admitted; deliver();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.status, 'stopped'); assert.deepEqual(b, a); assert.equal(calls, 1);
  assert.equal((await service.stop(input)).status, 'already_finished');
  assert.equal(active, nextTurnId); assert.equal(calls, 2); assert.equal(closes, 2);
});

test('unverified versions, changed target snapshots, invalid targets and unknown receipts fail closed', async () => {
  let called = false;
  const blocked = new CodexExecutionControls({ runtime: async () => ({ compatibility: { state: 'unverified' } }),
    requireTarget: async () => {}, connect: async () => { called = true; throw new Error('Unexpected connection'); } });
  await assert.rejects(blocked.stop(input), error => error.code === 'unsupported_desktop_version' && error.outcome === 'not_sent');
  assert.equal(called, false);
  await assert.rejects(blocked.stop({ ...input, turnId: 'latest' }), error => error.code === 'invalid_control_target');
  for (const nativeError of [new CodexDesktopIpcError('PRIVATE_ERROR', 503, 'unknown', 'request_timeout'), null]) {
    const service = new CodexExecutionControls({ runtime, requireTarget: async () => {}, connect: async () => ({
      readSnapshot: async () => ({ hostId: 'remote-control:env_wrong', threadId, conversationState: state() }),
      interruptTurn: async () => { if (nativeError) throw nativeError; return { interruptedTurnId: nextTurnId }; }, close() {},
    }) });
    await assert.rejects(service.stop(input), error => error.code === 'control_delivery_unknown' && error.outcome === 'unknown');
    await assert.rejects(service.read(hostId, threadId), error => error.code === 'protocol_mismatch');
  }
});

test('control routes require pairing, bind one explicit turn and report unknown delivery without private errors', async t => {
  const app = express(), calls = [];
  app.use(express.json());
  app.use((req, res, next) => { res.locals.autoReplyAuthorized = req.headers.authorization === 'pair'; next(); });
  installControlRoutes(app, { read: async (host, thread) => ({ hostId: host, threadId: thread }),
    stop: async value => { calls.push(value); throw new CodexDesktopIpcError('PRIVATE_NATIVE_ERROR', 503, 'unknown', 'request_timeout'); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/codex/controls`;
  const stop = (body, paired = true) => fetch(base + '/stop', { method: 'POST', headers: {
    'content-type': 'application/json', ...(paired ? { authorization: 'pair' } : {}),
  }, body: JSON.stringify(body) });
  assert.equal((await stop(input, false)).status, 403);
  for (const body of [{ hostId, threadId }, { ...input, turnId: 'current' }, { ...input, approve: true }]) {
    assert.equal((await stop(body)).status, 400);
  }
  assert.equal(calls.length, 0);
  const read = await fetch(base + `?hostId=${hostId}&threadId=${threadId}`, { headers: { authorization: 'pair' } });
  assert.equal(read.headers.get('cache-control'), 'no-store'); assert.equal(read.status, 200);
  const failed = await stop(input), body = await failed.json();
  assert.equal(failed.status, 503); assert.equal(body.code, 'control_delivery_unknown');
  assert.equal(body.outcome, 'unknown'); assert.equal(body.handlingLocation, 'desktop');
  assert(!JSON.stringify(body).includes('PRIVATE_'));
  assert.deepEqual(calls, [input]);
});
