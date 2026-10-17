import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { connect as connectSocket, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isThreadId } from './codex-threads.js';
import { imageBytes, MAX_ATTACHMENT_BYTES } from './codex-message-input.js';

const remoteHostPattern = /^remote-control:env_[A-Za-z0-9_-]{1,128}$/;
const methodVersions = {
  initialize: 0,
  'thread-follower-read-model-settings': 1,
  'thread-follower-load-complete-history': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-interrupt-turn': 4,
} as const;
type RequestMethod = keyof typeof methodVersions;
type JsonObject = Record<string, unknown>;
type Delivery = 'not-sent' | 'unknown';
export type DesktopIpcErrorCode = 'desktop_unavailable' | 'owner_unavailable' | 'follower_timeout'
  | 'request_timeout' | 'connection_closed' | 'protocol_mismatch' | 'desktop_rejected' | 'invalid_receipt'
  | 'invalid_model_selection' | 'model_settings_unavailable' | 'capability_unverified';

export class CodexDesktopIpcError extends Error {
  readonly outcome: 'not_sent' | 'unknown';
  /** A fixed diagnostic category. Desktop error text can contain private data. */
  constructor(message: string, readonly status = 503, readonly delivery: Delivery = 'not-sent',
    readonly code: DesktopIpcErrorCode = 'desktop_unavailable') {
    super(message); this.outcome = delivery === 'not-sent' ? 'not_sent' : 'unknown';
  }
}

export interface DesktopSnapshot {
  hostId: string;
  threadId: string;
  ownerClientId: string;
  revision: number;
  /** Internal desktop state. Never return this object from an HTTP API. */
  conversationState: JsonObject;
}

const settingsSchema = z.object({
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  daybreakEnabled: z.boolean().nullable().optional(),
  resumeState: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  threadSource: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
});
export type DesktopModelSettings = z.infer<typeof settingsSchema>;
/** A host-validated pair, fixed when its message is accepted. No implicit defaults. */
export interface CodexModelSelection { readonly model: string; readonly reasoningEffort: string }
export interface NativeInitialModelSettings { readonly model: string; readonly reasoningEffort: string | null }
const modelSelectionSchema = z.object({
  model: z.string().refine(value => settingValue(value, 256)),
  reasoningEffort: z.string().refine(value => settingValue(value, 64)),
}).strict();
/** Native turn parameters and any observed reroutes; never inferred from current chat settings. */
export interface DesktopTurnModelEvidence {
  model: string;
  reasoningEffort: string | null;
  reroutes: Array<{ fromModel: string; toModel: string; reason: string }>;
}
export interface ImageTurn {
  hostId: string;
  threadId: string;
  submissionId: string;
  imageBase64: string;
  prompt: string;
  selection?: CodexModelSelection;
}
export interface ImageTurnReceipt { turnId: string; clientUserMessageId: string }
export interface DesktopInterruptTarget { hostId: string; threadId: string; turnId: string }
export interface DesktopInterruptReceipt { interruptedTurnId: string | null }
export interface MessageTurn {
  hostId: string;
  threadId: string;
  clientUserMessageId: string;
  text: string;
  attachments: Array<{ mimeType: 'image/png' | 'image/jpeg'; dataBase64: string }>;
  selection?: CodexModelSelection;
  /** Internal native-creation defaults. Null preserves the native unset effort; never accepted by HTTP routes. */
  initialModelSettings?: NativeInitialModelSettings;
}

interface Options { socketPath?: string; timeoutMs?: number; maxFrameBytes?: number }
interface Response { result: unknown; handledByClientId?: string }
interface Pending {
  method: RequestMethod;
  mutating: boolean;
  written: boolean;
  timer: NodeJS.Timeout;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}
interface Entry {
  hostId: string;
  threadId: string;
  references: number;
  snapshot?: DesktopSnapshot;
  refreshing?: Promise<DesktopSnapshot>;
  listeners: Set<(snapshot: DesktopSnapshot) => void>;
  errors: Set<(error: CodexDesktopIpcError) => void>;
  waiters: Set<{ owner: string; revision: number; resolve: (snapshot: DesktopSnapshot) => void;
    reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function settingValue(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function selectedCollaborationMode(state: JsonObject, selection: NativeInitialModelSettings): JsonObject {
  const threadSettings = object(state.latestThreadSettings) ? state.latestThreadSettings : undefined;
  // Match Desktop's precedence. latestCollaborationMode may omit instructions
  // that remain present in latestThreadSettings.collaborationMode.
  const current = threadSettings?.collaborationMode ?? state.latestCollaborationMode;
  if (!object(current) || !settingValue(current.mode, 64) || !object(current.settings)
    || (current.settings.developer_instructions !== null && typeof current.settings.developer_instructions !== 'string')) {
    throw new CodexDesktopIpcError('Codex could not preserve this chat’s model instructions. Refresh the chat before sending.',
      503, 'not-sent', 'model_settings_unavailable');
  }
  const mode = structuredClone(current);
  mode.settings = { ...mode.settings as JsonObject, model: selection.model, reasoning_effort: selection.reasoningEffort };
  return mode;
}

export function readTurnModelEvidence(value: unknown): DesktopTurnModelEvidence | undefined {
  if (!object(value) || !object(value.params) || !Array.isArray(value.items)) return;
  const params = value.params;
  let model = params.model, effort = params.effort;
  if (params.collaborationMode != null) {
    const mode = params.collaborationMode;
    if (!object(mode) || !object(mode.settings)) return;
    model = mode.settings.model;
    effort = mode.settings.reasoning_effort;
    if ((params.model != null && params.model !== model) || (params.effort != null && params.effort !== effort)) return;
  }
  if (!settingValue(model, 256) || (effort != null && !settingValue(effort, 64))) return;
  const reroutes: DesktopTurnModelEvidence['reroutes'] = [];
  for (const item of value.items) {
    if (!object(item) || item.type !== 'modelRerouted') continue;
    // A malformed reroute cannot establish that the original model ran.
    if (!settingValue(item.fromModel, 256) || !settingValue(item.toModel, 256) || !settingValue(item.reason, 256)) return;
    reroutes.push({ fromModel: item.fromModel, toModel: item.toModel, reason: item.reason });
  }
  return { model, reasoningEffort: typeof effort === 'string' ? effort : null, reroutes };
}

function target(hostId: string, threadId: string): void {
  if ((hostId !== 'local' && !remoteHostPattern.test(hostId)) || !isThreadId(threadId)) {
    throw new CodexDesktopIpcError('A valid Codex connection and chat are required.', 400);
  }
}
function key(hostId: string, threadId: string): string { return `${hostId}\0${threadId}`; }
function safeError(error: unknown): CodexDesktopIpcError {
  return error instanceof CodexDesktopIpcError ? error : new CodexDesktopIpcError('Codex Desktop is unavailable. Open the selected connection and try again.');
}
function desktopErrorCode(error: unknown, method: RequestMethod): DesktopIpcErrorCode {
  if (error === 'no-client-found') return 'owner_unavailable';
  if (method.startsWith('thread-follower-') && error === `${method}-timeout`) return 'follower_timeout';
  if (error === 'request-timeout') return 'request_timeout';
  if (error === 'client-disconnected' || error === 'server-closed') return 'connection_closed';
  if (error === 'request-version-mismatch' || error === 'no-handler-for-request'
    || error === 'thread-follower-response-method-mismatch') return 'protocol_mismatch';
  return 'desktop_rejected';
}

export function isDesktopBusy(state: JsonObject): boolean {
  if ((object(state.threadRuntimeStatus) && state.threadRuntimeStatus.type === 'active')
    || state.resumeState === 'resuming'
    || (Array.isArray(state.unconfirmedTurnSubmissions) && state.unconfirmedTurnSubmissions.length > 0)
    || (Array.isArray(state.requests) && state.requests.length > 0)) return true;
  const turns: unknown[] = Array.isArray(state.turns) ? [...state.turns] : [];
  if (object(state.turnHistory) && object(state.turnHistory.history) && object(state.turnHistory.history.entitiesByKey)) {
    turns.push(...Object.values(state.turnHistory.history.entitiesByKey));
  }
  return turns.some(turn => object(turn) && turn.status === 'inProgress');
}

// Desktop publishes Immer JSON patches. Implement only its JSON object/array
// operations, with no prototype keys or implicit creation of missing parents.
function patched(state: JsonObject, patches: unknown): JsonObject {
  if (!Array.isArray(patches) || patches.length > 20_000) throw new Error('Invalid patches');
  let next: unknown = structuredClone(state);
  for (const patch of patches) {
    if (!object(patch) || !['add', 'remove', 'replace'].includes(String(patch.op)) || !Array.isArray(patch.path)
      || patch.path.length > 100 || patch.path.some(part => (typeof part !== 'string' && typeof part !== 'number')
        || ['__proto__', 'constructor', 'prototype'].includes(String(part)))) throw new Error('Invalid patch');
    const path = patch.path as Array<string | number>;
    if (path.length === 0) {
      if (patch.op === 'remove') throw new Error('Invalid root removal');
      next = structuredClone(patch.value);
      continue;
    }
    let parent: unknown = next;
    for (const part of path.slice(0, -1)) {
      if ((!object(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, part)) throw new Error('Missing patch parent');
      parent = (parent as JsonObject)[part];
    }
    const property = path.at(-1)!;
    if (Array.isArray(parent)) {
      if (property === 'length' && patch.op === 'replace' && Number.isSafeInteger(patch.value)
        && (patch.value as number) >= 0 && (patch.value as number) <= parent.length) {
        parent.length = patch.value as number;
        continue;
      }
      if (typeof property !== 'number' || !Number.isSafeInteger(property) || property < 0
        || property > parent.length || (patch.op !== 'add' && property === parent.length)) throw new Error('Invalid patch index');
      if (patch.op === 'add') parent.splice(property, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') parent.splice(property, 1);
      else parent[property] = structuredClone(patch.value);
    } else if (object(parent) && typeof property === 'string') {
      if (patch.op !== 'add' && !Object.hasOwn(parent, property)) throw new Error('Missing patch property');
      if (patch.op === 'remove') delete parent[property];
      else parent[property] = structuredClone(patch.value);
    } else throw new Error('Invalid patch parent');
  }
  if (!object(next)) throw new Error('Invalid patched state');
  return next;
}

export class CodexDesktopIpc {
  private clientId = 'initializing-client';
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private readonly entries = new Map<string, Entry>();
  private readonly sending = new Set<string>();
  private closed = false;

  private constructor(private readonly socket: Socket, private readonly timeoutMs: number, private readonly maxFrameBytes: number) {
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }

  static async connect(options: Options = {}): Promise<CodexDesktopIpc> {
    const socketPath = options.socketPath ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'ipc', 'ipc.sock');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
    try {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error('Unix IPC required');
      const [directory, endpoint] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)]);
      if (!directory.isDirectory() || !endpoint.isSocket() || [directory, endpoint].some(info => info.uid !== uid || (info.mode & 0o077) !== 0)) {
        throw new Error('IPC endpoint must be private and owned by this user');
      }
      const socket = connectSocket(socketPath);
      const client = new CodexDesktopIpc(socket, timeoutMs, maxFrameBytes);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { socket.destroy(); reject(new Error('Connect timeout')); }, timeoutMs);
          socket.once('connect', () => { clearTimeout(timer); resolve(); });
          socket.once('error', () => { clearTimeout(timer); reject(new Error('Connect failed')); });
        });
        const response = await client.request('initialize', { clientType: 'petroglyphs' });
        if (!object(response.result) || typeof response.result.clientId !== 'string' || !response.result.clientId) throw new Error('Invalid identity');
        client.clientId = response.result.clientId;
        return client;
      } catch (error) { client.close(); throw error; }
    } catch (error) { throw safeError(error); }
  }

  private write(value: unknown): void {
    if (this.closed || !this.socket.writable) throw new CodexDesktopIpcError('Codex Desktop disconnected. Reconnect before sending.');
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > this.maxFrameBytes) throw new CodexDesktopIpcError('The drawing or chat response is too large for the desktop connection.', 413);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }

  private request(method: RequestMethod, params: JsonObject, hostId?: string, owner?: string): Promise<Response> {
    if (!Object.hasOwn(methodVersions, method)) return Promise.reject(new CodexDesktopIpcError('This desktop operation is not available.', 400));
    const requestId = randomUUID();
    const mutating = method === 'thread-follower-start-turn' || method === 'thread-follower-interrupt-turn';
    return new Promise((resolve, reject) => {
      const pending: Pending = { method, mutating, written: false, resolve, reject,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new CodexDesktopIpcError(mutating && pending.written
            ? 'Codex did not confirm this send. Check the selected chat before retrying.'
            : 'Codex Desktop did not respond in time.', 503, mutating && pending.written ? 'unknown' : 'not-sent', 'request_timeout'));
        }, this.timeoutMs),
      };
      this.pending.set(requestId, pending);
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId,
          version: methodVersions[method] + (hostId && method.startsWith('thread-follower-') ? 1 : 0),
          method, params, timeoutMs: this.timeoutMs,
          ...(hostId ? { hostId } : {}), ...(owner ? { targetClientId: owner } : {}),
        });
        pending.written = true;
      } catch (error) {
        this.pending.delete(requestId); clearTimeout(pending.timer); reject(safeError(error));
      }
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.maxFrameBytes) { this.fail(); return; }
      if (this.buffer.length < length + 4) return;
      const bytes = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        const message: unknown = JSON.parse(bytes.toString('utf8'));
        if (!object(message)) throw new Error('Invalid frame');
        this.message(message);
      } catch { this.fail(); return; }
    }
  }

  private message(message: JsonObject): void {
    if (message.type === 'client-discovery-request' && typeof message.requestId === 'string') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'response' && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType === 'success' && message.method === pending.method) {
        pending.resolve({ result: message.result,
          ...(typeof message.handledByClientId === 'string' ? { handledByClientId: message.handledByClientId } : {}) });
      } else {
        const code = message.resultType === 'success' ? 'protocol_mismatch' : desktopErrorCode(message.error, pending.method);
        const noOwner = code === 'owner_unavailable';
        // Desktop's follower handler has its own timeout. It does not cancel
        // the remote operation, so a later snapshot can still confirm the send.
        pending.reject(new CodexDesktopIpcError(noOwner
          ? 'Open this chat in its Codex Remote Connection before sending.'
          : code === 'follower_timeout' && pending.mutating
            ? 'Codex Desktop timed out confirming this send. The original send may still complete.'
            : pending.mutating ? 'Codex did not confirm this send. Check the selected chat before retrying.' : 'Codex Desktop could not read this chat.',
        noOwner ? 409 : 503, pending.mutating && pending.written && !noOwner ? 'unknown' : 'not-sent', code));
      }
      return;
    }
    if (message.type !== 'broadcast' || (Array.isArray(message.targetClientIds) && !message.targetClientIds.includes(this.clientId))) return;
    if (message.method === 'client-status-changed' && object(message.params) && message.params.status === 'disconnected') {
      for (const entry of this.entries.values()) {
        if (entry.snapshot?.ownerClientId === message.params.clientId) this.invalidate(entry, new CodexDesktopIpcError('The selected Codex chat disconnected.'));
      }
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || !object(message.params)) return;
    const params = message.params;
    const entry = this.entries.get(key(String(params.hostId), String(params.conversationId)));
    if (!entry) return;
    if (message.version !== 11 || typeof message.sourceClientId !== 'string' || !object(params.change)) {
      this.invalidate(entry, new CodexDesktopIpcError('This Codex Desktop stream format is not supported.',
        503, 'not-sent', 'protocol_mismatch')); return;
    }
    const change = params.change;
    try {
      if (!Number.isSafeInteger(change.revision) || (change.revision as number) < 0) throw new Error('Invalid revision');
      let state: JsonObject;
      if (change.type === 'snapshot' && object(change.conversationState)) {
        state = change.conversationState;
      } else if (change.type === 'patches' && entry.snapshot) {
        if (entry.snapshot.ownerClientId !== message.sourceClientId) return;
        if (entry.snapshot.revision !== change.baseRevision || (change.revision as number) <= entry.snapshot.revision) {
          entry.snapshot = undefined;
          void this.refresh(entry).catch(error => this.invalidate(entry, safeError(error)));
          return;
        }
        state = patched(entry.snapshot.conversationState, change.patches);
      } else throw new Error('Snapshot required');
      if (state.id !== entry.threadId || (state.hostId !== undefined && state.hostId !== entry.hostId)
        || Buffer.byteLength(JSON.stringify(state)) > this.maxFrameBytes) throw new Error('Invalid state');
      const snapshot: DesktopSnapshot = { hostId: entry.hostId, threadId: entry.threadId,
        ownerClientId: message.sourceClientId, revision: change.revision as number, conversationState: state };
      entry.snapshot = snapshot;
      for (const waiter of entry.waiters) {
        if (waiter.owner === snapshot.ownerClientId && snapshot.revision >= waiter.revision) {
          clearTimeout(waiter.timer); entry.waiters.delete(waiter); waiter.resolve(snapshot);
        }
      }
      for (const listener of entry.listeners) { try { listener(snapshot); } catch { /* Listener owns its error handling. */ } }
    } catch { this.invalidate(entry, new CodexDesktopIpcError('Codex Desktop returned an invalid chat update.')); }
  }

  private retain(hostId: string, threadId: string): Entry {
    target(hostId, threadId);
    const id = key(hostId, threadId);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 16) throw new CodexDesktopIpcError('Too many active desktop chat subscriptions.');
      entry = { hostId, threadId, references: 0, listeners: new Set(), errors: new Set(), waiters: new Set() };
      this.entries.set(id, entry);
      try { this.follow(entry, true); }
      catch (error) { this.entries.delete(id); throw error; }
    }
    entry.references++;
    return entry;
  }

  private release(entry: Entry): void {
    if (--entry.references > 0) return;
    this.entries.delete(key(entry.hostId, entry.threadId));
    if (!this.closed) { try { this.follow(entry, false); } catch { /* Closing a subscription is best effort. */ } }
  }

  private follow(entry: Entry, following: boolean): void {
    this.write({ type: 'broadcast', sourceClientId: this.clientId, version: 1,
      method: 'thread-stream-following-changed', params: { hostId: entry.hostId, conversationId: entry.threadId, following } });
  }

  private refresh(entry: Entry): Promise<DesktopSnapshot> {
    if (entry.refreshing) return entry.refreshing;
    entry.refreshing = (async () => {
      const response = await this.request('thread-follower-load-complete-history', { conversationId: entry.threadId }, entry.hostId);
      if (!object(response.result) || !Number.isSafeInteger(response.result.revision) || !response.handledByClientId) {
        throw new CodexDesktopIpcError('Codex Desktop returned an invalid history receipt.');
      }
      const revision = response.result.revision as number;
      const owner = response.handledByClientId;
      if (entry.snapshot?.ownerClientId === owner && entry.snapshot.revision >= revision) return entry.snapshot;
      return new Promise<DesktopSnapshot>((resolve, reject) => {
        const waiter = { owner, revision, resolve, reject, timer: setTimeout(() => {
          entry.waiters.delete(waiter); reject(new CodexDesktopIpcError('Codex Desktop did not provide the requested chat snapshot.'));
        }, this.timeoutMs) };
        entry.waiters.add(waiter);
      });
    })().then(snapshot => {
      const state = snapshot.conversationState;
      const history = object(state.turnHistory) && object(state.turnHistory.history) ? state.turnHistory.history : undefined;
      const pagination = object(state.turnsPagination) ? state.turnsPagination : undefined;
      // The load-complete-history receipt is the synchronization barrier. Older
      // desktop versions can omit these flags; an explicit incomplete flag must
      // still prevent a partial history from being mistaken for a full read.
      if (history?.isComplete === false || pagination?.hasLoadedOldest === false || pagination?.isLoadingOlder === true
        || (pagination?.olderCursor !== undefined && pagination.olderCursor !== null)) {
        throw new CodexDesktopIpcError('Codex Desktop could not fully load this chat history.');
      }
      return snapshot;
    }).finally(() => { entry.refreshing = undefined; });
    return entry.refreshing;
  }

  async readSettings(hostId: string, threadId: string): Promise<DesktopModelSettings> {
    target(hostId, threadId);
    const response = await this.request('thread-follower-read-model-settings', { conversationId: threadId }, hostId);
    const result = object(response.result) ? settingsSchema.safeParse(response.result.settings) : undefined;
    if (!result?.success) throw new CodexDesktopIpcError('Codex Desktop could not load this chat settings.');
    return result.data;
  }

  async readSnapshot(hostId: string, threadId: string): Promise<DesktopSnapshot> {
    const entry = this.retain(hostId, threadId);
    try { return await this.refresh(entry); }
    finally { this.release(entry); }
  }

  /** The inspected local v4 handler returns null before any cleanup when expectedTurnId is absent. */
  async verifyLocalInterrupt(snapshot: DesktopSnapshot): Promise<boolean> {
    if (snapshot.hostId !== 'local' || !isThreadId(snapshot.threadId) || !snapshot.ownerClientId) return false;
    const state = snapshot.conversationState;
    const turns = Array.isArray(state.turns) ? [...state.turns] : [];
    if (object(state.turnHistory) && object(state.turnHistory.history) && object(state.turnHistory.history.entitiesByKey)) {
      turns.push(...Object.values(state.turnHistory.history.entitiesByKey));
    }
    const knownIds = new Set(turns.filter(object).flatMap(turn => [turn.id, turn.turnId]));
    let probeTurnId: string;
    do { probeTurnId = randomUUID(); } while (knownIds.has(probeTurnId));
    try {
      const response = await this.request('thread-follower-interrupt-turn', {
        conversationId: snapshot.threadId, expectedTurnId: probeTurnId, mode: 'system',
      }, snapshot.hostId, snapshot.ownerClientId);
      return response.handledByClientId === snapshot.ownerClientId && object(response.result)
        && response.result.ok === true && response.result.interruptedTurnId === null;
    } catch { return false; }
  }

  /** Verify this owner, then require Desktop to reject a stale turn at execution time. */
  async interruptTurn(input: DesktopInterruptTarget): Promise<DesktopInterruptReceipt> {
    const { hostId, threadId, turnId } = input;
    target(hostId, threadId);
    if (!isThreadId(turnId)) throw new CodexDesktopIpcError('A valid target turn is required.', 400);
    if (hostId !== 'local') throw new CodexDesktopIpcError('Stop capability is not verified for this host. Use the original chat in Desktop.',
      409, 'not-sent', 'capability_unverified');
    const entry = this.retain(hostId, threadId);
    try {
      const snapshot = await this.refresh(entry);
      if (!await this.verifyLocalInterrupt(snapshot)) throw new CodexDesktopIpcError('Stop capability is not verified for this chat owner. Use Desktop.',
        409, 'not-sent', 'capability_unverified');
      const response = await this.request('thread-follower-interrupt-turn', {
        conversationId: threadId, expectedTurnId: turnId, mode: 'user-stop',
      }, hostId, snapshot.ownerClientId);
      if (response.handledByClientId !== snapshot.ownerClientId || !object(response.result) || response.result.ok !== true
        || (response.result.interruptedTurnId !== null && response.result.interruptedTurnId !== turnId)) {
        throw new CodexDesktopIpcError('Codex did not confirm stopping the selected turn. Check that chat in Desktop.',
          503, 'unknown', 'invalid_receipt');
      }
      return { interruptedTurnId: response.result.interruptedTurnId as string | null };
    } finally { this.release(entry); }
  }

  async startImageTurn(input: ImageTurn): Promise<ImageTurnReceipt> {
    return this.startMessageTurn({ hostId: input.hostId, threadId: input.threadId,
      clientUserMessageId: input.submissionId, text: input.prompt,
      attachments: [{ mimeType: 'image/png', dataBase64: input.imageBase64 }],
      ...(input.selection === undefined ? {} : { selection: input.selection }) });
  }

  async startMessageTurn(input: MessageTurn): Promise<ImageTurnReceipt> {
    target(input.hostId, input.threadId);
    if (!isThreadId(input.clientUserMessageId) || typeof input.text !== 'string' || input.text.length > 20_000
      || !Array.isArray(input.attachments) || input.attachments.length > 4
      || (!input.text.trim() && input.attachments.length === 0)) {
      throw new CodexDesktopIpcError('A valid message and up to four images are required.', 400);
    }
    // Parse before awaiting the native snapshot so later draft changes cannot
    // replace the pair that this call was given. Availability is host-validated upstream.
    const parsedSelection = input.selection === undefined ? undefined : modelSelectionSchema.safeParse(input.selection);
    if (parsedSelection && !parsedSelection.success) {
      throw new CodexDesktopIpcError('Select a valid model and reasoning effort for this connection.', 400, 'not-sent', 'invalid_model_selection');
    }
    const parsedInitial = input.initialModelSettings === undefined ? undefined
      : modelSelectionSchema.extend({ reasoningEffort: modelSelectionSchema.shape.reasoningEffort.nullable() }).safeParse(input.initialModelSettings);
    if (parsedInitial && (!parsedInitial.success || input.selection !== undefined)) {
      throw new CodexDesktopIpcError('Codex could not preserve the initial model settings.', 400, 'not-sent', 'invalid_model_selection');
    }
    const selection = parsedSelection?.success ? parsedSelection.data : parsedInitial?.success ? parsedInitial.data : undefined;
    try {
      if (input.attachments.reduce((total, image) => total + imageBytes(image.dataBase64, image.mimeType).length, 0) > MAX_ATTACHMENT_BYTES) {
        throw new Error('Attachment limit');
      }
    } catch {
      throw new CodexDesktopIpcError('Attach PNG or JPEG images of at most 10 MiB each and 24 MiB in total.', 400);
    }
    const id = key(input.hostId, input.threadId);
    if (this.sending.has(id)) throw new CodexDesktopIpcError('This Codex chat already has a pending send.', 409);
    this.sending.add(id);
    let entry: Entry | undefined;
    try {
      entry = this.retain(input.hostId, input.threadId);
      const snapshot = await this.refresh(entry);
      if (isDesktopBusy(snapshot.conversationState)) throw new CodexDesktopIpcError('This Codex chat is busy. The message has not been sent.', 409);
      const collaborationMode = selection ? selectedCollaborationMode(snapshot.conversationState, selection) : undefined;
      // This is a preflight, not an atomic idle guard. Codex turn/start may add
      // input to a turn started elsewhere after this snapshot. The caller must
      // correlate clientUserMessageId and disclose a shared turn when observed.
      // Never use whole-queue replacement: it can discard concurrent messages.
      const response = await this.request('thread-follower-start-turn', {
        conversationId: input.threadId,
        turnStart: {
          request: {
            threadId: input.threadId,
            clientUserMessageId: input.clientUserMessageId,
            ...(collaborationMode ? { collaborationMode } : {}),
            input: [
              ...(input.text.trim() ? [{ type: 'text', text: input.text, text_elements: [] }] : []),
              ...input.attachments.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.dataBase64}` })),
            ],
          },
          context: { inheritThreadSettings: true },
        },
      }, input.hostId, snapshot.ownerClientId);
      const result = object(response.result) && object(response.result.result) ? response.result.result : undefined;
      if (!result || !object(result.turn) || !isThreadId(result.turn.id)) {
        throw new CodexDesktopIpcError('Codex did not return a valid turn receipt. Check the selected chat before retrying.', 503, 'unknown', 'invalid_receipt');
      }
      return { turnId: result.turn.id, clientUserMessageId: input.clientUserMessageId };
    } finally {
      this.sending.delete(id); if (entry) this.release(entry);
    }
  }

  async subscribe(hostId: string, threadId: string, onSnapshot: (snapshot: DesktopSnapshot) => void,
    onError?: (error: CodexDesktopIpcError) => void): Promise<() => void> {
    const entry = this.retain(hostId, threadId);
    entry.listeners.add(onSnapshot);
    if (onError) entry.errors.add(onError);
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true; entry.listeners.delete(onSnapshot); if (onError) entry.errors.delete(onError); this.release(entry);
    };
    try { await this.refresh(entry); return dispose; }
    catch (error) { dispose(); throw error; }
  }

  private invalidate(entry: Entry, error: CodexDesktopIpcError): void {
    entry.snapshot = undefined;
    for (const waiter of entry.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    entry.waiters.clear();
    for (const listener of entry.errors) { try { listener(error); } catch { /* Never let a consumer corrupt the transport. */ } }
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const unknown = pending.mutating && pending.written;
      pending.reject(new CodexDesktopIpcError(unknown
        ? 'Codex disconnected before confirming this send. Check the selected chat before retrying.'
        : 'Codex Desktop disconnected.', 503, unknown ? 'unknown' : 'not-sent', 'connection_closed'));
    }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
    for (const entry of this.entries.values()) this.invalidate(entry, new CodexDesktopIpcError('Codex Desktop disconnected.'));
    this.socket.destroy();
  }

  close(): void {
    if (!this.closed) {
      for (const entry of this.entries.values()) { try { this.follow(entry, false); } catch { break; } }
      this.socket.end();
      this.fail();
    }
    this.entries.clear();
  }
}
