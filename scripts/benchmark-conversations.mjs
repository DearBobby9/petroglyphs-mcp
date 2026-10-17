import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { CodexConversations } from '../src/codex-conversations.ts';
import { historyMessages, historyTurns } from '../src/codex-conversation-history.ts';

const threadId = '00000000-0000-7000-8000-000000000001';
const requested = Number(process.env.BENCH_TURNS ?? 2000);
const iterations = Number(process.env.BENCH_ITERATIONS ?? 15);
if (!Number.isInteger(requested) || requested < 1 || requested > 20000 || !Number.isInteger(iterations) || iterations < 3 || iterations > 100) {
  throw new Error('BENCH_TURNS must be 1–20000 and BENCH_ITERATIONS 3–100.');
}
const makeTurn = index => ({ turnId: `00000000-0000-7000-8000-${String(index + 2).padStart(12, '0')}`,
  status: 'completed', items: [
    { id: `user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Request ${index}: ` + 'diagram '.repeat(40) }] },
    { id: `work-${index}`, type: 'commandExecution', aggregatedOutput: 'private tool output '.repeat(40) },
    { id: `reply-${index}`, type: 'agentMessage', phase: 'final_answer', text: `Result ${index}: ` + 'response '.repeat(120) },
  ] });
let state = { id: threadId, hostId: 'local', resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' },
  requests: [], turns: Array.from({ length: requested }, (_, index) => makeTurn(index)) };
let payload = JSON.stringify(state), revision = 1, ownerClientId = 'benchmark-owner', reads = 0;
let readMs = 0;
const connection = { close() {}, async startMessageTurn() { throw new Error('Benchmark never sends'); },
  async readSnapshot(hostId, id) {
    const started = performance.now();
    const conversationState = JSON.parse(payload);
    readMs += performance.now() - started; reads++;
    return { hostId, threadId: id, conversationState, ownerClientId, revision };
  } };
const dir = await mkdtemp(join(tmpdir(), 'petroglyphs-history-benchmark-'));
let service;
const metrics = [];
const open = () => service = new CodexConversations({ dataDir: dir, connect: async () => connection,
  requireTarget: async () => {}, retryMs: 60_000,
  onHistoryRead: metric => metrics.push(metric),
  ...(process.env.BENCH_CACHE === '0' ? { historyCacheBytes: 0 } : {}) });
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 1000) / 1000;
try {
  open();
  const conversion = [], serialization = [], total = [], payloadBytes = Buffer.byteLength(payload);
  let responseBytes = 0, responseWire = '';
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    historyMessages(historyTurns(state, threadId));
    conversion.push(performance.now() - start);
  }
  const initialPage = await service.conversation('local', threadId); // Warm the same page in each implementation.
  readMs = 0; reads = 0; metrics.length = 0;
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    const page = await service.conversation('local', threadId);
    if (JSON.stringify(page.messages) !== JSON.stringify(initialPage.messages)) throw new Error('Unchanged snapshot altered visible messages');
    const serializeStart = performance.now();
    const wire = JSON.stringify(page);
    responseWire = wire;
    serialization.push(performance.now() - serializeStart);
    responseBytes = Buffer.byteLength(wire);
    total.push(performance.now() - start);
  }
  const unchangedReadMs = readMs, unchangedReads = reads, unchangedMetrics = [...metrics];
  const transfer = [];
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(responseWire); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await fetch(url).then(response => response.arrayBuffer());
    for (let index = 0; index < iterations; index++) {
      const start = performance.now();
      const bytes = await fetch(url).then(response => response.arrayBuffer());
      if (bytes.byteLength !== responseBytes) throw new Error('Incomplete HTTP transfer');
      transfer.push(performance.now() - start);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  state.turns.push(makeTurn(requested)); revision++; payload = JSON.stringify(state);
  const changedStart = performance.now();
  const changed = await service.conversation('local', threadId);
  const changedMs = performance.now() - changedStart;
  if (!changed.messages.at(-1)?.text.startsWith(`Result ${requested}:`)) throw new Error('Incremental snapshot did not update history');
  service.close(); ownerClientId = 'replacement-owner'; revision = 1; open();
  const restartStart = performance.now();
  const recovered = await service.conversation('local', threadId);
  const restartMs = performance.now() - restartStart;
  if (recovered.messages.at(-1)?.id !== changed.messages.at(-1)?.id) throw new Error('Restart changed stable history identity');
  const result = { node: process.version, turns: requested, iterations, snapshotBytes: payloadBytes, responseBytes,
    cacheEnabled: process.env.BENCH_CACHE !== '0',
    unchanged: { upstreamReads: unchangedReads, meanReadAndParseMs: round(unchangedReadMs / unchangedReads),
      projectionCacheHits: unchangedMetrics.filter(metric => metric.cacheHit).length,
      measuredConversionMeanMs: round(unchangedMetrics.reduce((sum, metric) => sum + metric.conversionMs, 0) / iterations),
      uncachedConversionMedianMs: round(median(conversion)), responseSerializationMedianMs: round(median(serialization)),
      loopbackTransferMedianMs: round(median(transfer)),
      totalMedianMs: round(median(total)) },
    changedSnapshotMs: round(changedMs), restartSnapshotMs: round(restartMs),
    correctness: { unchanged: true, appendedTurn: true, restartAndOwnerChange: true },
    boundary: 'Synthetic full-snapshot parse, conversion, JSON serialization and loopback HTTP transfer. LAN, Tailscale and iPad rendering are not measured.' };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { service?.close(); await rm(dir, { recursive: true, force: true }); }
