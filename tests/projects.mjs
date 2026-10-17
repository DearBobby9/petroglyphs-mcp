import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { CodexProjectsCatalog } from '../src/codex-projects-catalog.ts';
import { CodexProjectChats } from '../src/codex-project-chats.ts';
import { installProjectRoutes } from '../src/codex-project-routes.ts';
import { ConversationError } from '../src/codex-message-input.ts';
import { ProjectCreationNotSentError } from '../src/codex-companion-creator.ts';

const remote = 'remote-control:env_project_test';
const localProject = 'project-local';
const remoteProject = 'project-remote';
const localPath = '/known/saved/project';
const remotePath = '/remote/saved/project';
const tick = () => new Promise(resolve => setImmediate(resolve));
const message = (extra = {}) => ({ id: randomUUID(), hostId: 'local', projectId: localProject,
  prompt: 'User supplied first message.', title: 'iPad test', ...extra });
const helperId = randomUUID();
const native = (threadId, hostId = 'local') => ({ state: 'completed', hostId, firstTurnId: randomUUID(),
  thread: { id: threadId, title: 'Created chat', cwd: hostId === 'local' ? localPath : remotePath, updatedAt: Date.now() / 1000 } });

async function catalogFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'petroglyphs-projects-'));
  const statePath = join(root, 'state.json');
  const databasePath = join(root, 'catalog.db');
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const state = {
    'local-projects': { [localProject]: { id: localProject, name: 'Local saved', rootPaths: [localPath] },
      other: { id: 'other', name: 'Other project', rootPaths: ['/other'] } },
    'remote-projects': [{ id: remoteProject, hostId: remote, label: 'Remote saved', remotePath }],
    'thread-project-assignments': {
      [ids[0]]: { projectKind: 'local', projectId: localProject },
      [ids[1]]: { projectKind: 'local', projectId: localProject },
      [ids[2]]: { projectKind: 'remote', projectId: remoteProject, hostId: remote },
      [ids[3]]: { projectKind: 'local', projectId: 'other' },
      [ids[5]]: { projectKind: 'local', projectId: localProject },
      [ids[6]]: { projectKind: 'local', projectId: localProject },
    },
    'thread-project-membership-host-ids': { [ids[5]]: remote },
    'projectless-thread-ids': [ids[6]],
    'app-server-project-id-by-legacy-project-id-by-host': { 'local:/user/.codex': { [localProject]: 'server-local-id' } },
    privateAccountData: 'PRIVATE_ENROLLMENT',
  };
  await writeFile(statePath, JSON.stringify(state));
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE local_thread_catalog_sync_state(host_id TEXT PRIMARY KEY,initial_build_complete INTEGER);
    CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,display_title TEXT,cwd TEXT,source_updated_at REAL,
      project_id TEXT,source_kind TEXT,thread_source TEXT,missing_candidate INTEGER,source_created_at REAL);`);
  db.prepare('INSERT INTO local_thread_catalog_sync_state VALUES(?,1)').run('local');
  db.prepare('INSERT INTO local_thread_catalog_sync_state VALUES(?,1)').run(remote);
  const insert = (hostId, id, title, cwd, projectId = null, missing = 0, source = 'appServer') => db.prepare(
    'INSERT INTO local_thread_catalog VALUES(?,?,?,?,?,?,?,?,?,?)').run(hostId, id, title, cwd, 1000 + ids.indexOf(id), projectId, source, null, missing, 1000 + ids.indexOf(id));
  insert('local', ids[0], 'Local one', '/unrelated/cwd');
  insert('local', ids[1], 'Local two', '/another/cwd');
  insert(remote, ids[2], 'Remote one', remotePath);
  insert('local', ids[3], 'Explicit other assignment', localPath, 'server-local-id');
  insert('local', ids[4], 'Same cwd without membership', localPath);
  insert('local', ids[5], 'Wrong host membership', localPath, 'server-local-id');
  insert('local', ids[6], 'Explicit projectless', localPath, 'server-local-id');
  insert('local', ids[7], 'Server alias membership', '/server/actual/cwd', 'server-local-id');
  insert('local', ids[8], 'Archived', localPath, 'server-local-id', 1);
  db.close();
  const catalog = new CodexProjectsCatalog({ statePath, databasePath, pageSize: 2, requireHost: async hostId => {
    if (!['local', remote].includes(hostId)) throw new ConversationError('Unavailable host.', 404, 'connection_unavailable');
  } });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ids, state, statePath, catalog };
}

test('saved projects are host-bound and thread filtering uses explicit membership or server IDs, never matching cwd', async t => {
  const f = await catalogFixture(t);
  assert.deepEqual((await f.catalog.list(remote)).map(project => project.id), [remoteProject]);
  await assert.rejects(f.catalog.require('local', remoteProject), error => error.status === 404);
  const page = await f.catalog.listThreads('local', localProject);
  const older = await f.catalog.listThreads('local', localProject, { cursor: page.nextCursor });
  assert.deepEqual([...page.threads, ...older.threads].map(thread => thread.id), [f.ids[7], f.ids[1], f.ids[0]]);
  assert.equal(older.nextCursor, null);
  assert(!JSON.stringify(await f.catalog.list('local')).includes('PRIVATE_'));
  await assert.rejects(f.catalog.listThreads(remote, remoteProject, { cursor: page.nextCursor }), error => error.status === 400);
  await assert.rejects(f.catalog.listThreads('local', 'other', { cursor: page.nextCursor }), error => error.status === 400);
  await assert.rejects(f.catalog.listThreads('local', localProject, { cursor: page.nextCursor, search: 'Local' }), error => error.status === 400);
  assert.deepEqual((await f.catalog.listThreads(remote, remoteProject)).threads.map(thread => thread.id), [f.ids[2]]);
  const candidates = await f.catalog.creationCandidates('local', localProject, new Date(1001 * 1000).toISOString());
  assert.deepEqual(candidates.threads.map(thread => thread.id), [f.ids[1], f.ids[7]]);
  assert.equal(candidates.truncated, false);
});

test('all-chat metadata uses official membership and agrees with project navigation', async t => {
  const f = await catalogFixture(t);
  const source = { threads: f.ids.slice(0, 8).map(id => ({ id, title: 'Local saved', cwd: localPath, updatedAt: 123 })), nextCursor: 'unchanged' };
  const page = await f.catalog.describeThreads('local', source);
  assert.equal(page.nextCursor, source.nextCursor);
  assert.deepEqual(page.threads.filter(thread => thread.projectId === localProject).map(thread => thread.id), [f.ids[0], f.ids[1], f.ids[7]]);
  assert.equal(page.threads.find(thread => thread.id === f.ids[3]).projectId, 'other');
  assert(page.threads.filter(thread => [f.ids[2], f.ids[4], f.ids[5], f.ids[6]].includes(thread.id)).every(thread => thread.projectName === undefined));
  const projectPage = await f.catalog.listThreads('local', localProject);
  assert(projectPage.threads.every(thread => thread.projectName === 'Local saved' && thread.projectId === localProject));
});

test('native identity retains every root and accepts aliases only from the current local profile', async t => {
  const f = await catalogFixture(t);
  f.state['local-projects'][localProject].rootPaths.push('/second/workspace');
  f.state['app-server-project-id-by-legacy-project-id-by-host']['local:/other/profile'] = { [localProject]: 'other-native-id' };
  await writeFile(f.statePath, JSON.stringify(f.state));
  const catalog = new CodexProjectsCatalog({ statePath: f.statePath, env: { CODEX_HOME: '/user/.codex' }, requireHost: async () => {} });
  assert.deepEqual(await catalog.nativeLocalIdentity(localProject), { projectId: localProject,
    rootPaths: [localPath, '/second/workspace'], candidateIds: [localProject, 'server-local-id'] });
  await assert.rejects(catalog.nativeLocalIdentity(remoteProject));
  f.state['local-projects'][localProject].rootPaths.push('relative/workspace');
  await writeFile(f.statePath, JSON.stringify(f.state));
  await assert.rejects(catalog.nativeLocalIdentity(localProject), error => error.code === 'project_identity_unavailable');
});

test('native membership fills null Desktop project IDs without overriding visibility or explicit assignments', async t => {
  const f = await catalogFixture(t);
  let members = [f.ids[4], f.ids[3], f.ids[5], f.ids[6], f.ids[8]];
  let unavailable = false, reads = 0;
  const catalog = new CodexProjectsCatalog({ statePath: f.statePath, databasePath: join(f.root, 'catalog.db'), pageSize: 2,
    env: { CODEX_HOME: '/user/.codex' }, requireHost: async () => {}, nativeProjectThreads: async identity => {
      reads++; assert(identity.candidateIds.includes('server-local-id'));
      if (unavailable) throw new Error('Native catalogue is unavailable');
      return { projectId: 'server-local-id', threadIds: members };
    } });
  const first = await catalog.listThreads('local', localProject);
  const second = await catalog.listThreads('local', localProject, { cursor: first.nextCursor });
  assert.deepEqual([...first.threads, ...second.threads].map(thread => thread.id), [f.ids[7], f.ids[4], f.ids[1], f.ids[0]]);
  members = [];
  const current = await catalog.creationCandidates('local', localProject, new Date(0).toISOString());
  assert(!current.threads.some(thread => thread.id === f.ids[4]), 'native membership must be refreshed after removal');
  const before = reads; await catalog.listThreads(remote, remoteProject); assert.equal(reads, before);
  unavailable = true;
  await assert.rejects(catalog.listThreads('local', localProject), error => error.code === 'project_chats_unavailable');
});

async function creationFixture(t, custom = {}) {
  const f = await catalogFixture(t);
  const calls = [];
  const waiters = [];
  const controls = { calls, resolve: null, reject: null, readyFailure: false,
    waitForCalls: count => calls.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve })) };
  const tools = { executorThreadId: helperId, close() {}, recoverChat: async input => controls.recover
    ? controls.recover(input) : controls.recovered ?? { state: 'unknown' },
    ready: async () => { if (controls.readyFailure) throw new Error('PRIVATE_SERVICE_ERROR'); },
    createChat: async input => { calls.push(input); return new Promise((resolve, reject) => {
      controls.resolve = resolve; controls.reject = reject;
      waiters.filter(waiter => calls.length >= waiter.count).forEach(waiter => waiter.resolve());
    }); } };
  const options = { dataDir: join(f.root, 'receipts'), catalog: f.catalog, executor: tools, ...custom };
  const services = [];
  const open = () => { const service = new CodexProjectChats(options); services.push(service); return service; };
  const service = open();
  t.after(() => services.forEach(service => service.close()));
  return { ...f, ...controls, controls, calls, service, open, options };
}

test('creation is idempotent across concurrent requests, fixed to its saved project, and rejects injected cwd or tools', async t => {
  const f = await creationFixture(t);
  const input = message();
  const [first, retry] = await Promise.all([f.service.accept(input), f.service.accept(input)]);
  assert.equal([first, retry].filter(result => !result.duplicate).length, 1);
  await f.controls.waitForCalls(1);
  assert.equal(f.calls.length, 1);
  const requestPath = join(f.root, 'receipts', 'requests', `${input.id}.json`);
  assert.deepEqual(f.calls[0], { ...input, createdAt: first.receipt.createdAt, executorThreadId: helperId, requestPath });
  assert.equal((await stat(requestPath)).mode & 0o777, 0o400);
  assert.deepEqual(JSON.parse(await readFile(requestPath, 'utf8')), { requestId: input.id, hostId: input.hostId,
    projectId: input.projectId, prompt: input.prompt, title: input.title });
  for (const invalid of [{ ...message(), cwd: '/arbitrary' }, { ...message(), tool: 'run_shell' }, message({ prompt: ' \n ' }),
    message({ prompt: 'x'.repeat(20001) }), message({ title: 'x'.repeat(121) }), message({ hostId: remote })]) {
    await assert.rejects(f.service.accept(invalid));
  }
  await assert.rejects(f.service.accept({ ...input, prompt: 'Different' }), error => error.status === 409);
  await assert.rejects(f.service.accept({ ...input, hostId: remote, projectId: remoteProject }), error => error.status === 409);
  const threadId = randomUUID(); f.controls.resolve(native(threadId)); await tick();
  const receipt = f.service.get('local', localProject, input.id);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.thread.id, threadId);
  assert.equal(receipt.thread.cwd, localPath); assert(!JSON.stringify(receipt).includes(input.prompt));
  assert.throws(() => f.service.get(remote, remoteProject, input.id), error => error.status === 404);
  assert.equal((await f.open().accept(input)).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('new local creation uses a durable native executor without a helper and preserves a created thread when its first message is unsent', async t => {
  const nativeCalls = [], recovered = [];
  const thread = native(randomUUID()).thread;
  const observation = { state: 'created', hostId: 'local', thread, projectVerified: true, firstMessageState: 'not_sent' };
  const localExecutor = { ready: async () => {}, close() {}, createChat: async input => { nativeCalls.push(input); return observation; },
    recoverChat: async input => { recovered.push(input); return observation; } };
  const f = await creationFixture(t, { localExecutor, requireSelection: async () => {} });
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'max' } });
  f.controls.readyFailure = true;
  assert((await f.service.projects('local')).projects.every(project => project.canCreate));
  assert((await f.service.projects(remote)).projects.every(project => !project.canCreate));
  await Promise.all([f.service.accept(input), f.service.accept(input)]);
  while (f.service.get('local', localProject, input.id).state === 'pending') await tick();
  await tick();
  const receipt = f.service.get('local', localProject, input.id);
  assert.equal(receipt.state, 'unknown'); assert.equal(receipt.creationMethod, 'native');
  assert.equal(receipt.firstMessageState, 'not_sent'); assert.equal(receipt.thread.id, thread.id);
  assert.equal(receipt.canRetry, false); assert.match(receipt.notice, /first message was not sent/);
  assert.equal(f.service.hasThread('local', thread.id), true);
  assert.equal(nativeCalls.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(nativeCalls[0].executorThreadId, undefined); assert.deepEqual(nativeCalls[0].selection, input.selection);
  const stored = JSON.parse(await readFile(join(f.root, 'receipts', `${input.id}.json`), 'utf8'));
  assert.equal(stored.executorKind, 'native'); assert.equal(stored.executorThreadId, undefined);
  f.service.close();
  const restored = f.open();
  assert.equal((await restored.accept(input)).duplicate, true);
  assert.equal((await restored.status('local', localProject, input.id)).thread.id, thread.id);
  assert.equal(recovered.length, 1); assert.equal(nativeCalls.length, 1); assert.equal(f.calls.length, 0);
  await assert.rejects(restored.retry(input.id, { hostId: 'local', projectId: localProject, attemptId: input.id }),
    error => error.code === 'creation_retry_unavailable');
  f.controls.readyFailure = false;
  const remoteInput = message({ hostId: remote, projectId: remoteProject });
  await restored.accept(remoteInput); await f.controls.waitForCalls(1);
  assert.equal(f.calls[0].executorThreadId, helperId);
  assert.equal(restored.get(remote, remoteProject, remoteInput.id).creationMethod, 'companion');
  f.controls.resolve(native(randomUUID(), remote)); await tick();
});

test('native creation retains first images and hands the same request into conversation recovery', async t => {
  const captured = [], adopted = [], checks = [];
  const result = native(randomUUID());
  const localExecutor = { ready: async () => {}, close() {}, createChat: async input => { captured.push(input); return result; },
    recoverChat: async () => result };
  const f = await creationFixture(t, { localExecutor, requireSelection: async (...args) => checks.push(args),
    onFirstMessage: (...args) => adopted.push(args) });
  const attachments = [{ id: randomUUID(), name: 'Plan.png', mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }];
  const input = message({ prompt: '', attachments, selection: { model: 'fixture-model', reasoningEffort: 'max' } });
  await f.service.accept(input);
  while (f.service.get('local', localProject, input.id).state !== 'completed') await tick();
  assert.deepEqual(captured[0].attachments, attachments);
  assert(checks.every(([, , hasImages]) => hasImages));
  assert.equal(adopted[0][0].id, input.id);
  assert.deepEqual(adopted[0][0].attachments, attachments);
  assert.equal(adopted[0][1].turnId, result.firstTurnId);
  const receipt = f.service.get('local', localProject, input.id);
  assert.equal(receipt.firstMessageRequestId, input.id);
  assert.equal(receipt.firstTurnId, result.firstTurnId);
  assert.equal(receipt.firstMessageState, 'sent');
  assert((await f.service.projects('local')).projects.every(project => project.supportsFirstMessageAttachments));
  assert((await f.service.projects(remote)).projects.every(project => !project.supportsFirstMessageAttachments));
  await assert.rejects(f.service.accept({ ...input, attachments: [{ ...attachments[0], name: 'Changed.png' }] }), error => error.code === 'id_conflict');
  await assert.rejects(f.service.accept(message({ hostId: remote, projectId: remoteProject, attachments })),
    error => error.code === 'first_message_images_unsupported');
  f.service.close();
  const restored = f.open(); restored.restoreFirstMessages();
  assert.equal((await restored.accept(input)).duplicate, true);
  assert.equal(captured.length, 1);
  assert.deepEqual(adopted.at(-1)[0].attachments, attachments);
});

test('completed native creation refreshes exact first-turn model evidence without changing identity or sending again', async t => {
  const selection = { model: 'fixture-model', reasoningEffort: 'max' };
  const original = native(randomUUID());
  let observation = { ...original, modelEvidence: { ...selection, reroutes: [] } };
  let creates = 0, recoveries = 0;
  const localExecutor = { ready: async () => {}, close() {},
    createChat: async () => { creates++; return original; },
    recoverChat: async () => { recoveries++; return observation; } };
  const f = await creationFixture(t, { localExecutor, requireSelection: async () => {} });
  const input = message({ selection });
  await f.service.accept(input);
  while (f.service.get('local', localProject, input.id).state !== 'completed') await tick();
  await tick();
  assert.equal(f.service.get('local', localProject, input.id).modelVerification, 'unverified');
  const refreshed = await f.service.status('local', localProject, input.id);
  assert.equal(refreshed.modelVerification, 'confirmed');
  assert.equal(refreshed.notice, undefined);
  assert.equal(refreshed.thread.id, original.thread.id);
  assert.equal(refreshed.firstTurnId, original.firstTurnId);
  assert.equal(creates, 1); assert.equal(recoveries, 1);

  const rerouted = { ...selection, reroutes: [{ fromModel: selection.model, toModel: 'fallback-model', reason: 'capacity' }] };
  observation = { ...original, firstTurnId: randomUUID(), modelEvidence: rerouted };
  assert.equal((await f.service.status('local', localProject, input.id)).modelVerification, 'confirmed');
  observation = { ...original, thread: { ...original.thread, id: randomUUID() }, modelEvidence: rerouted };
  assert.equal((await f.service.status('local', localProject, input.id)).thread.id, original.thread.id);
  observation = { state: 'unknown' };
  assert.equal((await f.service.status('local', localProject, input.id)).state, 'completed');
  observation = { ...original, modelEvidence: rerouted };
  const later = await f.service.status('local', localProject, input.id);
  assert.equal(later.modelVerification, 'different');
  assert.match(later.notice, /rerouted/);
  f.service.close();
  const restored = f.open();
  assert.deepEqual(restored.get('local', localProject, input.id).modelEvidence, rerouted);
  assert.equal((await restored.accept(input)).duplicate, true);
  assert.equal(creates, 1);
});

test('a legacy local job still recovers through its original companion after native creation is enabled', async t => {
  const f = await creationFixture(t);
  const input = message();
  await f.service.accept(input); await f.controls.waitForCalls(1);
  f.controls.resolve({ state: 'unknown' }); await tick(); f.service.close();
  const path = join(f.root, 'receipts', `${input.id}.json`);
  const legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.executorKind;
  await writeFile(path, JSON.stringify(legacy));
  f.options.localExecutor = { ready: async () => {}, close() {},
    createChat: async () => assert.fail('Must not create a second local chat'),
    recoverChat: async () => assert.fail('A legacy job belongs to its original companion') };
  const result = native(randomUUID()); f.controls.recovered = result;
  const restored = f.open();
  assert.equal((await restored.accept(input)).duplicate, true);
  const receipt = await restored.status('local', localProject, input.id);
  assert.equal(receipt.thread.id, result.thread.id); assert.equal(receipt.creationMethod, 'companion');
  assert.equal(f.calls.length, 1);
});

test('unknown creation never replays and a late official result upgrades the same durable receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await creationFixture(t, { unknownAfterMs: 20000 });
  const input = message({ hostId: remote, projectId: remoteProject });
  await f.service.accept(input); await f.controls.waitForCalls(1);
  assert.equal(f.service.get(remote, remoteProject, input.id).state, 'creating');
  t.mock.timers.tick(20000);
  assert.equal(f.service.get(remote, remoteProject, input.id).state, 'unknown');
  assert.equal((await f.service.accept(input)).duplicate, true); assert.equal(f.calls.length, 1);
  const threadId = randomUUID(); f.controls.resolve(native(threadId, remote)); await tick();
  assert.equal(f.service.get(remote, remoteProject, input.id).state, 'completed');
  assert.equal(f.open().get(remote, remoteProject, input.id).thread.id, threadId);
  assert.equal(f.calls.length, 1);
});

test('restart does not repeat a potentially written create, and known preflight failures are safely editable', async t => {
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
  f.service.close();
  const restored = f.open();
  assert.equal(restored.get('local', localProject, input.id).state, 'unknown');
  assert.equal((await restored.accept(input)).duplicate, true); assert.equal(f.calls.length, 1);
  f.controls.reject(new Error('PRIVATE_NATIVE_ERROR')); await tick();
  const recovered = native(randomUUID()); f.controls.recovered = recovered;
  assert.equal((await restored.status('local', localProject, input.id)).thread.id, recovered.thread.id);
  assert.equal(f.calls.length, 1);
  f.controls.readyFailure = true;
  const next = message(); await restored.accept(next);
  while (restored.get('local', localProject, next.id).state === 'pending') await tick();
  const failed = restored.get('local', localProject, next.id);
  assert.equal(failed.state, 'failed'); assert.equal(f.calls.length, 1);
  assert(!JSON.stringify(failed).includes('PRIVATE_'));
  const projects = await restored.projects('local');
  assert(projects.projects.every(project => project.canCreate === false));
});

test('created chat survives a rejected first response, while a wrong-host result remains unknown', async t => {
  const f = await creationFixture(t);
  const first = message(); await f.service.accept(first); await f.controls.waitForCalls(1);
  const threadId = randomUUID();
  f.controls.resolve({ ...native(threadId), notice: 'The chat was created, but its first response failed.' }); await tick();
  assert.equal(f.service.get('local', localProject, first.id).state, 'completed');
  assert(f.service.get('local', localProject, first.id).notice.includes('first response'));
  const second = message(); await f.service.accept(second); await f.controls.waitForCalls(2);
  f.controls.resolve(native(randomUUID(), remote)); await tick();
  assert.equal(f.service.get('local', localProject, second.id).state, 'unknown');
});

test('a definitely busy helper leaves a durable pending request that can dispatch once later', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
  f.controls.reject(new ProjectCreationNotSentError(true)); await tick();
  assert.equal(f.service.get('local', localProject, input.id).state, 'pending');
  t.mock.timers.tick(3000); await f.controls.waitForCalls(2);
  f.controls.resolve(native(randomUUID())); await tick();
  assert.equal(f.service.get('local', localProject, input.id).state, 'completed');
  t.mock.timers.tick(3000); await tick(); assert.equal(f.calls.length, 2);
});

test('a modified immutable request is rejected before a helper can execute it', async t => {
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input);
  const path = join(f.root, 'receipts', 'requests', `${input.id}.json`);
  // These synchronous operations precede the dispatch's setImmediate boundary.
  chmodSync(path, 0o600); writeFileSync(path, '{"prompt":"Changed"}'); chmodSync(path, 0o400);
  while (f.service.get('local', localProject, input.id).state === 'pending') await tick();
  assert.equal(f.service.get('local', localProject, input.id).state, 'failed'); assert.equal(f.calls.length, 0);
});

test('explicit creation settings require a host catalogue before admission', async t => {
  const f = await creationFixture(t);
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  await assert.rejects(f.service.accept(input), error => error.status === 503 && error.code === 'catalogue_unavailable');
  await tick();
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.service.get(input.hostId, input.projectId, input.id), error => error.status === 404);
});

test('creation freezes a host-validated selection in its ID, immutable request and restored receipt', async t => {
  const validations = [];
  const f = await creationFixture(t, { requireSelection: async (hostId, selection, hasImages) => {
    validations.push({ hostId, selection: structuredClone(selection), hasImages });
  } });
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  const input = message({ hostId: remote, projectId: remoteProject, selection: { ...selection } });
  const accepted = await f.service.accept(input);
  assert.equal(accepted.receipt.modelVerification, 'pending');
  input.selection.model = 'changed-after-send';
  await f.controls.waitForCalls(1);
  assert.deepEqual(f.calls[0].selection, selection);
  assert.deepEqual(validations, Array.from({ length: 2 }, () => ({ hostId: remote, selection, hasImages: false })));
  const stored = JSON.parse(await readFile(join(f.root, 'receipts', `${input.id}.json`), 'utf8'));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.selection, selection);
  const immutable = JSON.parse(await readFile(f.calls[0].requestPath, 'utf8'));
  assert.deepEqual(immutable.selection, selection);
  await assert.rejects(f.service.accept(input), error => error.status === 409 && error.code === 'id_conflict');
  await assert.rejects(f.service.accept({ ...input, selection: { ...selection, reasoningEffort: 'low' } }), error => error.status === 409);
  const modelEvidence = { ...selection, reroutes: [] };
  f.controls.resolve({ ...native(randomUUID(), remote), modelEvidence }); await tick();
  const receipt = f.service.get(remote, remoteProject, input.id);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.modelVerification, 'confirmed');
  assert.deepEqual(receipt.selection, selection); assert.deepEqual(receipt.modelEvidence, modelEvidence);
  const firstMessage = f.service.verifiedFirstMessage(remote, receipt.thread.id);
  assert.deepEqual(firstMessage.selection, selection);
  firstMessage.selection.model = 'changed-after-read';
  assert.deepEqual(f.service.verifiedFirstMessage(remote, receipt.thread.id).selection, selection);
  f.service.close();
  const restored = f.open();
  assert.deepEqual(restored.get(remote, remoteProject, input.id), receipt);
  assert.equal((await restored.accept({ ...input, selection })).duplicate, true);
  assert.equal(validations.length, 2); assert.equal(f.calls.length, 1);
});

test('an unavailable catalogue keeps an unsent creation pending and revalidates before eventual execution', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let validations = 0;
  let available = false;
  let observedSecondValidation;
  const secondValidation = new Promise(resolve => { observedSecondValidation = resolve; });
  const f = await creationFixture(t, { requireSelection: async () => {
    validations += 1;
    if (validations === 2) observedSecondValidation();
    if (validations > 1 && !available) throw new ConversationError('PRIVATE_CATALOGUE_ERROR', 503, 'catalogue_unavailable');
  } });
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  await f.service.accept(input); await secondValidation; await tick();
  const waiting = f.service.get('local', localProject, input.id);
  assert.equal(waiting.state, 'pending'); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(waiting).includes('PRIVATE_'));
  available = true;
  t.mock.timers.tick(3000); await f.controls.waitForCalls(1);
  assert.equal(validations, 3);
  f.controls.resolve(native(randomUUID())); await tick();
  const receipt = f.service.get('local', localProject, input.id);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.modelVerification, 'unverified');
  assert.match(receipt.notice, /could not confirm/i);
  assert.equal(f.calls.length, 1);
});

test('a selection removed before dispatch fails without a helper send', async t => {
  let validations = 0;
  const f = await creationFixture(t, { requireSelection: async () => {
    if (++validations > 1) throw new ConversationError('PRIVATE_REMOVED_MODEL', 422, 'model_unavailable');
  } });
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  await f.service.accept(input);
  while (f.service.get('local', localProject, input.id).state === 'pending') await tick();
  const failed = f.service.get('local', localProject, input.id);
  assert.equal(failed.state, 'failed'); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(failed).includes('PRIVATE_'));
});

test('an offline host model catalogue does not block queued creation on another host', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let remoteValidations = 0;
  let releaseRemote;
  const remoteGate = new Promise((_, reject) => { releaseRemote = reject; });
  let remoteStarted;
  const started = new Promise(resolve => { remoteStarted = resolve; });
  let trackRetry = false;
  let retriedHost;
  const retryStarted = new Promise(resolve => { retriedHost = resolve; });
  const f = await creationFixture(t, { requireSelection: async hostId => {
    if (trackRetry) retriedHost(hostId);
    if (hostId === remote && ++remoteValidations > 1) {
      remoteStarted(); await remoteGate;
    }
  } });
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  const blocked = message({ hostId: remote, projectId: remoteProject, selection });
  const available = message({ selection });
  await f.service.accept(blocked); await started;
  await f.service.accept(available); await tick();
  releaseRemote(new ConversationError('Offline host catalogue.', 503, 'catalogue_unavailable')); await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.get(remote, remoteProject, blocked.id).state, 'pending');
  trackRetry = true;
  t.mock.timers.tick(3000);
  assert.equal(await retryStarted, 'local');
  await f.controls.waitForCalls(1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, available.id);
  assert.equal(remoteValidations, 2);
  f.controls.resolve(native(randomUUID())); await tick();
  assert.equal(f.service.get('local', localProject, available.id).state, 'completed');
});

test('a created chat with native model substitution completes once and reports the difference', async t => {
  const f = await creationFixture(t, { requireSelection: async () => {} });
  const selection = { model: 'fixture-model', reasoningEffort: 'high' };
  const input = message({ selection });
  await f.service.accept(input); await f.controls.waitForCalls(1);
  const modelEvidence = { model: 'substituted-model', reasoningEffort: 'high',
    reroutes: [{ fromModel: 'fixture-model', toModel: 'substituted-model', reason: 'unavailable' }] };
  f.controls.resolve({ ...native(randomUUID()), modelEvidence }); await tick();
  const receipt = f.service.get('local', localProject, input.id);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.modelVerification, 'different');
  assert.match(receipt.notice, /different/i);
  assert.equal((await f.service.accept(input)).duplicate, true); assert.equal(f.calls.length, 1);
});

test('project creation HTTP rejects unpaired requests and exposes only target-scoped receipts', async t => {
  const f = await creationFixture(t);
  const app = express();
  app.use((req, res, next) => { if (req.path.startsWith('/device/test/api/')) { res.locals.autoReplyAuthorized = true; req.url = req.url.slice('/device/test'.length); } next(); });
  app.use(express.json()); installProjectRoutes(app, f.service);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const paired = `${base}/device/test`;
  assert.equal((await fetch(`${base}/api/codex/projects?hostId=local`)).status, 403);
  const input = message(); const post = url => fetch(`${url}/api/codex/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await post(base)).status, 403); assert.equal((await post(paired)).status, 202);
  assert.equal((await post(paired)).status, 200); await f.controls.waitForCalls(1);
  f.controls.resolve(native(randomUUID())); await tick();
  assert.equal((await fetch(`${paired}/api/codex/chats/${input.id}?hostId=local&projectId=${localProject}`)).status, 200);
  assert.equal((await fetch(`${paired}/api/codex/chats/${input.id}?hostId=local&projectId=other`)).status, 404);
  assert.equal((await fetch(`${paired}/api/codex/projects?hostId=local&hostId=${remote}`)).status, 400);
  assert.equal(f.calls.length, 1);
});

const approvalFailure = (input, attemptId = input.id) => ({ state: 'failed_before_execution', reason: 'approval_review_timeout',
  proof: { requestId: input.id, attemptId, hostId: input.hostId, projectId: input.projectId, executorThreadId: helperId,
    helperTurnId: randomUUID(), toolCallId: `exec-${randomUUID()}`, approvalReviewId: `automatic-approval-review:${randomUUID()}`,
    verifiedAt: new Date().toISOString() } });

test('one approval-timeout retry preserves the original request and admits concurrent retries only once', async t => {
  const f = await creationFixture(t, { requireSelection: async () => {} });
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  await f.service.accept(input); await f.controls.waitForCalls(1);
  const failure = approvalFailure(input);
  f.controls.resolve(failure); f.controls.recovered = failure; await tick();
  const failed = f.service.get(input.hostId, input.projectId, input.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.canRetry, true);
  assert.equal(failed.failureCode, 'approval_review_timeout');
  assert.equal(failed.attemptId, input.id); assert.equal(failed.attemptNumber, 1);
  const immutableBefore = await readFile(f.calls[0].requestPath, 'utf8');
  const body = { hostId: input.hostId, projectId: input.projectId, attemptId: failed.attemptId };
  const results = await Promise.all([f.service.retry(input.id, body), f.service.retry(input.id, body)]);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  await f.controls.waitForCalls(2);
  const execution = f.calls[1];
  assert.equal(execution.id, input.id); assert.equal(execution.prompt, input.prompt);
  assert.deepEqual(execution.selection, input.selection); assert.equal(execution.requestPath, f.calls[0].requestPath);
  assert.notEqual(execution.retry.attemptId, input.id); assert.equal(execution.retry.attemptNumber, 2);
  assert.deepEqual(execution.retry.previousFailure, failure.proof);
  assert.equal(await readFile(execution.requestPath, 'utf8'), immutableBefore);
  const stored = JSON.parse(await readFile(join(f.root, 'receipts', `${input.id}.json`), 'utf8'));
  assert.deepEqual(stored.attempts.map(attempt => [attempt.id, attempt.number]), [[input.id, 1], [execution.retry.attemptId, 2]]);
  assert.equal((await f.service.retry(input.id, body)).duplicate, true); assert.equal(f.calls.length, 2);
  f.controls.resolve({ ...native(randomUUID()), modelEvidence: { ...input.selection, reroutes: [] } }); await tick();
  const completed = f.service.get(input.hostId, input.projectId, input.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.modelVerification, 'confirmed');
  assert.equal(completed.attemptNumber, 2); assert.equal(completed.canRetry, false);
  assert.equal((await f.service.retry(input.id, body)).receipt.thread.id, completed.thread.id);
  assert.equal(f.calls.length, 2);
});

test('ordinary unknown is not retryable and a second native approval failure cannot create a third attempt', async t => {
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
  f.controls.resolve({ state: 'unknown' }); await tick();
  const body = { hostId: input.hostId, projectId: input.projectId, attemptId: input.id };
  await assert.rejects(f.service.retry(input.id, body), error => error.status === 409 && error.code === 'creation_retry_unavailable');
  assert.equal(f.calls.length, 1);
  f.controls.recovered = approvalFailure(input);
  const recover = await f.service.status(input.hostId, input.projectId, input.id);
  assert.equal(recover.canRetry, true); assert.equal(f.calls.length, 1);
  const accepted = await f.service.retry(input.id, body); await f.controls.waitForCalls(2);
  f.controls.resolve(approvalFailure(input, accepted.receipt.attemptId)); await tick();
  const stopped = f.service.get(input.hostId, input.projectId, input.id);
  assert.equal(stopped.state, 'failed'); assert.equal(stopped.canRetry, false);
  assert.equal(stopped.failureCode, 'approval_review_timeout');
  await assert.rejects(f.service.retry(input.id, { ...body, attemptId: stopped.attemptId }),
    error => error.status === 409 && error.code === 'creation_retry_limit');
  assert.equal((await f.service.retry(input.id, body)).duplicate, true);
  assert.equal(f.calls.length, 2);
});

test('changed original-attempt evidence during retry stays read-only or restores the already-created chat', async t => {
  for (const originalState of ['unknown', 'completed']) {
    const f = await creationFixture(t);
    const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
    const failure = approvalFailure(input); f.controls.resolve(failure); f.controls.recovered = failure; await tick();
    const body = { hostId: input.hostId, projectId: input.projectId, attemptId: input.id };
    const retry = await f.service.retry(input.id, body); await f.controls.waitForCalls(2);
    const originalChat = native(randomUUID());
    f.controls.resolve(originalState === 'completed' ? originalChat : { state: 'unknown' }); await tick();
    const receipt = f.service.get(input.hostId, input.projectId, input.id);
    assert.equal(receipt.state, originalState); assert.equal(receipt.canRetry, false);
    assert.equal(receipt.error, undefined); assert.equal(receipt.attemptId, retry.receipt.attemptId);
    if (originalState === 'completed') assert.equal(receipt.thread.id, originalChat.thread.id);
    assert.equal((await f.service.accept(input)).duplicate, true);
    assert.equal((await f.service.retry(input.id, body)).duplicate, true);
    if (originalState === 'unknown') {
      f.controls.recovered = originalChat;
      const late = await f.service.status(input.hostId, input.projectId, input.id);
      assert.equal(late.state, 'completed'); assert.equal(late.thread.id, originalChat.thread.id);
      assert.equal(late.id, input.id); assert.equal(late.attemptId, retry.receipt.attemptId);
    }
    assert.equal(f.calls.length, 2);
  }
});

test('a written retry survives restart without replay and an old recovery cannot replace its attempt', async t => {
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
  f.controls.resolve({ state: 'unknown' }); await tick();
  let finishOldRecovery;
  f.controls.recover = async () => new Promise(resolve => { finishOldRecovery = resolve; });
  const recovery = f.service.status(input.hostId, input.projectId, input.id); await tick();
  const body = { hostId: input.hostId, projectId: input.projectId, attemptId: input.id };
  await assert.rejects(f.service.retry(input.id, body), error => error.status === 409 && error.code === 'creation_busy');
  const failure = approvalFailure(input); finishOldRecovery(failure); await recovery;
  delete f.controls.recover; f.controls.recovered = failure;
  const retry = await f.service.retry(input.id, body); await f.controls.waitForCalls(2);
  f.service.close();
  const restored = f.open();
  const unknown = restored.get(input.hostId, input.projectId, input.id);
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.attemptId, retry.receipt.attemptId);
  assert.equal((await restored.retry(input.id, body)).duplicate, true);
  const completed = native(randomUUID()); f.controls.recovered = completed;
  assert.equal((await restored.status(input.hostId, input.projectId, input.id)).thread.id, completed.thread.id);
  assert.equal(f.calls.length, 2);
});

test('retry HTTP requires pairing, the original target and a fixed attempt token', async t => {
  const f = await creationFixture(t);
  const input = message(); await f.service.accept(input); await f.controls.waitForCalls(1);
  const failure = approvalFailure(input); f.controls.resolve(failure); f.controls.recovered = failure; await tick();
  const app = express();
  app.use((req, res, next) => { if (req.path.startsWith('/device/test/api/')) { res.locals.autoReplyAuthorized = true; req.url = req.url.slice('/device/test'.length); } next(); });
  app.use(express.json()); installProjectRoutes(app, f.service);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { hostId: input.hostId, projectId: input.projectId, attemptId: input.id };
  const post = (prefix, value) => fetch(`${base}${prefix}/api/codex/chats/${input.id}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post('', body)).status, 403);
  assert.equal((await post('/device/test', { ...body, prompt: 'Changed' })).status, 400);
  assert.equal((await post('/device/test', { ...body, hostId: remote, projectId: remoteProject })).status, 404);
  assert.equal((await post('/device/test', { ...body, attemptId: randomUUID() })).status, 409);
  const replies = await Promise.all([post('/device/test', body), post('/device/test', body)]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 202]);
  await f.controls.waitForCalls(2); assert.equal(f.calls.length, 2);
  f.controls.resolve(native(randomUUID())); await tick();
});

test('a failed retry commit leaves no dispatchable attempt and can be admitted after storage recovers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let validations = 0;
  let blockedPath;
  const f = await creationFixture(t, { requireSelection: async () => { if (++validations === 3) mkdirSync(blockedPath); } });
  const input = message({ selection: { model: 'fixture-model', reasoningEffort: 'high' } });
  blockedPath = join(f.root, 'receipts', `${input.id}.json.tmp`);
  await f.service.accept(input); await f.controls.waitForCalls(1);
  const failure = approvalFailure(input); f.controls.resolve(failure); f.controls.recovered = failure; await tick();
  const body = { hostId: input.hostId, projectId: input.projectId, attemptId: input.id };
  await assert.rejects(f.service.retry(input.id, body));
  const unchanged = f.service.get(input.hostId, input.projectId, input.id);
  assert.equal(unchanged.state, 'failed'); assert.equal(unchanged.attemptNumber, 1); assert.equal(unchanged.canRetry, true);
  t.mock.timers.tick(3000); await tick(); assert.equal(f.calls.length, 1);
  const persisted = JSON.parse(await readFile(join(f.root, 'receipts', `${input.id}.json`), 'utf8'));
  assert.equal(persisted.attempts.length, 1);
  await rm(blockedPath, { recursive: true });
  await f.service.retry(input.id, body); await f.controls.waitForCalls(2);
  f.controls.resolve(native(randomUUID())); await tick();
  assert.equal(f.service.get(input.hostId, input.projectId, input.id).state, 'completed');
});
