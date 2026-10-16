import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

function fixture(t, style = 'text', overrides = {}) {
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
    } } });
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
