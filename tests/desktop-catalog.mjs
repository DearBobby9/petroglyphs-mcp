import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexDesktopCatalog, CodexDesktopCatalogError } from '../src/codex-desktop-catalog.ts';

const hostA = 'remote-control:env_host_a';
const hostB = 'remote-control:env_host_b';
const partialHost = 'remote-control:env_partial';
const disabledHost = 'remote-control:env_disabled';
const id = number => `10000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'petroglyphs-desktop-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'catalog.db');
  const statePath = join(directory, 'desktop-state.json');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT);
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY,
      initial_build_complete INTEGER, watermark_updated_at REAL, last_full_reconciled_at INTEGER);
    CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
    INSERT INTO local_thread_catalog_metadata VALUES (1, 7);
    CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT,
      cwd TEXT, source_updated_at REAL, source_kind TEXT, thread_source TEXT,
      missing_candidate INTEGER, PRIMARY KEY(host_id, thread_id));`);
  for (const host of [hostA, hostB, partialHost, disabledHost, 'chatgpt:OTHER_ACCOUNT:OTHER_USER', 'local']) {
    db.prepare('INSERT INTO local_thread_catalog_hosts VALUES (?, ?)')
      .run(host, host.startsWith('remote-control:') ? 'remote-control' : host === 'local' ? 'local' : 'chatgpt');
    db.prepare('INSERT INTO local_thread_catalog_sync_state VALUES (?, ?, ?, ?)')
      .run(host, host === partialHost ? 0 : 1, 5_000, host === partialHost ? null : 10);
  }
  const insert = ({ host = hostA, threadId, title, cwd = '/project', updatedAt = 100,
    source = 'vscode', threadSource = 'user', missing = 0 }) => {
    db.prepare('INSERT INTO local_thread_catalog VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(host, threadId, title, cwd, updatedAt, source, threadSource, missing);
  };
  const state = {
    'remote-connection-auto-connect-by-host-id': {
      [hostA]: true, [hostB]: true, [partialHost]: true, [disabledHost]: false,
      local: true, 'chatgpt:OTHER_ACCOUNT:OTHER_USER': true,
    },
    'added-remote-control-env-ids': ['env_disabled'],
    'electron-remote-control-client-enrollments': { secret: 'PRIVATE_ENROLLMENT' },
    'electron-persisted-atom-state': { history: 'PRIVATE_HISTORY' },
  };
  await writeFile(statePath, JSON.stringify(state));
  t.after(() => db.close());
  return { db, state, statePath, databasePath, insert,
    catalog: new CodexDesktopCatalog({ databasePath, statePath, ...options }) };
}

test('complete directory pages include old unopened chats and isolate host metadata', async t => {
  const f = await fixture(t, { pageSize: 7 });
  for (let index = 1; index <= 76; index++) {
    f.insert({ threadId: id(index), title: index === 1 ? '旧项目 never opened' : `Chat ${index}`,
      updatedAt: Math.floor(index / 3) });
  }
  f.insert({ host: hostB, threadId: id(1), title: 'Other machine', updatedAt: 999 });
  f.insert({ host: 'chatgpt:OTHER_ACCOUNT:OTHER_USER', threadId: id(500), title: 'PRIVATE_ACCOUNT' });
  f.insert({ threadId: id(501), title: 'Removed', missing: 1 });
  f.insert({ threadId: id(502), title: 'Hidden', threadSource: 'chatgpt_hidden' });
  f.insert({ threadId: id(503), title: 'One-shot exec', source: 'exec' });

  const hosts = await f.catalog.listHosts();
  assert.equal(hosts.length, 4);
  assert.equal(hosts.find(host => host.id === hostA).available, true);
  assert.equal(hosts.find(host => host.id === hostA).catalog.connectionState, 'unknown');
  assert.equal(hosts.find(host => host.id === hostA).catalog.lastFullReconciledAt, 10,
    'an old reconciliation date must be reported, not interpreted as current connectivity');
  assert(!JSON.stringify(hosts).includes('PRIVATE_'));
  assert(!JSON.stringify(hosts).includes('OTHER_ACCOUNT'));

  const seen = [];
  let cursor;
  do {
    const page = await f.catalog.listThreads(hostA, { cursor });
    assert(page.threads.length <= 7);
    assert.equal(page.catalog.complete, true);
    seen.push(...page.threads);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, 76);
  assert.equal(new Set(seen.map(thread => thread.id)).size, 76, 'equal timestamps must not duplicate or skip a page');
  assert.equal(seen.at(-1).title, '旧项目 never opened');
  assert(seen.every(thread => thread.title !== 'Other machine'));

  const search = await f.catalog.listThreads(hostA, { search: '旧项目' });
  assert.deepEqual(search.threads.map(thread => thread.id), [id(1)]);
  assert.equal(search.catalog.searchScope, 'title-and-path');
  await assert.rejects(f.catalog.requireThread(hostB, id(76)), error => error.status === 404);
  assert.equal((await f.catalog.requireThread(hostB, id(1))).title, 'Other machine');
});

test('search uses literal title/path text and cursors cannot cross hosts or queries', async t => {
  const f = await fixture(t, { pageSize: 1 });
  f.insert({ threadId: id(1), title: 'Release 100%_done', cwd: 'C:\\Work\\old_project', updatedAt: 1 });
  f.insert({ threadId: id(2), title: 'Release ordinary', updatedAt: 2 });
  f.insert({ threadId: id(3), title: 'Release 100%_next', updatedAt: 3 });
  const first = await f.catalog.listThreads(hostA, { search: '100%_' });
  assert.equal(first.threads[0].id, id(3));
  assert(first.nextCursor);
  const last = await f.catalog.listThreads(hostA, { search: '100%_', cursor: first.nextCursor });
  assert.deepEqual(last.threads.map(thread => thread.id), [id(1)]);
  assert.equal(last.nextCursor, null);
  assert.equal((await f.catalog.listThreads(hostA, { search: 'C:\\Work\\old_' })).threads[0].id, id(1));
  assert.equal((await f.catalog.listThreads(hostA, { search: "' OR 1=1 --" })).threads.length, 0);
  for (const [host, query] of [
    [hostB, { search: '100%_', cursor: first.nextCursor }],
    [hostA, { search: 'Release', cursor: first.nextCursor }],
    [hostA, { cursor: 'not-json' }],
  ]) await assert.rejects(f.catalog.listThreads(host, query), error => error instanceof CodexDesktopCatalogError && error.status === 400);
});

test('partial and disabled directories remain explicit and cannot admit a submission target', async t => {
  const f = await fixture(t);
  f.insert({ host: partialHost, threadId: id(1), title: 'Partial result' });
  f.insert({ host: disabledHost, threadId: id(2), title: 'Disabled host' });
  const hosts = await f.catalog.listHosts();
  const partial = hosts.find(host => host.id === partialHost);
  assert.equal(partial.configured, true);
  assert.equal(partial.available, false);
  assert.match(partial.reason, /not finished/);
  await assert.rejects(f.catalog.listThreads(partialHost), error => error.status === 503);
  await assert.rejects(f.catalog.requireThread(partialHost, id(1)), error => error.status === 503);
  const disabled = hosts.find(host => host.id === disabledHost);
  assert.equal(disabled.configured, false, 'explicit disable overrides legacy added-host membership');
  assert.equal(disabled.available, false);
  await assert.rejects(f.catalog.listThreads(disabledHost), error => error.status === 503);
  await assert.rejects(f.catalog.listThreads('remote-control:env_unknown'), error => error.status === 404);
  await assert.rejects(f.catalog.listThreads('chatgpt:OTHER_ACCOUNT:OTHER_USER'), error => error.status === 404);
});

test('fresh reads observe Desktop updates and never mutate its catalog', async t => {
  const f = await fixture(t);
  f.insert({ threadId: id(1), title: 'Before' });
  const hash = async () => createHash('sha256').update(await readFile(f.databasePath)).digest('hex');
  const before = await hash();
  await f.catalog.listHosts();
  await f.catalog.listThreads(hostA);
  await f.catalog.requireThread(hostA, id(1));
  assert.equal(await hash(), before);
  f.insert({ threadId: id(2), title: 'Desktop background sync', updatedAt: 200 });
  f.db.prepare('UPDATE local_thread_catalog_metadata SET catalog_revision = 8 WHERE id = 1').run();
  const page = await f.catalog.listThreads(hostA);
  assert.equal(page.threads[0].id, id(2));
  assert.equal(page.catalog.revision, 8);
  f.state['remote-connection-auto-connect-by-host-id'][hostA] = false;
  await writeFile(f.statePath, JSON.stringify(f.state));
  await assert.rejects(f.catalog.requireThread(hostA, id(1)), error => error.status === 503);
});

test('missing directory does not create a database or leak private paths', async t => {
  const f = await fixture(t);
  const databasePath = join(f.databasePath, 'PRIVATE_PATH');
  const catalog = new CodexDesktopCatalog({ databasePath, statePath: f.statePath });
  const hosts = await catalog.listHosts();
  assert(hosts.every(host => !host.available));
  await assert.rejects(catalog.listThreads(hostA), error => error.status === 503 && !error.message.includes('PRIVATE_PATH'));
  await assert.rejects(readFile(databasePath));
});

test('deployment labels improve selection without enabling additional hosts', async t => {
  const f = await fixture(t);
  const metadataPath = join(f.databasePath, '..', 'host-names.json');
  await writeFile(metadataPath, JSON.stringify({ hosts: [
    { id: hostA, name: 'Mac mini' }, { id: hostB, name: 'Legion' },
    { id: disabledHost, name: 'Disabled computer' },
    { id: 'remote-control:env_not_registered', name: 'Overlay alone' },
  ] }));
  const catalog = new CodexDesktopCatalog({ databasePath: f.databasePath, statePath: f.statePath,
    env: { PETROGLYPHS_DESKTOP_HOST_NAMES: metadataPath } });
  const hosts = await catalog.listHosts();
  assert.equal(hosts.find(host => host.id === hostA).name, 'Mac mini');
  assert.equal(hosts.find(host => host.id === hostB).name, 'Legion');
  assert.equal(hosts.find(host => host.id === disabledHost).available, false);
  assert(!hosts.some(host => host.id === 'remote-control:env_not_registered'));
  await writeFile(metadataPath, JSON.stringify({ hosts: [{ id: hostA, name: 'A', token: 'PRIVATE_TOKEN' }] }));
  await assert.rejects(catalog.listHosts(), error => error.status === 503 && !error.message.includes('PRIVATE_TOKEN'));
});
