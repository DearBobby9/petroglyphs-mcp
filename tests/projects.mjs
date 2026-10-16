import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
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

async function creationFixture(t, custom = {}) {
  const f = await catalogFixture(t);
  const calls = [];
  const waiters = [];
  const controls = { calls, resolve: null, reject: null, readyFailure: false,
    waitForCalls: count => calls.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve })) };
  const tools = { executorThreadId: helperId, close() {}, recoverChat: async () => controls.recovered ?? { state: 'unknown' },
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
