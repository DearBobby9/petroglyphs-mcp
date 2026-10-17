import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ProjectCreationNotSentError } from './codex-companion-creator.js';
import { historyMessages, historyTurns, record } from './codex-conversation-history.js';
import { CodexDesktopIpcError, readTurnModelEvidence, type CodexDesktopIpc, type DesktopSnapshot } from './codex-desktop-ipc.js';
import { CodexNativeAppServer, type NativeCreationClient } from './codex-native-app-server.js';
import { modelEvidenceSchema } from './codex-model-selection.js';
import type { ProjectChatExecution, ProjectChatExecutor, ProjectChatObservation } from './codex-project-chats.js';
import { validProjectId, type CodexProjectsCatalog, type NativeLocalProjectIdentity } from './codex-projects-catalog.js';
import { isThreadId, type CodexThread } from './codex-threads.js';

interface Options {
  dataDir: string; codexPath: string; env?: NodeJS.ProcessEnv;
  catalog: Pick<CodexProjectsCatalog, 'nativeLocalIdentity'>;
  connectDesktop: () => Promise<Pick<CodexDesktopIpc, 'readSnapshot' | 'startMessageTurn' | 'close'>>;
  connectNative?: () => Promise<NativeCreationClient>;
  openThread?: (threadId: string) => Promise<void>;
  adoptionMs?: number; pollMs?: number;
}
const projectSchema = z.object({ id: z.string().refine(validProjectId), roots: z.array(z.object({ path: z.string().refine(isAbsolute) })).min(1).max(128) });
const threadSchema = z.object({ id: z.string().refine(isThreadId), title: z.string(), cwd: z.string(), updatedAt: z.number().finite() });
const settingsSchema = z.object({ model: z.string().min(1).max(256), reasoningEffort: z.string().min(1).max(64).nullable() }).strict();
const receiptSchema = z.object({ version: z.literal(1), id: z.string().refine(isThreadId), hostId: z.literal('local'),
  projectId: z.string().refine(validProjectId), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), nativeProjectId: z.string().refine(validProjectId),
  rootPaths: z.array(z.string().refine(isAbsolute)).min(1).max(128),
  stage: z.enum(['prepared', 'creation_requested', 'created', 'desktop_open_requested', 'first_message_requested', 'completed']),
  thread: threadSchema.optional(), projectVerified: z.boolean().optional(), effectiveSettings: settingsSchema.optional(),
  firstTurnId: z.string().refine(isThreadId).optional(), firstMessageId: z.string().optional(), modelEvidence: modelEvidenceSchema.optional(),
}).strict();
type NativeReceipt = z.infer<typeof receiptSchema>;

function fingerprint(input: ProjectChatExecution): string {
  return createHash('sha256').update(JSON.stringify({ id: input.id, hostId: input.hostId, projectId: input.projectId,
    prompt: input.prompt, title: input.title, selection: input.selection, createdAt: input.createdAt })).digest('hex');
}
const sameRoots = (left: string[], right: string[]) => left.length === right.length && left.every((root, index) => root === right[index]);

/** Validates explicit aliases against both the complete native list and a fresh project/read. */
export async function resolveNativeProject(client: NativeCreationClient, identity: NativeLocalProjectIdentity): Promise<string> {
  const matches: Array<z.infer<typeof projectSchema>> = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = record(await client.request('project/list', { cursor, limit: 100 }));
    if (!result || !Array.isArray(result.data) || result.data.length > 100
      || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096))) throw new ProjectCreationNotSentError();
    for (const value of result.data) {
      const project = projectSchema.parse(value);
      if (identity.candidateIds.includes(project.id)) matches.push(project);
    }
    if (result.nextCursor === null) {
      if (matches.length !== 1 || !sameRoots(matches[0].roots.map(root => root.path), identity.rootPaths)) throw new ProjectCreationNotSentError();
      const project = projectSchema.parse(record(await client.request('project/read', { projectId: matches[0].id }))?.project);
      if (project.id !== matches[0].id || !sameRoots(project.roots.map(root => root.path), identity.rootPaths)) throw new ProjectCreationNotSentError();
      return project.id;
    }
    if (cursors.has(result.nextCursor)) throw new ProjectCreationNotSentError();
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new ProjectCreationNotSentError();
}

/** Supplement Desktop's nullable project_id using current native membership and archive filtering. */
export async function readNativeProjectMembership(client: NativeCreationClient, identity: NativeLocalProjectIdentity): Promise<{ projectId: string; threadIds: string[] }> {
  const projectId = await resolveNativeProject(client, identity);
  const threadIds: string[] = [], cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = record(await client.request('thread/list', { projectId, archived: false, cursor, limit: 100, useStateDbOnly: true }));
    if (!result || !Array.isArray(result.data) || result.data.length > 100
      || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096))) throw new Error('Invalid native project threads');
    for (const value of result.data) {
      const thread = record(value);
      if (!isThreadId(thread?.id) || thread.projectId !== projectId) throw new Error('Invalid native thread membership');
      threadIds.push(thread.id);
    }
    if (result.nextCursor === null) {
      if (new Set(threadIds).size !== threadIds.length) throw new Error('Duplicate native project thread');
      return { projectId, threadIds };
    }
    if (cursors.has(result.nextCursor)) throw new Error('Repeated native project thread cursor');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new Error('Native project thread list is incomplete');
}

/** Open Codex's registered public URI once so Desktop can become the thread owner. */
async function openNativeThread(threadId: string): Promise<void> {
  if (!isThreadId(threadId)) throw new Error('Invalid native thread identity');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', [`codex://threads/${threadId}`], { stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex could not open the created chat.')); }, 5000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Codex could not open the created chat.')); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Codex could not open the created chat.')); });
  });
}

/** Creates local threads without an assistant. Every ambiguous write is recoverable only by reading. */
export class CodexNativeCreator implements ProjectChatExecutor {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly activeNative = new Set<NativeCreationClient>();
  private readonly activeDesktop = new Set<Awaited<ReturnType<Options['connectDesktop']>>>();
  private readonly inflight = new Map<string, Promise<ProjectChatObservation>>();

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.dataDir) || !isAbsolute(options.codexPath)) throw new Error('Native creator paths must be absolute');
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  }

  private async connectNative(): Promise<NativeCreationClient> {
    if (this.closed) throw new ProjectCreationNotSentError();
    const client = await (this.options.connectNative?.() ?? CodexNativeAppServer.connect({ codexPath: this.options.codexPath, env: this.options.env }));
    if (this.closed) { await client.close(); throw new ProjectCreationNotSentError(); }
    this.activeNative.add(client); return client;
  }

  private async connectDesktop(): Promise<Awaited<ReturnType<Options['connectDesktop']>>> {
    if (this.closed) throw new Error('Native creator is closed');
    const client = await this.options.connectDesktop();
    if (this.closed) { client.close(); throw new Error('Native creator is closed'); }
    this.activeDesktop.add(client); return client;
  }

  async ready(): Promise<void> {
    const client = await this.connectNative();
    try {
      const desktop = await this.connectDesktop();
      desktop.close(); this.activeDesktop.delete(desktop);
    } finally { await client.close(); this.activeNative.delete(client); }
  }

  private path(id: string): string {
    if (!isThreadId(id)) throw new ProjectCreationNotSentError();
    return join(this.options.dataDir, `${id}.json`);
  }

  private read(input: ProjectChatExecution): NativeReceipt | undefined {
    const path = this.path(input.id);
    if (!existsSync(path)) return;
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (receipt.id !== input.id || receipt.hostId !== input.hostId || receipt.projectId !== input.projectId
      || receipt.fingerprint !== fingerprint(input)) throw new Error('Native creation receipt identity mismatch');
    return receipt;
  }

  private save(receipt: NativeReceipt): void {
    const path = this.path(receipt.id);
    const content = JSON.stringify({ ...receipt, updatedAt: new Date().toISOString() });
    const fd = openSync(`${path}.tmp`, 'w', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${path}.tmp`, path);
    const directory = openSync(this.options.dataDir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  createChat(input: ProjectChatExecution): Promise<ProjectChatObservation> {
    if (this.closed || input.hostId !== 'local' || input.executorThreadId || input.retry) return Promise.reject(new ProjectCreationNotSentError());
    const existing = this.inflight.get(input.id);
    if (existing) return existing;
    const work = this.create(input).finally(() => this.inflight.delete(input.id));
    this.inflight.set(input.id, work); return work;
  }

  private async create(input: ProjectChatExecution): Promise<ProjectChatObservation> {
    if (this.read(input)) return this.recoverChat(input);
    let receipt: NativeReceipt | undefined;
    let native: NativeCreationClient | undefined;
    try {
      const identity = await this.options.catalog.nativeLocalIdentity(input.projectId);
      native = await this.connectNative();
      const nativeProjectId = await resolveNativeProject(native, identity);
      receipt = { version: 1, id: input.id, hostId: 'local', projectId: input.projectId, fingerprint: fingerprint(input),
        createdAt: input.createdAt, updatedAt: new Date().toISOString(), nativeProjectId, rootPaths: identity.rootPaths, stage: 'prepared' };
      this.save(receipt);
      if (this.closed) throw new ProjectCreationNotSentError();
      // thread/start has no client idempotency key. Save uncertainty before the
      // transport can write, including the crash between save and write.
      receipt.stage = 'creation_requested'; this.save(receipt);
      const response = record(await native.request('thread/start', { projectId: nativeProjectId,
        cwd: identity.rootPaths[0], runtimeWorkspaceRoots: identity.rootPaths, ephemeral: false,
        ...(input.selection ? { model: input.selection.model, config: { model_reasoning_effort: input.selection.reasoningEffort } } : {}) }));
      const created = record(response?.thread);
      if (!isThreadId(created?.id)) return { state: 'unknown' };
      receipt.thread = { id: created.id, title: typeof created.name === 'string' ? created.name : '未命名聊天',
        cwd: typeof created.cwd === 'string' ? created.cwd : '',
        updatedAt: typeof created.updatedAt === 'number' && Number.isFinite(created.updatedAt) ? created.updatedAt : Date.now() / 1000 };
      receipt.stage = 'created';
      receipt.projectVerified = created.projectId === nativeProjectId && created.cwd === identity.rootPaths[0]
        && response?.cwd === identity.rootPaths[0] && Array.isArray(response.runtimeWorkspaceRoots)
        && sameRoots(response.runtimeWorkspaceRoots as string[], identity.rootPaths);
      const settings = settingsSchema.safeParse({ model: response?.model, reasoningEffort: response?.reasoningEffort });
      if (settings.success) receipt.effectiveSettings = settings.data;
      // Never close the creator or expose a first-message write before saving
      // the real thread ID, even when later response validation fails.
      this.save(receipt);
      if (!receipt.projectVerified || !receipt.effectiveSettings || this.closed) return this.observation(receipt);
      if (input.title) {
        await native.request('thread/name/set', { threadId: created.id, name: input.title });
        receipt.thread.title = input.title; this.save(receipt);
      }
    } catch (error) {
      if (!receipt || receipt.stage === 'prepared') throw new ProjectCreationNotSentError();
      return this.observation(receipt);
    } finally {
      if (native) { await native.close(); this.activeNative.delete(native); }
    }
    if (!receipt?.thread || this.closed) return receipt ? this.observation(receipt) : { state: 'unknown' };
    let desktop: Awaited<ReturnType<Options['connectDesktop']>> | undefined;
    try {
      receipt.stage = 'desktop_open_requested'; this.save(receipt);
      await (this.options.openThread ?? openNativeThread)(receipt.thread.id);
      desktop = await this.connectDesktop();
      const snapshot = await this.waitForOwner(desktop, receipt.thread.id);
      // A normal URI can surface the chat before this send. Observe any input
      // already present, and never merge the first request into someone else's turn.
      const turns = historyTurns(snapshot.conversationState, receipt.thread.id);
      if (turns.length > 0) return await this.reconcile(input, receipt, snapshot);
      if (this.closed) return this.observation(receipt);
      receipt.stage = 'first_message_requested'; this.save(receipt);
      let result;
      try {
        result = await desktop.startMessageTurn({ hostId: 'local', threadId: receipt.thread.id,
          clientUserMessageId: input.id, text: input.prompt, attachments: [],
          ...(input.selection ? { selection: { ...input.selection } } : { initialModelSettings: receipt.effectiveSettings! }) });
      } catch (error) {
        if (error instanceof CodexDesktopIpcError && error.outcome === 'not_sent') {
          receipt.stage = 'desktop_open_requested'; this.save(receipt);
        }
        return await this.recoverChat(input);
      }
      if (result.clientUserMessageId !== input.id || !isThreadId(result.turnId)) return this.observation(receipt);
      receipt.stage = 'completed'; receipt.firstTurnId = result.turnId; this.save(receipt);
      try { return await this.reconcile(input, receipt, await desktop.readSnapshot('local', receipt.thread.id)); }
      catch { return this.observation(receipt); }
    } catch { return this.observation(receipt); }
    finally { if (desktop) { desktop.close(); this.activeDesktop.delete(desktop); } }
  }

  private async waitForOwner(desktop: Awaited<ReturnType<Options['connectDesktop']>>, threadId: string): Promise<DesktopSnapshot> {
    const deadline = Date.now() + (this.options.adoptionMs ?? 20_000);
    while (!this.closed) {
      try { const snapshot = await desktop.readSnapshot('local', threadId); this.validateSnapshot(snapshot, threadId); return snapshot; }
      catch {
        if (Date.now() >= deadline) throw new Error('Codex Desktop has not taken over the created chat.');
        await delay(this.options.pollMs ?? 250, undefined, { signal: this.abort.signal });
      }
    }
    throw new Error('Native creator is closed');
  }

  private validateSnapshot(snapshot: DesktopSnapshot, threadId: string): void {
    if (snapshot.hostId !== 'local' || snapshot.threadId !== threadId || snapshot.conversationState.id !== threadId
      || (snapshot.conversationState.hostId !== undefined && snapshot.conversationState.hostId !== 'local')) throw new Error('Invalid native chat snapshot');
  }

  private observation(receipt: NativeReceipt): ProjectChatObservation {
    if (!receipt.thread) return { state: 'unknown' };
    if (receipt.stage === 'completed' && receipt.firstTurnId) return { state: 'completed', hostId: 'local', thread: receipt.thread,
      firstTurnId: receipt.firstTurnId, ...(receipt.firstMessageId ? { firstMessageId: receipt.firstMessageId } : {}),
      ...(receipt.modelEvidence ? { modelEvidence: receipt.modelEvidence } : {}) };
    return { state: 'created', hostId: 'local', thread: receipt.thread, projectVerified: receipt.projectVerified === true,
      firstMessageState: receipt.stage === 'first_message_requested' ? 'unknown' : 'not_sent',
      ...(!receipt.projectVerified ? { notice: 'The chat was created, but its project settings could not be confirmed. Its first message was not sent. Check the created chat in Codex Desktop.' } : {}) };
  }

  private async reconcile(input: ProjectChatExecution, receipt: NativeReceipt, snapshot: DesktopSnapshot): Promise<ProjectChatObservation> {
    this.validateSnapshot(snapshot, receipt.thread!.id);
    if (!receipt.projectVerified) return this.observation(receipt);
    const turns = historyTurns(snapshot.conversationState, receipt.thread!.id);
    const messages = historyMessages(turns).filter(message => message.role === 'user' && message.clientMessageId === input.id);
    if (messages.length === 1 && messages[0].text === input.prompt && messages[0].imageInputs.length === 0) {
      const turn = turns.find(turn => turn.id === messages[0].turnId);
      if (turn && isThreadId(turn.id) && (!receipt.firstTurnId || turn.id === receipt.firstTurnId)) {
        receipt.stage = 'completed'; receipt.firstTurnId = turn.id; receipt.firstMessageId = messages[0].id;
        receipt.modelEvidence = readTurnModelEvidence(turn); this.save(receipt);
      }
    }
    return this.observation(receipt);
  }

  async recoverChat(input: ProjectChatExecution): Promise<ProjectChatObservation> {
    const receipt = this.read(input);
    if (!receipt || !receipt.thread || this.closed) return receipt ? this.observation(receipt) : { state: 'unknown' };
    let desktop: Awaited<ReturnType<Options['connectDesktop']>> | undefined;
    try {
      desktop = await this.connectDesktop();
      return await this.reconcile(input, receipt, await desktop.readSnapshot('local', receipt.thread.id));
    } catch { return this.observation(receipt); }
    finally { if (desktop) { desktop.close(); this.activeDesktop.delete(desktop); } }
  }

  close(): void {
    this.closed = true; this.abort.abort();
    for (const client of this.activeDesktop) client.close();
    for (const client of this.activeNative) void client.close();
    this.activeDesktop.clear(); this.activeNative.clear();
  }
}
