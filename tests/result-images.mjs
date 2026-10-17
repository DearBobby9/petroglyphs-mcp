import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CodexResultImages, resultImageInputs, stripResultImageSources } from '../src/codex-result-images.ts';

const thread = '00000000-0000-7000-8000-000000000003';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const dataURL = (bytes = png, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'petroglyphs-result-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  let persisted = 0;
  const persist = (name, mimeType, bytes) => {
    persisted += 1;
    const id = createHash('sha256').update(bytes).digest('hex');
    return { id, name, mimeType, availability: 'available', byteCount: bytes.length, assetPath: `/api/codex/assets/${id}?hostId=local&threadId=${thread}` };
  };
  const create = () => new CodexResultImages({ dataDir, codexHome: join(root, 'codex') });
  return { root, dataDir, create, persist, count: () => persisted };
}

function request(inputs, extras = {}) {
  return { hostId: 'local', threadId: thread, messageId: 'message-result-1', inputs, ...extras };
}

test('extracts only explicit generated, tool, and assistant Markdown image results', () => {
  const generated = resultImageInputs({ type: 'imageGeneration', result: png.toString('base64'), savedPath: '/tmp/generated.png' });
  assert.deepEqual(generated, [{ type: 'resultImage', source: 'generated', name: 'generated.png', url: '/tmp/generated.png' }]);
  const fallback = resultImageInputs({ type: 'imageGeneration', result: png.toString('base64') });
  assert.equal(fallback[0].url, dataURL());
  const dynamic = resultImageInputs({ type: 'dynamicToolCall', name: 'render', contentItems: [
    { type: 'inputImage', imageUrl: dataURL(), name: 'Rendered.png' }, { type: 'text', text: '![not](https://example.test/no.png)' },
  ] });
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].source, 'tool');
  const output = resultImageInputs({ type: 'functionCallOutput', output: [{ type: 'input_image', image_url: dataURL() }] });
  assert.equal(output.length, 1);

  const text = [
    `![Visible](<${dataURL()}>)`,
    '![inline code](`data:image/png;base64,' + png.toString('base64') + '`)',
    '```md', `![fenced](data:image/png;base64,${png.toString('base64')})`, '```',
    '[ordinary link](https://example.test/file.png)',
  ].join('\n');
  const markdown = resultImageInputs({ type: 'agentMessage', text });
  assert.equal(markdown.length, 1);
  assert.equal(markdown[0].name, 'Visible');
  const sanitized = stripResultImageSources(text);
  assert(!sanitized.includes(dataURL()));
  assert(sanitized.includes('![inline code]'));
  assert(sanitized.includes('![fenced]'));
  assert(sanitized.includes('[ordinary link]'));
  assert.equal(resultImageInputs({ type: 'agentMessage', text: '`![code](data:image/png;base64,AA==)`' }).length, 0);
  assert.equal(resultImageInputs({ type: 'agentMessage', text: '[link](https://example.test/a.png)' }).length, 0);
});

test('reads local result images only inside the real chat workspace and rejects symlink escapes', async t => {
  const f = await setup(t);
  const workspace = join(f.root, 'workspace');
  const outside = join(f.root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  const imagePath = join(workspace, 'result.png');
  await writeFile(imagePath, png);
  const service = f.create();
  const local = await service.attachments(request([{ type: 'resultImage', source: 'assistant', name: 'Workspace result', url: imagePath }], { cwd: workspace }), f.persist);
  assert.equal(local.attachments[0].availability, 'available');
  assert.equal(local.attachments[0].byteCount, png.length);

  const privatePath = join(outside, 'private.png');
  await writeFile(privatePath, png);
  await symlink(privatePath, join(workspace, 'escape.png'));
  const escaped = await service.attachments(request([{ type: 'resultImage', source: 'assistant', name: 'escape', url: join(workspace, 'escape.png') }], { cwd: workspace }), f.persist);
  assert.equal(escaped.attachments[0].availability, 'unavailable');
  assert.equal(escaped.attachments[0].unavailableReason, 'outside_workspace');
  assert(!JSON.stringify(escaped).includes(privatePath));
});

test('remote hosts may return inline images but their filesystem paths are never read', async t => {
  const f = await setup(t);
  const service = f.create();
  const remoteHost = 'remote-control:env_test';
  const remoteInline = await service.attachments(request([{ type: 'resultImage', source: 'tool', name: 'Inline', url: dataURL() }], { hostId: remoteHost }), f.persist);
  assert.equal(remoteInline.attachments[0].availability, 'available');

  const path = join(f.root, 'remote.png');
  await writeFile(path, png);
  const remoteFile = await service.attachments(request([{ type: 'resultImage', source: 'generated', name: 'Remote file', url: path }], { hostId: remoteHost }), f.persist);
  assert.equal(remoteFile.attachments[0].unavailableReason, 'remote_file_unsupported');
  const networkFile = await service.attachments(request([{ type: 'resultImage', source: 'assistant', name: 'URL', url: 'https://example.test/secret.png' }]), f.persist);
  assert.equal(networkFile.attachments[0].unavailableReason, 'remote_file_unsupported');
});

test('first successful bytes are pinned to host, thread, message, and source across refresh and restart', async t => {
  const f = await setup(t);
  const workspace = join(f.root, 'workspace');
  await mkdir(workspace);
  const path = join(workspace, 'result.png');
  await writeFile(path, png);
  const input = { type: 'resultImage', source: 'assistant', name: 'Pinned', url: path };
  const original = request([input], { cwd: workspace });
  const first = (await f.create().attachments(original, f.persist)).attachments[0];
  const changed = Buffer.from(png); changed[30] = changed[30] ^ 0x01;
  await writeFile(path, changed);

  const second = (await f.create().attachments(original, f.persist)).attachments[0];
  assert.equal(second.assetPath, first.assetPath);
  assert.equal(second.byteCount, png.length);
  assert.equal(f.count(), 1);

  const nextMessage = (await f.create().attachments({ ...original, messageId: 'message-result-2' }, f.persist)).attachments[0];
  assert.equal(nextMessage.byteCount, changed.length);
  assert.equal(f.count(), 2);
  const manifests = await Promise.all((await readdir(join(f.dataDir, 'result-images'))).filter(name => name.endsWith('.json'))
    .map(name => readFile(join(f.dataDir, 'result-images', name), 'utf8')));
  assert.equal(manifests.length, 2);
  assert(manifests.every(value => !value.includes(path) && !value.includes('data:image')));
  assert(manifests.some(value => value.includes('message-result-1')));
  assert(manifests.some(value => value.includes('message-result-2')));
});

test('a generated image path is scoped to generated_images/threadId, with visible size and count limits', async t => {
  const f = await setup(t);
  const generated = join(f.root, 'codex', 'generated_images', thread);
  await mkdir(generated, { recursive: true });
  const generatedPath = join(generated, 'generated.png');
  await writeFile(generatedPath, png);
  const pathImage = await f.create().attachments(request([{ type: 'resultImage', source: 'generated', name: 'Generated', url: generatedPath }]), f.persist);
  assert.equal(pathImage.attachments[0].availability, 'available');

  const many = await f.create().attachments(request(Array.from({ length: 6 }, (_, index) => ({
    type: 'resultImage', source: 'assistant', name: `Image ${index}`, url: dataURL(),
  }))), f.persist);
  assert.equal(many.attachments.length, 4);
  assert.equal(many.omittedAttachmentCount, 2);

  const oversized = await f.create().attachments(request([{ type: 'resultImage', source: 'generated', name: 'Large',
    url: dataURL(Buffer.alloc(10 * 1024 * 1024 + 1)) }] ), f.persist);
  assert.equal(oversized.attachments[0].unavailableReason, 'image_too_large');
});

test('enforces the 24 MiB total and reports malformed data as unavailable', async t => {
  const f = await setup(t);
  const service = f.create();
  const largePng = size => {
    const bytes = Buffer.alloc(size);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    return bytes;
  };
  const large = [9, 9, 9].map((size, index) => ({ type: 'resultImage', source: 'tool', name: `Large ${index}`,
    url: dataURL(largePng(size * 1024 * 1024)) }));
  const result = await service.attachments(request(large), f.persist);
  assert.deepEqual(result.attachments.map(item => item.availability), ['available', 'available', 'unavailable']);
  assert.equal(result.attachments[2].unavailableReason, 'total_size_exceeded');

  const invalid = await service.attachments(request([{ type: 'resultImage', source: 'assistant', name: 'Broken', url: 'data:image/png;base64,not-base64' }]), f.persist);
  assert.equal(invalid.attachments[0].unavailableReason, 'invalid_image');
});


test('concurrent polls share the first immutable image snapshot', async t => {
  const f = await setup(t);
  const workspace = join(f.root, 'workspace');
  await mkdir(workspace);
  const path = join(workspace, 'result.png');
  await writeFile(path, png);
  const service = f.create();
  const input = request([{ type: 'resultImage', source: 'assistant', name: 'Pinned', url: path }], { cwd: workspace });
  const [first, second] = await Promise.all([service.attachments(input, f.persist), service.attachments(input, f.persist)]);
  assert.deepEqual(first, second);
  assert.equal(f.count(), 1, 'Concurrent polls must not take competing snapshots');
});

test('a missing source remains retryable after the file becomes available', async t => {
  const f = await setup(t);
  const workspace = join(f.root, 'workspace');
  await mkdir(workspace);
  const path = join(workspace, 'later.png');
  const input = request([{ type: 'resultImage', source: 'assistant', name: 'Later', url: path }], { cwd: workspace });
  assert.equal((await f.create().attachments(input, f.persist)).attachments[0].unavailableReason, 'image_missing');
  await writeFile(path, png);
  assert.equal((await f.create().attachments(input, f.persist)).attachments[0].availability, 'available');
});

test('a blocked external open cannot stall HTTP and times out without retry after restart', { timeout: 15_000 }, async t => {
  const f = await setup(t);
  const workspace = join(f.root, 'workspace');
  await mkdir(workspace);
  const path = join(workspace, 'blocked.png');
  const fifo = join(f.root, 'blocked-open.fifo');
  const marker = join(f.root, 'opened-pids');
  const permission = join(f.root, 'deny-read');
  await writeFile(permission, 'deny');
  await writeFile(path, png);
  await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
  const blockedPath = await realpath(path);
  const hook = join(f.root, 'block-open.mjs');
  await writeFile(hook, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.openSync;
    fs.openSync = function(path, ...args) {
      if (path === ${JSON.stringify(blockedPath)} && fs.existsSync(${JSON.stringify(permission)})) {
        fs.appendFileSync(${JSON.stringify(marker)}, process.pid + String.fromCharCode(10));
        return original(${JSON.stringify(fifo)}, ...args);
      }
      return original(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const runner = join(f.root, 'server.mjs');
  await writeFile(runner, `
    import { createServer } from 'node:http';
    import { CodexResultImages } from ${JSON.stringify(new URL('../dist/codex-result-images.js', import.meta.url).href)};
    const input = ${JSON.stringify(request([{ type: 'resultImage', source: 'assistant', name: 'Blocked', url: path }], { cwd: workspace }))};
    const create = () => new CodexResultImages({ dataDir: ${JSON.stringify(f.dataDir)}, readTimeoutMs: 1000 });
    const server = createServer(async (req, res) => {
      if (req.url === '/health') { res.end('ok'); return; }
      const result = await create().attachments(req.url === '/new-message' ? { ...input, messageId: 'retry-new-message' } : input,
        (name, mimeType, bytes) => ({ id: 'retried', name, mimeType, availability: 'available', byteCount: bytes.length, assetPath: '/api/codex/assets/retried' }));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    });
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `);
  const child = fork(runner, { execArgv: ['--import', 'tsx', '--import', hook], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    child.kill('SIGKILL');
    for (const pid of (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* The bounded reader can already have exited. */ }
    }
  });
  let childErrors = '';
  child.stderr.on('data', bytes => { childErrors += bytes; });
  const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`Fixture exited ${code}: ${childErrors}`); })]);
  const origin = `http://127.0.0.1:${port}`;
  const watcher = watch(f.root);
  const blocked = new Promise(resolve => watcher.on('change', (_event, name) => { if (name === 'opened-pids') resolve(); }));
  t.after(() => watcher.close());
  const result = fetch(origin + '/snapshot', { signal: AbortSignal.timeout(5000) }).then(res => res.json());
  result.catch(() => {});
  await blocked;
  assert.equal(await fetch(origin + '/health', { signal: AbortSignal.timeout(400) }).then(res => res.text()), 'ok');
  const first = await result;
  assert.equal(first.attachments[0].unavailableReason, 'snapshot_unavailable');
  await rm(permission);
  const second = await fetch(origin + '/snapshot', { signal: AbortSignal.timeout(400) }).then(res => res.json());
  assert.deepEqual(second, first);
  const retried = await fetch(origin + '/new-message', { signal: AbortSignal.timeout(2000) }).then(res => res.json());
  assert.equal(retried.attachments[0].availability, 'available', 'A new message may retry after permissions change');
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1, 'A timed-out source is not reopened on later polls or service recreation');
});
