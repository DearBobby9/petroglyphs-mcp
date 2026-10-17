import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexCompanionCreator, ProjectCreationNotSentError, projectCreationEnvelope } from '../src/codex-companion-creator.ts';
import { CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';

const helper = randomUUID();
const remote = 'remote-control:env_companion_fixture';
const now = Date.parse('2026-10-16T12:00:00.400Z');
const user = (text, clientId = randomUUID()) => ({ id: randomUUID(), type: 'userMessage', clientId,
  content: [{ type: 'text', text }] });
const turn = (items, extra = {}) => ({ turnId: randomUUID(), status: 'completed', turnStartedAtMs: now, items, ...extra });
const state = (threadId, turns) => ({ id: threadId, turns: [], turnHistory: { history: { isComplete: true,
  islands: [{ entries: turns.map(turn => ({ key: turn.turnId, value: turn.turnId })) }],
  entitiesByKey: Object.fromEntries(turns.map(turn => [turn.turnId, turn])) } } });
const wrapped = (input, source = helper) => ['<codex_delegation>', `  <source_thread_id>${source}</source_thread_id>`,
  `  <input>${input.prompt.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</input>`, '</codex_delegation>'].join('\n');

function fixture(t, style = 'text', overrides = {}, creatorOptions = {}) {
  const input = { id: randomUUID(), hostId: remote, projectId: 'saved-remote-project', prompt: 'Explain A < B & C > D.',
    title: 'User title', createdAt: new Date(now).toISOString(), executorThreadId: helper,
    requestPath: '/private/service/requests/immutable.json', ...overrides };
  const threadId = randomUUID();
  const finalObject = { requestId: input.id, hostId: input.hostId, projectId: input.projectId, status: 'created', threadId };
  const finalText = () => `${JSON.stringify(finalObject)}\n::created-thread{threadId="${finalObject.threadId}"}`;
  const answer = { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: finalText() };
  const helperTurn = turn([user(projectCreationEnvelope(input), input.id), answer], { params: { clientUserMessageId: input.id } });
  const firstTurn = turn(style === 'toolOutput' ? [{ type: 'agentMessage', phase: 'final_answer', text: 'Answer' }]
    : [user(style === 'wrapped' ? wrapped(input) : input.prompt)], style === 'toolOutput'
      ? { params: { toolOutput: { namespace: 'codex_app', name: 'create_thread', output: wrapped(input) } } } : {});
  const snapshots = new Map([[`local:${helper}`, state(helper, [helperTurn])], [`${input.hostId}:${threadId}`, state(threadId, [firstTurn])]]);
  const candidates = [{ id: threadId, title: 'Native title', cwd: '/saved/remote', updatedAt: now / 1000,
    createdAt: Math.floor(now / 1000) }];
  const calls = [];
  const controls = { startError: null, truncated: false, reads: [], readyHost: null };
  const client = { close() {}, async readSnapshot(hostId, id) {
    controls.reads.push([hostId, id]);
    if (controls.readError) throw controls.readError;
    const value = snapshots.get(`${hostId}:${id}`);
    if (!value) throw new Error('Unavailable native snapshot');
    return { hostId, threadId: id, conversationState: value };
  }, async startMessageTurn(value) {
    calls.push(value); if (controls.startError) throw controls.startError;
    return { turnId: helperTurn.turnId, clientUserMessageId: input.id };
  } };
  const creator = new CodexCompanionCreator({ helperThreadId: helper, connect: async () => client, confirmationMs: 0,
    catalog: { async require(hostId, projectId) {
      assert.equal(hostId, input.hostId); assert.equal(projectId, input.projectId);
      return { id: projectId, hostId, path: '/saved/remote', name: 'Saved project' };
    }, async creationCandidates(hostId, projectId, since) {
      assert.equal(hostId, input.hostId); assert.equal(projectId, input.projectId); assert.equal(since, input.createdAt);
      return { threads: candidates, truncated: controls.truncated };
    }, async creationTarget(hostId, projectId, id, since) {
      assert.equal(hostId, input.hostId); assert.equal(projectId, input.projectId); assert.equal(since, input.createdAt);
      return candidates.find(thread => thread.id === id);
    } }, ...creatorOptions });
  t.after(() => creator.close());
  return { creator, input, threadId, finalObject, finalText, answer, helperTurn, firstTurn, snapshots, candidates, controls, calls };
}

test('configured companion sends one fixed local instruction and verifies a remote result through native membership and first prompt', async t => {
  const f = fixture(t);
  await f.creator.ready();
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'completed'); assert.equal(result.hostId, remote); assert.equal(result.thread.id, f.threadId);
  assert.equal(result.thread.title, 'Native title'); assert.equal(result.firstTurnId, f.firstTurn.turnId);
  assert.equal(f.calls.length, 1);
  assert.deepEqual([f.calls[0].hostId, f.calls[0].threadId, f.calls[0].clientUserMessageId], ['local', helper, f.input.id]);
  assert.deepEqual(f.calls[0].attachments, []);
  const envelope = JSON.parse(f.calls[0].text.split('\n').find(line => line.startsWith('{"requestId":')));
  assert.equal(envelope.requestPath, f.input.requestPath); assert.equal(envelope.projectId, f.input.projectId);
  assert(!f.calls[0].text.includes(f.input.prompt));
  assert(!('cwd' in envelope)); assert(!('model' in envelope));
  await f.creator.recoverChat(f.input); assert.equal(f.calls.length, 1);
  const missing = new CodexCompanionCreator({ connect: async () => { throw new Error('Must not connect'); }, catalog: {} });
  await assert.rejects(missing.ready(), ProjectCreationNotSentError); missing.close();
});

const officialResult = f => ({ id: `create-${randomUUID()}`, type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread', status: 'completed',
  arguments: { prompt: f.input.prompt, title: f.input.title,
    target: { type: 'project', projectId: f.input.projectId, environment: { type: 'local' } },
    ...(f.input.selection ? { model: f.input.selection.model, thinking: f.input.selection.reasoningEffort } : {}) },
  result: { content: [{ type: 'text', text: JSON.stringify({ status: 'created', threadId: f.threadId, hostId: f.input.hostId }) }] } });

test('an official result recovers only its target despite empty, unreadable and many later candidates', async t => {
  const f = fixture(t);
  f.helperTurn.items.push(officialResult(f));
  const empty = randomUUID();
  f.candidates.push({ ...f.candidates[0], id: empty });
  f.snapshots.set(`${f.input.hostId}:${empty}`, state(empty, []));
  f.candidates.push(...Array.from({ length: 60 }, () => ({ ...f.candidates[0], id: randomUUID() })));
  f.controls.truncated = true;
  const result = await f.creator.recoverChat(f.input);
  assert.equal(result.state, 'completed');
  assert.equal(result.thread.id, f.threadId);
  assert.deepEqual(f.controls.reads.map(([, id]) => id), [helper, f.threadId]);
  assert.equal(f.calls.length, 0);
});

test('conflicting official results remain uncertain even when the assistant names a valid target', async t => {
  const f = fixture(t);
  const result = officialResult(f);
  result.result.structuredContent = { status: 'created', threadId: randomUUID(), hostId: f.input.hostId };
  f.helperTurn.items.push(result);
  assert.equal((await f.creator.recoverChat(f.input)).state, 'unknown');
});

test('official creation identity is durable before target history is available', async t => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'petroglyphs-creation-proof-'));
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const f = fixture(t, 'text', {}, { evidenceDir });
  f.helperTurn.items.push(officialResult(f));
  const target = f.snapshots.get(`${f.input.hostId}:${f.threadId}`);
  f.snapshots.delete(`${f.input.hostId}:${f.threadId}`);
  await assert.rejects(f.creator.recoverChat(f.input), /Unavailable native snapshot/);
  f.snapshots.set(`${f.input.hostId}:${f.threadId}`, target);
  f.snapshots.delete(`local:${helper}`);
  assert.equal((await f.creator.recoverChat(f.input)).state, 'completed');
  assert.equal(f.calls.length, 0);
});

test('official delegated user text and turnToolOutput both verify without forwarding the wrapper as user content', async t => {
  for (const style of ['wrapped', 'toolOutput']) {
    const f = fixture(t, style);
    f.answer.text = `\`\`\`json\n${JSON.stringify(f.finalObject)}\n\`\`\`\n::created-thread{threadId="${f.threadId}"}`;
    const result = await f.creator.recoverChat(f.input);
    assert.equal(result.state, 'completed');
    assert.equal(typeof result.firstMessageId, style === 'wrapped' ? 'string' : 'undefined');
    if (style === 'wrapped') f.firstTurn.items[0].content[0].text = wrapped(f.input, randomUUID());
    else f.firstTurn.params.toolOutput.output = wrapped(f.input, randomUUID());
    assert.equal((await f.creator.recoverChat(f.input)).state, 'unknown');
    assert.equal(f.calls.length, 0);
  }
});

test('assistant claims cannot select another host, old chat, changed first prompt, duplicate candidate, or mismatched directive', async t => {
  for (const variation of ['wrong-host', 'old-chat', 'other-project', 'wrong-prompt', 'duplicates', 'directive', 'multiple-tools', 'shared-turn', 'extra-prose']) {
    const f = fixture(t);
    if (variation === 'wrong-host') { f.finalObject.hostId = 'local'; f.answer.text = f.finalText(); }
    if (variation === 'old-chat') f.candidates[0].createdAt -= 10;
    if (variation === 'other-project') f.candidates.splice(0);
    if (variation === 'wrong-prompt') f.firstTurn.items[0].content[0].text = 'Different message';
    if (variation === 'duplicates') {
      const other = randomUUID(); f.candidates.push({ ...f.candidates[0], id: other });
      f.snapshots.set(`${f.input.hostId}:${other}`, state(other, [turn([user(f.input.prompt)])]));
    }
    if (variation === 'directive') f.answer.text = `${JSON.stringify(f.finalObject)}\n::created-thread{threadId="${randomUUID()}"}`;
    if (variation === 'multiple-tools') f.helperTurn.items.push(...[1, 2].map(() => ({ type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread' })));
    if (variation === 'shared-turn') f.helperTurn.items.push(user('A different concurrent request'));
    if (variation === 'extra-prose') f.answer.text = `Here is the result:\n${f.answer.text}`;
    const result = await f.creator.recoverChat(f.input);
    assert.notEqual(result.state, 'completed', variation); assert.equal(f.calls.length, 0);
  }
});

test('missing helper acknowledgement reconciles once, while definitely not-sent busy is safe to queue', async t => {
  const f = fixture(t);
  f.controls.startError = new CodexDesktopIpcError('Lost receipt', 503, 'unknown');
  assert.equal((await f.creator.createChat(f.input)).state, 'completed');
  assert.equal(f.calls.length, 1);
  await f.creator.recoverChat(f.input); assert.equal(f.calls.length, 1);
  const busy = fixture(t);
  busy.controls.startError = new CodexDesktopIpcError('Busy', 409, 'not-sent');
  await assert.rejects(busy.creator.createChat(busy.input), error => error instanceof ProjectCreationNotSentError && error.busy);
  assert.equal(busy.calls.length, 1);
});

test('unknown receipt, partial history and indexing lag never cause a second helper send', async t => {
  const f = fixture(t);
  f.helperTurn.status = 'inProgress';
  assert.equal((await f.creator.createChat(f.input)).state, 'unknown');
  f.helperTurn.status = 'completed';
  f.candidates.splice(0);
  assert.equal((await f.creator.recoverChat(f.input)).state, 'creating');
  assert.equal(f.calls.length, 1);
});

test('a uniquely matched live helper turn waits for its user envelope before final recovery validation', async t => {
  for (const partialUser of [false, true]) {
    const f = fixture(t, 'text', { selection: { model: 'fixture-model', reasoningEffort: 'high' } });
    const completedItems = f.helperTurn.items;
    f.helperTurn.status = 'inProgress';
    f.helperTurn.items = partialUser
      ? [{ ...completedItems[0], content: [{ type: 'text', text: 'PETROGLYPHS_CREATE_PROJECT_CHAT_V2\n' }] }]
      : [];
    assert.equal((await f.creator.recoverChat(f.input)).state, 'creating');
    f.helperTurn.status = 'completed';
    assert.equal((await f.creator.recoverChat(f.input)).state, 'unknown');
    f.helperTurn.items = completedItems;
    assert.equal((await f.creator.recoverChat(f.input)).state, 'completed');
    assert.equal(f.calls.length, 0);
  }
});

test('the supplied exec script forwards parsed immutable data without retyping or executing prompt content', async t => {
  const f = fixture(t, 'text', { prompt: 'Text containing `code`, ${danger}, "quotes", and \n中文.'.repeat(100) });
  const script = /```javascript\n([\s\S]*)\n```$/.exec(projectCreationEnvelope(f.input))[1];
  const request = { requestId: f.input.id, hostId: f.input.hostId, projectId: f.input.projectId,
    prompt: f.input.prompt, title: f.input.title };
  const calls = [];
  const tools = { async exec_command(args) { calls.push(args); return { exit_code: 0, output: JSON.stringify(request) }; },
    async mcp__codex_app__create_thread(args) { calls.push(args); return { threadId: f.threadId }; } };
  const run = new (Object.getPrototypeOf(async () => {}).constructor)('tools', 'text', script);
  await run(tools, () => {});
  assert.equal(calls.length, 2); assert.equal(calls[0].cmd, "cat -- '/private/service/requests/immutable.json'");
  assert.deepEqual(calls[1], { prompt: f.input.prompt, title: f.input.title,
    target: { type: 'project', projectId: f.input.projectId, environment: { type: 'local' } } });
  request.projectId = 'different';
  await assert.rejects(run(tools, () => {}), /identity mismatch/);
  assert.equal(calls.length, 3);
});

test('persisted V1 companion envelopes retain their exact identity and remain recoverable', async t => {
  const f = fixture(t, 'text', { id: '10000000-0000-4000-8000-000000000001',
    hostId: 'remote-control:env_legacy_fixture', projectId: 'legacy-project', prompt: 'Legacy unchanged prompt.',
    title: 'Legacy', createdAt: '2026-10-16T12:00:00.000Z',
    requestPath: '/private/service/requests/legacy.json' });
  const envelope = projectCreationEnvelope({ ...f.input, executorThreadId: '10000000-0000-4000-8000-000000000002' });
  // Recovery compares the full user envelope. Changing even explanatory text
  // would strand requests already written by the V1 bridge.
  assert.equal(createHash('sha256').update(envelope).digest('hex'), 'e03052e57d374ebfb4c48ff6cda605f7365f9ef313a3419a3a96baf70792a8a7');
  const selected = projectCreationEnvelope({ ...f.input, executorThreadId: '10000000-0000-4000-8000-000000000002',
    selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  assert.equal(createHash('sha256').update(selected).digest('hex'), '0793f6f1ca73984c7fa4d564a7bdfe6e785471df2c010e2ad0a0a8d8bddbd98a');
  assert.equal((await f.creator.recoverChat(f.input)).state, 'completed');
  assert.equal(f.calls.length, 0);
});

test('V2 forwards the immutable selection to official creation and rejects mismatched file settings', async t => {
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  const f = fixture(t, 'text', { selection });
  const envelope = projectCreationEnvelope(f.input);
  assert(envelope.startsWith('PETROGLYPHS_CREATE_PROJECT_CHAT_V2\n'));
  const script = /```javascript\n([\s\S]*)\n```$/.exec(envelope)[1];
  const request = { requestId: f.input.id, hostId: f.input.hostId, projectId: f.input.projectId,
    prompt: f.input.prompt, title: f.input.title, selection: { ...selection } };
  const creations = [];
  const tools = { async exec_command() { return { exit_code: 0, output: JSON.stringify(request) }; },
    async mcp__codex_app__create_thread(args) { creations.push(args); return { threadId: f.threadId }; } };
  const run = new (Object.getPrototypeOf(async () => {}).constructor)('tools', 'text', script);
  await run(tools, () => {});
  assert.deepEqual(creations, [{ prompt: f.input.prompt, title: f.input.title,
    target: { type: 'project', projectId: f.input.projectId, environment: { type: 'local' } },
    model: selection.model, thinking: selection.reasoningEffort }]);
  request.selection.reasoningEffort = 'low';
  await assert.rejects(run(tools, () => {}), /selection mismatch/i);
  assert.equal(creations.length, 1);
});

test('first-turn model evidence is independent of later chat settings and preserves native reroutes', async t => {
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  const f = fixture(t, 'toolOutput', { selection });
  f.firstTurn.params.model = selection.model;
  f.firstTurn.params.effort = selection.reasoningEffort;
  f.snapshots.get(`${f.input.hostId}:${f.threadId}`).latestThreadSettings = { model: 'later-model', reasoningEffort: 'low' };
  const evidence = { ...selection, reroutes: [] };
  assert.deepEqual((await f.creator.recoverChat(f.input)).modelEvidence, evidence);
  const reroute = { type: 'modelRerouted', fromModel: selection.model, toModel: 'substitute', reason: 'unavailable' };
  f.firstTurn.items.push(reroute);
  const result = await f.creator.recoverChat(f.input);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.modelEvidence.reroutes, [{ fromModel: selection.model, toModel: 'substitute', reason: 'unavailable' }]);
  delete f.firstTurn.params.model;
  assert.equal((await f.creator.recoverChat(f.input)).modelEvidence, undefined);
  assert.equal(f.calls.length, 0);
});

test('recorded creation arguments must match explicitly requested model and effort', async t => {
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  for (const change of [{ model: 'other' }, { thinking: 'low' }, { model: undefined }]) {
    const f = fixture(t, 'text', { selection });
    f.helperTurn.items.push({ type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread', arguments: {
      prompt: f.input.prompt, title: f.input.title,
      target: { type: 'project', projectId: f.input.projectId, environment: { type: 'local' } },
      model: selection.model, thinking: selection.reasoningEffort, ...change,
    } });
    assert.equal((await f.creator.recoverChat(f.input)).state, 'unknown');
    assert.equal(f.calls.length, 0);
  }
});

function approvalTimeoutFixture(t) {
  const f = fixture(t, 'text', { selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  f.answer.text = JSON.stringify({ requestId: f.input.id, hostId: f.input.hostId, projectId: f.input.projectId, status: 'unknown' });
  f.candidates.splice(0);
  const call = { id: `exec-${randomUUID()}`, type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread', status: 'failed',
    arguments: { prompt: f.input.prompt, title: f.input.title, target: { type: 'project', projectId: f.input.projectId,
      environment: { type: 'local' } }, model: f.input.selection.model, thinking: f.input.selection.reasoningEffort },
    result: null, durationMs: 0, error: { message: 'The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe based on the timeout alone. You may retry once, or ask the user for guidance or explicit approval.' } };
  const review = { id: `automatic-approval-review:${randomUUID()}`, type: 'automaticApprovalReview', targetItemId: call.id,
    turnId: f.helperTurn.turnId, action: { type: 'mcpToolCall', server: 'codex_app', toolName: 'create_thread' },
    status: 'timedOut', startedAtMs: now, completedAtMs: now + 90000 };
  f.helperTurn.items.push(call, review);
  return { ...f, call, review };
}

test('only exact native approval-timeout evidence with zero complete candidates proves execution did not start', async t => {
  const f = approvalTimeoutFixture(t);
  const result = await f.creator.recoverChat(f.input);
  assert.equal(result.state, 'failed_before_execution');
  assert.equal(result.reason, 'approval_review_timeout');
  assert.equal(result.proof.requestId, f.input.id);
  assert.equal(result.proof.attemptId, f.input.id);
  assert.equal(result.proof.helperTurnId, f.helperTurn.turnId);
  assert.equal(result.proof.toolCallId, f.call.id);
  assert.equal(result.proof.approvalReviewId, f.review.id);
  assert.equal(f.calls.length, 0);

  for (const variation of ['missing-review', 'wrong-tool', 'wrong-turn', 'wrong-action', 'approved', 'duration', 'result',
    'missing-arguments', 'changed-selection', 'extra-override', 'generic-timeout', 'candidates', 'truncated', 'duplicate-call', 'duplicate-review']) {
    const bad = approvalTimeoutFixture(t);
    if (variation === 'missing-review') bad.helperTurn.items.pop();
    if (variation === 'wrong-tool') bad.review.targetItemId = `exec-${randomUUID()}`;
    if (variation === 'wrong-turn') bad.review.turnId = randomUUID();
    if (variation === 'wrong-action') bad.review.action.toolName = 'other';
    if (variation === 'approved') bad.review.status = 'approved';
    if (variation === 'duration') bad.call.durationMs = 1;
    if (variation === 'result') bad.call.result = { content: [] };
    if (variation === 'missing-arguments') delete bad.call.arguments;
    if (variation === 'changed-selection') bad.call.arguments.thinking = 'low';
    if (variation === 'extra-override') bad.call.arguments.cwd = '/other';
    if (variation === 'generic-timeout') bad.call.error.message = 'Request timed out.';
    if (variation === 'candidates') bad.candidates.push({ id: bad.threadId, title: 'Possible chat', cwd: '/saved/remote',
      updatedAt: now / 1000, createdAt: Math.floor(now / 1000) });
    if (variation === 'truncated') bad.controls.truncated = true;
    if (variation === 'duplicate-call') bad.helperTurn.items.push({ ...bad.call, id: `exec-${randomUUID()}` });
    if (variation === 'duplicate-review') bad.helperTurn.items.push({ ...bad.review, id: `automatic-approval-review:${randomUUID()}` });
    assert.equal((await bad.creator.recoverChat(bad.input)).state, 'unknown', variation);
    assert.equal(bad.calls.length, 0);
  }
});

test('V3 retry uses one new native attempt with unchanged request data and rechecks its prior execution proof', async t => {
  const f = approvalTimeoutFixture(t);
  const previous = await f.creator.recoverChat(f.input);
  assert.equal(previous.state, 'failed_before_execution');
  const retry = { attemptId: randomUUID(), attemptNumber: 2, previousFailure: previous.proof };
  const input = { ...f.input, retry };
  const envelope = projectCreationEnvelope(input);
  assert(envelope.startsWith('PETROGLYPHS_CREATE_PROJECT_CHAT_V3\n'));
  assert(envelope.includes(retry.attemptId));
  assert(envelope.includes(f.review.id));
  const result = await f.creator.createChat(input);
  assert.equal(result.state, 'unknown'); // This fixture deliberately has no acknowledgement of the second native attempt.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].clientUserMessageId, retry.attemptId);
  assert.equal(f.calls[0].text, envelope);
  await f.creator.recoverChat(input); assert.equal(f.calls.length, 1);

  const blocked = approvalTimeoutFixture(t);
  const proof = await blocked.creator.recoverChat(blocked.input);
  blocked.review.status = 'approved';
  assert.equal((await blocked.creator.createChat({ ...blocked.input,
    retry: { attemptId: randomUUID(), attemptNumber: 2, previousFailure: proof.proof } })).state, 'unknown');
  assert.equal(blocked.calls.length, 0);
});

test('V3 preflight preserves an already-created original chat and keeps changed evidence uncertain', async t => {
  for (const change of ['completed', 'creating', 'proof-identity']) {
    const f = approvalTimeoutFixture(t);
    const failure = await f.creator.recoverChat(f.input);
    const input = { ...f.input, retry: { attemptId: randomUUID(), attemptNumber: 2, previousFailure: failure.proof } };
    if (change === 'completed') {
      f.call.status = 'completed'; f.call.result = { content: [{ type: 'text', text: JSON.stringify({ threadId: f.threadId, hostId: f.input.hostId }) }] };
      f.call.error = null; f.call.durationMs = 10; f.review.status = 'approved';
      f.answer.text = f.finalText();
      f.candidates.push({ id: f.threadId, title: 'Original created chat', cwd: '/saved/remote', updatedAt: now / 1000,
        createdAt: Math.floor(now / 1000) });
    } else if (change === 'creating') f.helperTurn.status = 'inProgress';
    else f.review.id = `automatic-approval-review:${randomUUID()}`;
    const observed = await f.creator.createChat(input);
    assert.equal(observed.state, change === 'completed' ? 'completed' : 'unknown', change);
    if (change === 'completed') assert.equal(observed.thread.id, f.threadId);
    assert.equal(f.calls.length, 0);
  }
});

test('an unsent V3 attempt recovers a late original completion through read-only fallback', async t => {
  const f = approvalTimeoutFixture(t);
  const failure = await f.creator.recoverChat(f.input);
  const input = { ...f.input, retry: { attemptId: randomUUID(), attemptNumber: 2, previousFailure: failure.proof } };
  f.review.status = 'approved';
  assert.equal((await f.creator.createChat(input)).state, 'unknown');
  assert.equal(f.calls.length, 0);
  f.call.status = 'completed'; f.call.result = { content: [{ type: 'text', text: JSON.stringify({ threadId: f.threadId, hostId: f.input.hostId }) }] };
  f.call.error = null; f.call.durationMs = 10;
  f.answer.text = f.finalText();
  f.candidates.push({ id: f.threadId, title: 'Late original chat', cwd: '/saved/remote', updatedAt: now / 1000,
    createdAt: Math.floor(now / 1000) });
  const recovered = await f.creator.recoverChat(input);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.thread.id, f.threadId);
  assert.equal(recovered.firstTurnId, f.firstTurn.turnId);
  assert.equal(f.calls.length, 0);
});

test('a completed V3 attempt recovers the same request only with its own exact attempt ID', async t => {
  const f = approvalTimeoutFixture(t);
  const failure = await f.creator.recoverChat(f.input);
  const retry = { attemptId: randomUUID(), attemptNumber: 2, previousFailure: failure.proof };
  const input = { ...f.input, retry };
  const final = { requestId: input.id, attemptId: retry.attemptId, hostId: input.hostId,
    projectId: input.projectId, status: 'created', threadId: f.threadId };
  const answer = { type: 'agentMessage', phase: 'final_answer',
    text: `${JSON.stringify(final)}\n::created-thread{threadId="${f.threadId}"}` };
  const secondTurn = turn([user(projectCreationEnvelope(input), retry.attemptId), answer],
    { params: { clientUserMessageId: retry.attemptId } });
  f.snapshots.set(`local:${helper}`, state(helper, [f.helperTurn, secondTurn]));
  f.candidates.push({ id: f.threadId, title: 'New chat', cwd: '/saved/remote', updatedAt: now / 1000, createdAt: Math.floor(now / 1000) });
  f.firstTurn.params = { model: input.selection.model, effort: input.selection.reasoningEffort };
  const result = await f.creator.recoverChat(input);
  assert.equal(result.state, 'completed'); assert.equal(result.thread.id, f.threadId);
  assert.deepEqual(result.modelEvidence, { ...input.selection, reroutes: [] });
  delete final.attemptId;
  answer.text = `${JSON.stringify(final)}\n::created-thread{threadId="${f.threadId}"}`;
  assert.equal((await f.creator.recoverChat(input)).state, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('a disconnected V3 proof preflight remains definitely unsent and can wait on the same attempt', async t => {
  const f = approvalTimeoutFixture(t);
  const failure = await f.creator.recoverChat(f.input);
  const input = { ...f.input, retry: { attemptId: randomUUID(), attemptNumber: 2, previousFailure: failure.proof } };
  f.controls.readError = new Error('Native metadata connection closed before any write.');
  await assert.rejects(f.creator.createChat(input), error => error instanceof ProjectCreationNotSentError && error.busy);
  assert.equal(f.calls.length, 0);
});
