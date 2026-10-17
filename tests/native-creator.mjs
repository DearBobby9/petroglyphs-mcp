import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexNativeCreator, resolveNativeProject, readNativeProjectMembership } from '../src/codex-native-creator.ts';
import { CodexNativeAppServer, NativeAppServerError } from '../src/codex-native-app-server.ts';
import { CodexDesktopIpcError } from '../src/codex-desktop-ipc.ts';
import { ProjectCreationNotSentError } from '../src/codex-companion-creator.ts';

async function fixture(t, selection = { model: 'selected-model', reasoningEffort: 'max' }) {
  const root = await mkdtemp(join(tmpdir(), 'petroglyphs-native-'));
  const input = { id: randomUUID(), hostId: 'local', projectId: 'legacy-project', prompt: 'Exact first prompt <&>.',
    title: 'Native title', createdAt: new Date().toISOString(), requestPath: join(root, 'request.json'), ...(selection ? { selection } : {}) };
  const identity = { projectId: input.projectId, rootPaths: ['/project/one', '/project/two'], candidateIds: ['legacy-project', 'native-project'] };
  const threadId = randomUUID(), turnId = randomUUID();
  const controls = { nativeProjectId: 'native-project', nativeModel: selection?.model ?? 'native-default',
    nativeEffort: selection?.reasoningEffort ?? null, publishOnSend: true };
  const events = [], requests = [], sends = [];
  let turns = [];
  const receiptPath = join(root, `${input.id}.json`);
  const receipt = () => JSON.parse(readFileSync(receiptPath, 'utf8'));
  const publish = () => { turns = [{ turnId, status: 'completed', params: { clientUserMessageId: input.id,
    collaborationMode: { mode: 'default', settings: { model: controls.nativeModel, reasoning_effort: controls.nativeEffort, developer_instructions: null } } },
    items: [{ id: randomUUID(), type: 'userMessage', clientId: input.id, content: [{ type: 'text', text: input.prompt },
      ...(input.attachments ?? []).map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.dataBase64}` }))] },
      { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Done' }] }]; };
  const options = { dataDir: root, codexPath: '/fixture/codex', adoptionMs: 0,
    catalog: { nativeLocalIdentity: async () => identity },
    connectNative: async () => ({ close: async () => { events.push('native-close'); },
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === 'project/list') return { data: [{ id: 'native-project', roots: identity.rootPaths.map(path => ({ path })) }], nextCursor: null };
        if (method === 'project/read') return { project: { id: 'native-project', roots: identity.rootPaths.map(path => ({ path })) } };
        if (method === 'thread/start') {
          assert.equal(receipt().stage, 'creation_requested'); events.push('thread-start');
          if (controls.nativeError) throw controls.nativeError;
          return { thread: { id: threadId, name: null, cwd: identity.rootPaths[0], projectId: controls.nativeProjectId, updatedAt: 100 },
            cwd: identity.rootPaths[0], runtimeWorkspaceRoots: identity.rootPaths,
            model: controls.nativeModel, reasoningEffort: controls.nativeEffort };
        }
        if (method === 'thread/name/set') { assert.equal(receipt().thread.id, threadId); return {}; }
        assert.fail(`Unexpected native method ${method}`);
      } }),
    openThread: async id => {
      assert.equal(id, threadId); assert.equal(receipt().thread.id, threadId);
      assert.equal(events.at(-1), 'native-close'); events.push('open');
      if (controls.openError) throw controls.openError;
    },
    connectDesktop: async () => ({ close() {}, readSnapshot: async (hostId, id) => {
      if (controls.readError) throw controls.readError;
      return { hostId, threadId: id, conversationState: { id, hostId, turns,
        latestThreadSettings: { collaborationMode: { mode: 'default', settings: { model: 'desktop-global', reasoning_effort: 'low', developer_instructions: 'Keep' } } } } };
    }, startMessageTurn: async value => {
      assert.equal(receipt().stage, 'first_message_requested'); sends.push(value); events.push('send');
      if (controls.publishOnSend) publish();
      if (controls.sendError) throw controls.sendError;
      return { turnId, clientUserMessageId: value.clientUserMessageId };
    } }),
  };
  const creators = [];
  const open = () => { const creator = new CodexNativeCreator(options); creators.push(creator); return creator; };
  t.after(async () => { creators.forEach(creator => creator.close()); await rm(root, { recursive: true, force: true }); });
  return { input, identity, threadId, turnId, controls, requests, sends, events, receipt, options, open, creator: open(), publish };
}

test('native creation saves the real ID, closes stdio, opens once, then sends the exact model-bound first message', async t => {
  const f = await fixture(t);
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'completed'); assert.equal(result.thread.id, f.threadId); assert.equal(result.firstTurnId, f.turnId);
  assert.deepEqual(result.modelEvidence, { ...f.input.selection, reroutes: [] });
  const params = f.requests.find(request => request.method === 'thread/start').params;
  assert.equal(params.projectId, 'native-project'); assert.deepEqual(params.runtimeWorkspaceRoots, f.identity.rootPaths);
  assert.equal(params.model, f.input.selection.model); assert.deepEqual(params.config, { model_reasoning_effort: 'max' });
  for (const name of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions', 'developerInstructions', 'dynamicTools']) assert.equal(name in params, false);
  assert.deepEqual(f.events, ['thread-start', 'native-close', 'open', 'send']);
  assert.equal(f.sends[0].clientUserMessageId, f.input.id); assert.equal(f.sends[0].text, f.input.prompt);
  assert.deepEqual(f.sends[0].selection, f.input.selection); assert.deepEqual(f.sends[0].attachments, []);
  assert.equal(f.receipt().thread.id, f.threadId);
  await Promise.all([f.creator.createChat(f.input), f.creator.recoverChat(f.input)]);
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.events.filter(event => event === 'open').length, 1);
});

test('native first images stay fixed across an uncertain acknowledgement and recover without another send', async t => {
  const f = await fixture(t);
  f.input.attachments = [{ id: randomUUID(), name: 'First.png', mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }];
  f.controls.publishOnSend = false;
  f.controls.sendError = new CodexDesktopIpcError('Lost acknowledgement', 503, 'unknown');
  assert.equal((await f.creator.createChat(f.input)).firstMessageState, 'unknown');
  assert.deepEqual(f.sends[0].attachments, f.input.attachments.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })));
  f.creator.close();
  const restored = f.open();
  await assert.rejects(restored.recoverChat({ ...f.input, attachments: [] }), /identity mismatch/);
  f.publish();
  assert.equal((await restored.recoverChat(f.input)).state, 'completed');
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
});

test('unset native effort stays null and native defaults survive Desktop changing its loaded defaults', async t => {
  const f = await fixture(t, null);
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'completed');
  assert.deepEqual(f.sends[0].initialModelSettings, { model: 'native-default', reasoningEffort: null });
  assert.equal(f.sends[0].selection, undefined);
  assert.deepEqual(f.receipt().effectiveSettings, { model: 'native-default', reasoningEffort: null });
  assert.equal('model' in f.requests.find(request => request.method === 'thread/start').params, false);
});

test('a lost thread/start response survives restart and duplicate create without another mutation', async t => {
  const f = await fixture(t); f.controls.nativeError = new NativeAppServerError('unknown');
  assert.equal((await f.creator.createChat(f.input)).state, 'unknown');
  assert.equal(f.receipt().stage, 'creation_requested'); f.creator.close();
  const restored = f.open();
  assert.equal((await restored.createChat(f.input)).state, 'unknown');
  assert.equal((await restored.recoverChat(f.input)).state, 'unknown');
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(f.events.includes('open'), false); assert.equal(f.sends.length, 0);
});

test('failed Desktop adoption preserves the created thread and read-only recovery never opens or sends', async t => {
  const f = await fixture(t); f.controls.readError = new CodexDesktopIpcError('No owner', 503, 'not-sent', 'owner_unavailable');
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'created'); assert.equal(result.thread.id, f.threadId); assert.equal(result.firstMessageState, 'not_sent');
  f.creator.close(); delete f.controls.readError;
  const restored = f.open();
  assert.equal((await restored.recoverChat(f.input)).firstMessageState, 'not_sent');
  assert.equal((await restored.createChat(f.input)).firstMessageState, 'not_sent');
  assert.equal(f.sends.length, 0); assert.equal(f.events.filter(event => event === 'open').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
});

test('a lost first-message acknowledgement recovers only its exact client message after restart without resending', async t => {
  const f = await fixture(t); f.controls.publishOnSend = false;
  f.controls.sendError = new CodexDesktopIpcError('Lost acknowledgement', 503, 'unknown');
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'created'); assert.equal(result.firstMessageState, 'unknown'); assert.equal(result.thread.id, f.threadId);
  f.creator.close(); const restored = f.open();
  assert.equal((await restored.recoverChat(f.input)).firstMessageState, 'unknown');
  f.publish(); const recovered = await restored.recoverChat(f.input);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.firstTurnId, f.turnId);
  assert.equal(f.sends.length, 1); assert.equal(f.events.filter(event => event === 'open').length, 1);
});

test('a created thread with mismatched native project metadata is retained without opening or sending', async t => {
  const f = await fixture(t); f.controls.nativeProjectId = 'different-project';
  const result = await f.creator.createChat(f.input);
  assert.equal(result.state, 'created'); assert.equal(result.projectVerified, false); assert.equal(result.thread.id, f.threadId);
  assert.equal(f.receipt().thread.id, f.threadId); assert.equal(f.sends.length, 0); assert.equal(f.events.includes('open'), false);
});

test('native project resolution rejects root drift, ambiguous aliases and incomplete paginated membership', async () => {
  const identity = { projectId: 'legacy', candidateIds: ['legacy', 'native'], rootPaths: ['/one', '/two'] };
  const project = { id: 'native', roots: [{ path: '/one' }, { path: '/two' }] };
  const requests = [];
  const client = { close: async () => {}, request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'project/list') return { data: [project], nextCursor: null };
    if (method === 'project/read') return { project };
    return { data: [{ id: randomUUID(), projectId: 'native' }], nextCursor: 'repeated' };
  } };
  assert.equal(await resolveNativeProject(client, identity), 'native');
  await assert.rejects(resolveNativeProject(client, { ...identity, rootPaths: ['/one'] }), ProjectCreationNotSentError);
  await assert.rejects(resolveNativeProject({ ...client, request: async () => ({ data: [project, { ...project, id: 'legacy' }], nextCursor: null }) }, identity), ProjectCreationNotSentError);
  await assert.rejects(readNativeProjectMembership(client, identity), /cursor/);
  assert(requests.filter(request => request.method === 'thread/list').every(request => request.params.projectId === 'native' && request.params.archived === false));
});

test('owned stdio transport distinguishes read failure from an unacknowledged creation and hides native diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'petroglyphs-native-stdio-'));
  const path = join(root, 'codex');
  await writeFile(path, `#!${process.execPath}\nimport readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
  else if (request.method !== 'initialized') { process.stderr.write('PRIVATE_NATIVE_DIAGNOSTIC'); process.exit(0); }
});\n`, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const method of ['project/read', 'thread/start']) {
    const client = await CodexNativeAppServer.connect({ codexPath: path });
    await assert.rejects(client.request(method, {}), error => error instanceof NativeAppServerError
      && error.outcome === (method === 'thread/start' ? 'unknown' : 'not_sent') && !error.message.includes('PRIVATE'));
    await client.close();
  }
});
