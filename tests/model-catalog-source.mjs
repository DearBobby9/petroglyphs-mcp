import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readLocalModelCatalog, parseModelCatalogSnapshot } from '../src/codex-model-catalog-source.ts';

const model = (name = 'host-model') => ({ id: name, model: name, hidden: false, displayName: name, description: 'Host capability',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'max', description: 'Maximum' }],
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault: true,
  instructions: 'PRIVATE_INSTRUCTIONS', account: 'PRIVATE_ACCOUNT' });

async function executable(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'model-catalog-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'codex');
  const log = join(dir, 'requests.jsonl');
  const closed = join(dir, 'closed');
  const pid = join(dir, 'pid');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); });
const mode = ${JSON.stringify(mode)};
const model = ${JSON.stringify(model())};
let page = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
lines.on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');
  if (request.method === 'initialize') { reply(request.id, {}); return; }
  if (request.method === 'initialized') return;
  if (request.method !== 'model/list') process.exit(9);
  process.stderr.write('PRIVATE_STDERR_AUTH_INFORMATION\\n');
  if (mode === 'timeout') return;
  if (mode === 'malformed') { process.stdout.write('PRIVATE_INVALID_JSON\\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); return; }
  if (mode === 'error') { process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'PRIVATE_ERROR' } }) + '\\n'); return; }
  if (mode === 'cycle') { reply(request.id, { data: [{ ...model, id: 'page' + page, model: 'page' + page++ }], nextCursor: 'same' }); return; }
  if (mode === 'duplicate') { reply(request.id, { data: [model, model], nextCursor: null }); return; }
  if (mode === 'invalid-effort') { reply(request.id, { data: [{ ...model, defaultReasoningEffort: 'ultra' }], nextCursor: null }); return; }
  if (page++ === 0) reply(request.id, { data: [model, { ...model, id: 'hidden', model: 'hidden', hidden: true }], nextCursor: 'page-2' });
  else reply(request.id, { data: [{ ...model, id: 'next-model', model: 'next-model', isDefault: false }], nextCursor: null });
});
setInterval(() => {}, 60_000);
`;
  await writeFile(path, script);
  await chmod(path, 0o700);
  return { path, log, closed, pid };
}

test('reader paginates, removes hidden/private fields, and resolves only after its CLI exits', async t => {
  const fixture = await executable(t, 'success');
  const result = await readLocalModelCatalog({ codexPath: fixture.path });
  assert.deepEqual(result.models.map(model => model.model), ['host-model', 'next-model']);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.equal(result.source, 'codex-app-server');
  const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.deepEqual(requests.slice(2).map(request => request.params), [
    { includeHidden: false, cursor: null, limit: 100 }, { includeHidden: false, cursor: 'page-2', limit: 100 },
  ]);
  assert.equal(await readFile(fixture.closed, 'utf8'), 'closed');
  const pid = Number.parseInt(await readFile(fixture.pid, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('reader bounds invalid, repeated, oversized, failed and stalled app-server responses', async t => {
  for (const mode of ['cycle', 'duplicate', 'invalid-effort', 'malformed', 'oversized', 'error', 'timeout']) {
    await t.test(mode, async t => {
      const fixture = await executable(t, mode);
      await assert.rejects(readLocalModelCatalog({ codexPath: fixture.path, timeoutMs: mode === 'timeout' ? 300 : 2000 }), error => {
        assert.equal(error.status, 503);
        assert(!error.message.includes('PRIVATE_'));
        return true;
      });
      const pid = Number.parseInt(await readFile(fixture.pid, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
  }
});

test('reader startup failure is bounded and snapshots cannot extend stale or future data', async () => {
  await assert.rejects(readLocalModelCatalog({ codexPath: '/no/such/codex-catalog-executable', timeoutMs: 300 }), error => error.code === 'catalogue_unavailable');
  const now = Date.now();
  const snapshot = age => ({ version: 1, source: 'codex-app-server', observedAt: new Date(now - age).toISOString(), models: [model()] });
  assert.throws(() => parseModelCatalogSnapshot(snapshot(300_000), now), error => error.code === 'catalogue_stale');
  assert.throws(() => parseModelCatalogSnapshot(snapshot(-31_000), now), error => error.code === 'invalid_catalogue');
  assert.equal(parseModelCatalogSnapshot(snapshot(299_999), now).models.length, 1);
});
