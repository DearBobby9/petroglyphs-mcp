import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { CodexDesktopIpcError, type MessageTurn } from './codex-desktop-ipc.js';
import { ConversationError, imageBytes, isCodexHost, messageFingerprint, parseMessageInput } from './codex-message-input.js';
import { conversationRunState, historyMessages, historyTurns, record, type ConversationAttachment,
  type ConversationMessage, type HistoryMessage, type HistoryTurn } from './codex-conversation-history.js';
import { CodexRoutingError, isThreadId } from './codex-threads.js';

export interface ConversationConnection {
  readSnapshot(hostId: string, threadId: string): Promise<{ hostId: string; threadId: string; conversationState: unknown }>;
  startMessageTurn(input: MessageTurn): Promise<{ turnId: string; clientUserMessageId: string }>;
  close(): void;
}
export interface MessageReceipt {
  id: string; hostId: string; threadId: string; createdAt: string; updatedAt: string;
  state: ConversationMessage['state']; turnId?: string; message: ConversationMessage; error?: string; notice?: string;
}
export interface ConversationPage {
  hostId: string; threadId: string; messages: ConversationMessage[]; beforeCursor: string | null;
  runState: ReturnType<typeof conversationRunState>; receipts: MessageReceipt[]; updatedAt: string;
}
interface Options {
  dataDir: string;
  legacyDataDir?: string;
  connect: () => Promise<ConversationConnection>;
  requireTarget: (hostId: string, threadId: string) => Promise<unknown>;
  verifiedFirstMessage?: (hostId: string, threadId: string) => {
    id: string; turnId: string; sourceMessageId?: string; text: string; createdAt: string;
  } | undefined;
  retryMs?: number;
}
const uuid = z.string().refine(isThreadId);
const host = z.string().refine(isCodexHost);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const savedAttachmentSchema = z.object({ id: uuid, name: z.string().min(1).max(200), mimeType: z.enum(['image/png', 'image/jpeg']), assetId: sha });
const jobSchema = z.object({
  version: z.literal(1), id: uuid, hostId: host, threadId: uuid, fingerprint: sha, text: z.string().max(20_000),
  attachments: z.array(savedAttachmentSchema).max(4), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  state: z.enum(['pending', 'dispatching', 'queued', 'running', 'completed', 'failed', 'unknown']),
  turnId: z.string().optional(), observedMessageId: z.string().optional(), turnFinished: z.boolean().optional(),
  error: z.string().optional(), notice: z.string().optional(),
}).strict();
type Job = z.infer<typeof jobSchema>;
const assetSchema = z.object({ id: sha, hostId: host, threadId: uuid, name: z.string().max(200),
  mimeType: z.enum(['image/png', 'image/jpeg']), byteCount: z.number().int().min(1).max(10 * 1024 * 1024) }).strict();
type Asset = z.infer<typeof assetSchema>;
const cursorSchema = z.object({ v: z.literal(1), hostId: host, threadId: uuid, id: z.string().min(1).max(256) }).strict();
const targetKey = (hostId: string, threadId: string) => `${hostId}\0${threadId}`;
const unfinished = (job: Job) => !job.turnFinished && !['completed', 'failed'].includes(job.state);

export function validateConversationTarget(hostId: unknown, threadId: unknown): asserts hostId is string {
  if (!isCodexHost(hostId) || !isThreadId(threadId)) throw new ConversationError('Select a valid Codex connection and chat.', 400, 'invalid_target');
}

/** Paired chat messages use an append-only queue, never Desktop queue replacement. */
export class CodexConversations {
  private readonly jobs = new Map<string, Job>();
  private readonly assets = new Map<string, Asset>();
  private readonly reads = new Map<string, Promise<{ state: unknown; turns: HistoryTurn[]; messages: HistoryMessage[] }>>();
  private readonly jobsDir: string;
  private readonly assetsDir: string;
  private connection?: Promise<ConversationConnection>;
  private draining?: Promise<void>;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.dataDir) || (options.legacyDataDir && !isAbsolute(options.legacyDataDir))) throw new Error('Conversation data directory must be absolute');
    this.jobsDir = join(options.dataDir, 'messages');
    this.assetsDir = join(options.dataDir, 'assets');
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.assetsDir, { recursive: true, mode: 0o700 });
    for (const filename of readdirSync(this.assetsDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const asset = assetSchema.parse(JSON.parse(readFileSync(join(this.assetsDir, filename), 'utf8')));
      if (filename !== `${asset.id}.json`) throw new Error('Invalid conversation asset');
      this.assets.set(asset.id, asset);
    }
    const loaded = readdirSync(this.jobsDir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(filename => {
      const job = jobSchema.parse(JSON.parse(readFileSync(join(this.jobsDir, filename), 'utf8')));
      if (filename !== `${job.id}.json` || job.attachments.some(attachment => {
        const asset = this.assets.get(attachment.assetId);
        return !asset || asset.hostId !== job.hostId || asset.threadId !== job.threadId;
      })) throw new Error('Invalid conversation receipt');
      if (job.state === 'dispatching') {
        job.state = 'unknown'; job.notice = 'The service restarted during delivery. Checking the original chat without sending again.';
        this.save(job);
      }
      return job;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    loaded.forEach(job => this.jobs.set(job.id, job));
    this.timer = setInterval(() => { void this.drain(); }, options.retryMs ?? 3000);
    this.timer.unref();
    setImmediate(() => { void this.drain(); });
  }

  private save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    const path = join(this.jobsDir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  private connect(): Promise<ConversationConnection> {
    return this.connection ??= this.options.connect().catch(error => { this.connection = undefined; throw error; });
  }

  private reset(): void {
    const previous = this.connection; this.connection = undefined;
    void previous?.then(connection => connection.close()).catch(() => {});
  }

  private persistAsset(hostId: string, threadId: string, name: string, mimeType: 'image/png' | 'image/jpeg', bytes: Buffer): Asset {
    const id = createHash('sha256').update(`${hostId}\0${threadId}\0${mimeType}\0`).update(bytes).digest('hex');
    const known = this.assets.get(id);
    if (known) return known;
    const asset: Asset = { id, hostId, threadId, name, mimeType, byteCount: bytes.length };
    writeFileSync(join(this.assetsDir, `${id}.image`), bytes, { mode: 0o600 });
    const path = join(this.assetsDir, `${id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(asset), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.assets.set(id, asset);
    return asset;
  }

  private attachment(asset: Asset, id = asset.id, name = asset.name): ConversationAttachment {
    return { id, name, mimeType: asset.mimeType, byteCount: asset.byteCount, availability: 'available',
      assetPath: `/api/codex/assets/${asset.id}?${new URLSearchParams({ hostId: asset.hostId, threadId: asset.threadId })}` };
  }

  private message(job: Job): ConversationMessage {
    return { id: job.observedMessageId ?? `client:${job.id}`, clientMessageId: job.id,
      ...(job.turnId ? { turnId: job.turnId } : {}), role: 'user', text: job.text, phase: 'user',
      createdAt: job.createdAt, state: job.state, attachments: job.attachments.map(attachment =>
        this.attachment(this.assets.get(attachment.assetId)!, attachment.id, attachment.name)) };
  }

  private receipt(job: Job): MessageReceipt {
    return { id: job.id, hostId: job.hostId, threadId: job.threadId, createdAt: job.createdAt, updatedAt: job.updatedAt,
      state: job.state, ...(job.turnId ? { turnId: job.turnId } : {}), message: this.message(job),
      ...(job.error ? { error: job.error } : {}), ...(job.notice ? { notice: job.notice } : {}) };
  }

  async accept(value: unknown): Promise<{ receipt: MessageReceipt; duplicate: boolean }> {
    const input = parseMessageInput(value);
    const fingerprint = messageFingerprint(input);
    const existing = () => {
      const job = this.jobs.get(input.id);
      if (job && job.fingerprint !== fingerprint) throw new ConversationError('This message ID was already used for different content or a different chat.', 409, 'id_conflict');
      return job;
    };
    const first = existing();
    if (first) return { receipt: this.receipt(first), duplicate: true };
    await this.options.requireTarget(input.hostId, input.threadId);
    // Target lookup is asynchronous; a concurrent HTTP retry may already have
    // persisted this UUID while it was in flight.
    const second = existing();
    if (second) return { receipt: this.receipt(second), duplicate: true };
    const pending = [...this.jobs.values()].filter(unfinished);
    if (pending.length >= 1000 || pending.filter(job => job.hostId === input.hostId && job.threadId === input.threadId).length >= 100) {
      throw new ConversationError('Too many messages are waiting. Let the existing messages finish before sending more.', 429, 'queue_full');
    }
    const now = new Date().toISOString();
    const job: Job = { version: 1, id: input.id, hostId: input.hostId, threadId: input.threadId, text: input.text,
      fingerprint, createdAt: now, updatedAt: now, state: 'pending', attachments: input.attachments.map(attachment => ({
        id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
        assetId: this.persistAsset(input.hostId, input.threadId, attachment.name, attachment.mimeType,
          imageBytes(attachment.dataBase64, attachment.mimeType)).id,
      })) };
    this.save(job); this.jobs.set(job.id, job);
    setImmediate(() => { void this.drain(); });
    return { receipt: this.receipt(job), duplicate: false };
  }

  async get(hostId: string, threadId: string, id: string): Promise<MessageReceipt> {
    validateConversationTarget(hostId, threadId);
    const job = this.jobs.get(id);
    if (!isThreadId(id) || !job || job.hostId !== hostId || job.threadId !== threadId) {
      throw new ConversationError('This message was not accepted for the selected chat.', 404, 'message_not_found');
    }
    if (['queued', 'running', 'unknown'].includes(job.state)) {
      // Durable admission remains readable while Desktop is temporarily offline.
      try { await this.read(hostId, threadId); }
      catch { job.notice = 'Codex is temporarily unavailable. The original delivery is still being checked.'; this.save(job); }
    }
    return this.receipt(job);
  }

  asset(hostId: string, threadId: string, id: string): { bytes: Buffer; mimeType: string } {
    validateConversationTarget(hostId, threadId);
    const asset = this.assets.get(id);
    if (!asset || asset.hostId !== hostId || asset.threadId !== threadId) throw new ConversationError('This image is not available for the selected chat.', 404, 'asset_not_found');
    const path = join(this.assetsDir, `${asset.id}.image`);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size !== asset.byteCount) throw new Error('Invalid asset');
      return { bytes: readFileSync(path), mimeType: asset.mimeType };
    } catch { throw new ConversationError('This image is no longer available.', 404, 'asset_not_found'); }
  }

  private read(hostId: string, threadId: string): Promise<{ state: unknown; turns: HistoryTurn[]; messages: HistoryMessage[] }> {
    const key = targetKey(hostId, threadId);
    const current = this.reads.get(key);
    if (current) return current;
    const promise = (async () => {
      await this.options.requireTarget(hostId, threadId);
      const snapshot = await (await this.connect()).readSnapshot(hostId, threadId);
      if (snapshot.hostId !== hostId || snapshot.threadId !== threadId) throw new ConversationError('Codex returned a different chat.', 503, 'invalid_snapshot');
      const turns = historyTurns(snapshot.conversationState, threadId);
      const messages = historyMessages(turns);
      const first = this.options.verifiedFirstMessage?.(hostId, threadId);
      const firstTurn = first && turns.find(turn => turn.id === first.turnId);
      if (first && firstTurn) {
        const original = first.sourceMessageId && messages.find(message => message.id === first.sourceMessageId && message.role === 'user');
        if (original) { original.text = first.text; original.clientMessageId = first.id; }
        else if (!first.sourceMessageId) {
          // Only a durably verified create request can expose an initial
          // toolOutput as user text. All unrelated tool outputs stay private.
          const next = messages.findIndex(message => message.turnId === first.turnId);
          messages.splice(next < 0 ? 0 : next, 0, { id: `project:${first.id}`, clientMessageId: first.id,
            turnId: first.turnId, role: 'user', phase: 'user', text: first.text, createdAt: first.createdAt,
            state: firstTurn.status === 'inProgress' ? 'running' : firstTurn.status === 'failed' ? 'failed'
              : firstTurn.status === 'completed' ? 'completed' : 'unknown', attachments: [], imageInputs: [] });
        }
      }
      this.reconcile(hostId, threadId, turns, messages);
      return { state: snapshot.conversationState, turns, messages };
    })().catch(error => { this.reset(); throw error; }).finally(() => this.reads.delete(key));
    this.reads.set(key, promise);
    return promise;
  }

  private reconcile(hostId: string, threadId: string, turns: HistoryTurn[], messages: HistoryMessage[]): void {
    for (const job of this.jobs.values()) {
      if (job.hostId !== hostId || job.threadId !== threadId) continue;
      const message = messages.find(message => message.role === 'user' && message.clientMessageId === job.id);
      const turn = turns.find(turn => turn.id === (message?.turnId ?? job.turnId));
      if (!turn || job.state === 'pending') continue;
      const before = JSON.stringify(job);
      job.turnId = turn.id;
      if (message) job.observedMessageId = message.id;
      job.turnFinished = ['completed', 'failed', 'interrupted'].includes(turn.status);
      job.state = turn.status === 'completed' ? 'completed' : turn.status === 'inProgress' ? 'running'
        : turn.status === 'failed' ? 'failed' : 'unknown';
      job.error = turn.status === 'failed' ? 'Codex could not complete this response. Check this chat on the Mac for details.' : undefined;
      job.notice = turn.status === 'interrupted' ? 'Codex has not confirmed a completed response. You can continue the conversation.' : undefined;
      if (JSON.stringify(job) !== before) this.save(job);
    }
  }

  private legacyAsset(message: HistoryMessage, hostId: string, threadId: string): ConversationAttachment | undefined {
    if (!message.legacyDrawingId || !isThreadId(message.legacyDrawingId) || !this.options.legacyDataDir) return;
    const root = hostId === 'local' ? this.options.legacyDataDir : join(this.options.legacyDataDir, 'remote-desktop');
    try {
      const id = message.legacyDrawingId;
      const job = record(JSON.parse(readFileSync(join(root, `${id}.json`), 'utf8')));
      if (job?.id !== id || job.threadId !== threadId || (hostId !== 'local' && job.hostId !== hostId)) return;
      const path = join(root, `${id}.png`);
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) return;
      const bytes = imageBytes(readFileSync(path).toString('base64'), 'image/png');
      return this.attachment(this.persistAsset(hostId, threadId, 'Canvas.png', 'image/png', bytes));
    } catch { return; }
  }

  private publicMessage(message: HistoryMessage, hostId: string, threadId: string): ConversationMessage {
    const { imageInputs, legacyDrawingId, ...safe } = message;
    const job = message.clientMessageId ? this.jobs.get(message.clientMessageId) : undefined;
    if (job && job.hostId === hostId && job.threadId === threadId) return { ...safe, ...this.message(job), id: message.id };
    const legacy = this.legacyAsset(message, hostId, threadId);
    if (legacy) return { ...safe, attachments: [legacy] };
    const inputs = imageInputs.length > 0 ? imageInputs : legacyDrawingId ? [{}] : [];
    safe.attachments = inputs.slice(0, 16).map((input, index) => {
      const value = record(input);
      const url = value?.url;
      const name = `Image ${index + 1}`;
      if (typeof url === 'string' && url.length <= 14 * 1024 * 1024) {
        const match = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(url);
        if (match) {
          try {
            const mimeType = match[1] as 'image/png' | 'image/jpeg';
            return this.attachment(this.persistAsset(hostId, threadId, name, mimeType, imageBytes(match[2], mimeType)), `${message.id}:image:${index}`);
          } catch { /* Unrecoverable historical images are shown as explicit placeholders. */ }
        }
      }
      return { id: `${message.id}:image:${index}`, name, mimeType: 'image/unknown', availability: 'unavailable' as const };
    });
    return safe;
  }

  async conversation(hostId: string, threadId: string, options: { before?: string; limit?: number } = {}): Promise<ConversationPage> {
    validateConversationTarget(hostId, threadId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ConversationError('Message page size must be between 1 and 100.', 400, 'invalid_limit');
    let before: z.infer<typeof cursorSchema> | undefined;
    if (options.before !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,2048}$/.test(options.before)) throw new Error();
        before = cursorSchema.parse(JSON.parse(Buffer.from(options.before, 'base64url').toString('utf8')));
        if (before.hostId !== hostId || before.threadId !== threadId) throw new Error();
      } catch { throw new ConversationError('The history cursor does not match the selected chat. Refresh the conversation.', 400, 'invalid_cursor'); }
    }
    const snapshot = await this.read(hostId, threadId);
    const jobs = [...this.jobs.values()].filter(job => job.hostId === hostId && job.threadId === threadId);
    const observed = new Set(snapshot.messages.map(message => message.clientMessageId));
    const messages: Array<HistoryMessage | ConversationMessage> = [...snapshot.messages];
    for (const job of jobs.filter(job => !observed.has(job.id) && !job.observedMessageId)) {
      const message = this.message(job);
      const next = messages.findIndex(item => item.createdAt !== null && item.createdAt > job.createdAt);
      messages.splice(next < 0 ? messages.length : next, 0, message);
    }
    const end = before ? messages.findIndex(message => message.id === before!.id) : messages.length;
    if (end < 0) throw new ConversationError('This history page changed. Refresh the conversation.', 409, 'stale_cursor');
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end).map(message => 'imageInputs' in message ? this.publicMessage(message, hostId, threadId) : message);
    const receipts = jobs.filter((job, index) => unfinished(job) || index >= jobs.length - 50).map(job => this.receipt(job));
    return { hostId, threadId, messages: page,
      beforeCursor: start > 0 ? Buffer.from(JSON.stringify({ v: 1, hostId, threadId, id: messages[start].id })).toString('base64url') : null,
      runState: conversationRunState(snapshot.state), receipts, updatedAt: new Date().toISOString() };
  }

  private drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = this.processQueue().catch(() => {
      console.error('[petroglyphs] Conversation queue processing is temporarily unavailable.');
    }).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async processQueue(): Promise<void> {
    // One candidate per target per pass keeps a busy chat from rechecking the
    // same snapshot for every queued message, while other targets can proceed.
    const targets = new Map<string, Job[]>();
    for (const job of this.jobs.values()) {
      if (!unfinished(job)) continue;
      const key = targetKey(job.hostId, job.threadId);
      targets.set(key, [...targets.get(key) ?? [], job]);
    }
    for (const jobs of targets.values()) {
      if (this.closed) return;
      let first = jobs[0];
      if (first.state !== 'pending') {
        try { await this.read(first.hostId, first.threadId); } catch { continue; }
        const next = jobs.find(unfinished);
        if (!next || next.state !== 'pending') continue;
        first = next;
      }
      let connection: ConversationConnection;
      try {
        await this.options.requireTarget(first.hostId, first.threadId);
        connection = await this.connect();
      } catch (error) {
        if (error instanceof CodexRoutingError && [400, 404].includes(error.status)) {
          first.state = 'failed'; first.error = 'The selected chat is no longer available. Refresh the chat selector.';
        } else first.notice = 'Waiting for the selected Codex connection.';
        this.save(first); continue;
      }
      if (this.closed) return;
      let attachments: MessageTurn['attachments'];
      try {
        attachments = first.attachments.map(attachment => ({ mimeType: attachment.mimeType,
          dataBase64: this.asset(first.hostId, first.threadId, attachment.assetId).bytes.toString('base64') }));
      } catch {
        first.state = 'failed'; first.error = 'An attached image is no longer available. Add the image to a new message.';
        this.save(first); continue;
      }
      // Persist before crossing the mutating socket boundary. A crash here must
      // recover as unknown, never as an automatic second dispatch.
      first.state = 'dispatching'; delete first.notice; this.save(first);
      try {
        const result = await connection.startMessageTurn({ hostId: first.hostId, threadId: first.threadId,
          clientUserMessageId: first.id, text: first.text, attachments });
        if (result.clientUserMessageId !== first.id || !isThreadId(result.turnId)) throw new Error('Invalid receipt');
        first.turnId = result.turnId;
        if (first.state === 'dispatching') { first.state = 'queued'; delete first.error; }
      } catch (error) {
        // A concurrent history poll can observe the accepted turn before the
        // native start call times out. Keep that stronger delivery evidence.
        if (first.state !== 'dispatching') continue;
        if (error instanceof CodexDesktopIpcError && error.outcome === 'not_sent') {
          if ([400, 404, 413].includes(error.status)) {
            first.state = 'failed'; first.error = 'Codex could not accept this message. Refresh the selected chat before trying again.';
          } else {
            first.state = 'pending'; first.notice = error.status === 409 ? 'Waiting for the current Codex response to finish.' : 'Waiting for the selected Codex connection.';
          }
          if (error.status !== 409) this.reset();
        } else {
          first.state = 'unknown'; first.notice = 'Checking delivery in the original chat. This message will not be sent again automatically.';
          this.reset();
        }
      }
      this.save(first);
    }
  }

  close(): void { this.closed = true; clearInterval(this.timer); this.reset(); }
}
