import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ProjectCreationNotSentError } from './codex-companion-creator.js';
import type { CodexModelSelection, DesktopTurnModelEvidence } from './codex-desktop-ipc.js';
import { ConversationError, isCodexHost, messageAttachmentSchema, parseMessageInput, type MessageAttachmentInput, type MessageInput } from './codex-message-input.js';
import { modelEvidenceSchema, modelSelectionSchema, modelVerificationFor, type ModelVerification } from './codex-model-selection.js';
import { CodexProjectsCatalog, validProjectId } from './codex-projects-catalog.js';
import { isThreadId, type CodexThread, type ThreadQuery } from './codex-threads.js';

export interface ProjectChatReceipt {
  id: string; hostId: string; projectId: string; createdAt: string; updatedAt: string;
  state: 'pending' | 'creating' | 'completed' | 'failed' | 'unknown';
  thread?: CodexThread; error?: string; notice?: string;
  selection?: CodexModelSelection; modelEvidence?: DesktopTurnModelEvidence; modelVerification?: ModelVerification;
  attemptId: string; attemptNumber: 1 | 2; canRetry: boolean; failureCode?: 'approval_review_timeout';
  creationMethod?: 'native' | 'companion'; firstMessageState?: 'not_sent' | 'unknown' | 'sent';
  firstMessageRequestId?: string; firstTurnId?: string; firstMessageId?: string;
}
export interface ProjectChatRetryProof {
  requestId: string; attemptId: string; hostId: string; projectId: string; executorThreadId: string;
  helperTurnId: string; toolCallId: string; approvalReviewId: string; verifiedAt: string;
}
export interface ProjectChatRetry {
  attemptId: string; attemptNumber: 2; previousFailure: ProjectChatRetryProof;
}
export interface ProjectChatExecution {
  id: string; hostId: string; projectId: string; prompt: string; title?: string; createdAt: string; executorThreadId?: string; requestPath: string;
  selection?: CodexModelSelection;
  attachments?: MessageAttachmentInput[];
  retry?: ProjectChatRetry;
}
export type ProjectChatObservation = { state: 'creating' | 'unknown' }
  | { state: 'created'; hostId: string; thread: CodexThread; projectVerified: boolean;
    firstMessageState: 'not_sent' | 'unknown'; notice?: string }
  | { state: 'failed_before_execution'; reason: 'approval_review_timeout'; proof: ProjectChatRetryProof }
  | { state: 'completed'; hostId: string; thread: CodexThread; firstTurnId: string; firstMessageId?: string; notice?: string;
    modelEvidence?: DesktopTurnModelEvidence };
export interface ProjectChatExecutor {
  readonly executorThreadId?: string;
  ready(): Promise<void>;
  createChat(input: ProjectChatExecution): Promise<ProjectChatObservation>;
  recoverChat(input: ProjectChatExecution): Promise<ProjectChatObservation>;
  close(): void;
}
interface Options {
  dataDir: string;
  catalog: Pick<CodexProjectsCatalog, 'list' | 'require' | 'listThreads'>;
  executor: ProjectChatExecutor;
  localExecutor?: ProjectChatExecutor;
  requireSelection?: (hostId: string, selection: CodexModelSelection, hasImages: boolean) => Promise<unknown>;
  onFirstMessage?: (input: MessageInput, evidence: { state: 'unknown' | 'queued'; createdAt: string; turnId?: string; sourceMessageId?: string }) => void;
  unknownAfterMs?: number;
  retryMs?: number;
}
const createSchema = z.object({ id: z.string().refine(isThreadId), hostId: z.string().refine(isCodexHost),
  projectId: z.string().refine(validProjectId), prompt: z.string().max(20_000),
  attachments: z.array(messageAttachmentSchema).max(4).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  selection: modelSelectionSchema.optional(),
}).strict();
const threadSchema = z.object({ id: z.string().refine(isThreadId), title: z.string(), cwd: z.string(), updatedAt: z.number().finite() });
const retrySchema = z.object({ hostId: z.string().refine(isCodexHost), projectId: z.string().refine(validProjectId),
  attemptId: z.string().refine(isThreadId) }).strict();
const proofSchema = z.object({ requestId: z.string().refine(isThreadId), attemptId: z.string().refine(isThreadId),
  hostId: z.string().refine(isCodexHost), projectId: z.string().refine(validProjectId), executorThreadId: z.string().refine(isThreadId),
  helperTurnId: z.string().refine(isThreadId), toolCallId: z.string().min(1).max(200),
  approvalReviewId: z.string().regex(/^automatic-approval-review:[a-f0-9-]{36}$/), verifiedAt: z.string().datetime(),
}).strict();
const attemptSchema = z.object({ id: z.string().refine(isThreadId), number: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().datetime(), previousFailure: proofSchema.optional() }).strict();
const jobSchema = createSchema.extend({ version: z.union([z.literal(1), z.literal(2)]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  state: z.enum(['pending', 'creating', 'completed', 'failed', 'unknown']),
  executorThreadId: z.string().refine(isThreadId).optional(), firstTurnId: z.string().optional(), firstMessageId: z.string().optional(),
  executorKind: z.enum(['native', 'companion']).optional(), firstMessageState: z.enum(['not_sent', 'unknown', 'sent']).optional(),
  threadProjectVerified: z.boolean().optional(), threadConfirmedAt: z.string().datetime().optional(),
  requestPath: z.string().refine(isAbsolute).optional(),
  thread: threadSchema.optional(), error: z.string().optional(), notice: z.string().optional(),
  modelEvidence: modelEvidenceSchema.optional(),
  attempts: z.array(attemptSchema).min(1).max(2).optional(), approvalFailure: proofSchema.optional(),
}).strict().refine(job => job.version === (job.selection ? 2 : 1), 'Invalid creation protocol version')
  .refine(job => job.executorKind !== 'native' || (job.hostId === 'local' && job.executorThreadId === undefined
    && job.approvalFailure === undefined && (!job.attempts || job.attempts.length === 1)), 'Invalid native creation executor')
  .refine(job => !job.attempts || (job.attempts[0].id === job.id && job.attempts[0].number === 1
    && job.attempts[0].previousFailure === undefined && (job.attempts.length === 1 || (job.attempts[1].number === 2
      && job.attempts[1].id !== job.id && job.attempts[1].previousFailure?.requestId === job.id
      && job.attempts[1].previousFailure?.attemptId === job.id
      && job.attempts[1].previousFailure?.hostId === job.hostId && job.attempts[1].previousFailure?.projectId === job.projectId
      && job.attempts[1].previousFailure?.executorThreadId === job.executorThreadId))), 'Invalid creation attempts');
type Job = z.infer<typeof jobSchema>;

function creationModelWarning(job: Job): string | undefined {
  if (!job.selection) return;
  const verification = modelVerificationFor(job.selection, job.modelEvidence, !!job.firstTurnId);
  return verification === 'different'
    ? 'The chat was created, but Codex used different model settings or rerouted its first response. Continue in this chat instead of creating another one.'
    : verification === 'unverified'
      ? 'The chat was created, but Codex could not confirm the model settings of its first response. Continue in this chat instead of creating another one.' : undefined;
}

/** Durable creation admission. A written native call is never replayed. */
export class CodexProjectChats {
  private readonly jobs = new Map<string, Job>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly retryAdmissions = new Map<string, Promise<ProjectChatReceipt>>();
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.dataDir)) throw new Error('Project chat receipt directory must be absolute');
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(options.dataDir, 'requests'), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(options.dataDir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const job = jobSchema.parse(JSON.parse(readFileSync(join(options.dataDir, name), 'utf8')));
      if (name !== `${job.id}.json`) throw new Error('Invalid project chat receipt');
      if (job.state === 'creating') {
        job.state = 'unknown'; job.notice = 'Creation was interrupted by a service restart. Check this project’s chats before creating another chat.';
        this.save(job);
      }
      this.jobs.set(job.id, job);
    }
    setImmediate(() => {
      for (const job of this.jobs.values()) if (job.state === 'pending') this.dispatch(job);
    });
    this.timer = setInterval(() => {
      for (const job of this.jobs.values()) if (job.state === 'pending') this.dispatch(job);
    }, options.retryMs ?? 3000);
    this.timer.unref();
  }

  private save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    const path = join(this.options.dataDir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    this.publishFirstMessage(job);
  }

  private publishFirstMessage(job: Job): void {
    if (!job.thread || !['unknown', 'sent'].includes(job.firstMessageState ?? '')) return;
    this.options.onFirstMessage?.({ id: job.id, hostId: job.hostId, threadId: job.thread.id,
      text: job.prompt, attachments: job.attachments ?? [], ...(job.selection ? { selection: job.selection } : {}) },
    { state: job.firstMessageState === 'sent' ? 'queued' : 'unknown', createdAt: job.createdAt,
      ...(job.firstTurnId ? { turnId: job.firstTurnId } : {}), ...(job.firstMessageId ? { sourceMessageId: job.firstMessageId } : {}) });
  }

  restoreFirstMessages(): void {
    for (const job of this.jobs.values()) this.publishFirstMessage(job);
  }

  private receipt(job: Job): ProjectChatReceipt {
    const attempt = this.currentAttempt(job);
    return { id: job.id, hostId: job.hostId, projectId: job.projectId, createdAt: job.createdAt, updatedAt: job.updatedAt,
      attemptId: attempt.id, attemptNumber: attempt.number,
      creationMethod: job.executorKind ?? 'companion',
      ...(job.firstMessageState ? { firstMessageState: job.firstMessageState } : {}),
      ...(job.thread ? { firstMessageRequestId: job.id } : {}),
      ...(job.firstTurnId ? { firstTurnId: job.firstTurnId } : {}),
      ...(job.firstMessageId ? { firstMessageId: job.firstMessageId } : {}),
      canRetry: job.executorKind !== 'native' && job.state === 'failed' && attempt.number === 1 && job.approvalFailure?.attemptId === attempt.id,
      ...(job.approvalFailure ? { failureCode: 'approval_review_timeout' as const } : {}),
      state: job.state, ...(job.thread ? { thread: job.thread } : {}), ...(job.error ? { error: job.error } : {}),
      ...(job.notice ? { notice: job.notice } : {}),
      ...(job.selection ? { selection: { ...job.selection },
        modelVerification: modelVerificationFor(job.selection, job.modelEvidence, !!job.firstTurnId) } : {}),
      ...(job.modelEvidence ? { modelEvidence: structuredClone(job.modelEvidence) } : {}) };
  }

  private currentAttempt(job: Job): z.infer<typeof attemptSchema> {
    return job.attempts?.at(-1) ?? { id: job.id, number: 1, createdAt: job.createdAt };
  }

  private executor(job: Job): ProjectChatExecutor | undefined {
    // Missing kind is the original companion protocol. Configuration changes
    // must never reroute an admitted request to a different creation mechanism.
    return job.executorKind === 'native' ? this.options.localExecutor : this.options.executor;
  }

  private async requireSelection(hostId: string, selection?: CodexModelSelection, hasImages = false): Promise<void> {
    if (!selection) return;
    if (!this.options.requireSelection) {
      throw new ConversationError('The model catalogue for this connection is unavailable. Refresh the connection before choosing a model.',
        503, 'catalogue_unavailable');
    }
    await this.options.requireSelection(hostId, { ...selection }, hasImages);
  }

  async projects(hostId: string) {
    const projects = await this.options.catalog.list(hostId);
    let canCreate = false;
    const executor = hostId === 'local' && this.options.localExecutor ? this.options.localExecutor : this.options.executor;
    try { await executor.ready(); canCreate = true; } catch { /* Saved projects remain readable when creation is unavailable. */ }
    return { hostId, projects: projects.map(({ hostId: _host, ...project }) => ({ ...project, canCreate,
      supportsFirstMessageAttachments: hostId === 'local' && !!this.options.localExecutor,
      ...(!canCreate ? { reason: hostId === 'local' && this.options.localExecutor
        ? 'Native chat creation is unavailable. Open Codex Desktop and reconnect.'
        : 'The Codex project-creation companion is unavailable. Open Codex Desktop or finish companion setup on the Mac.' } : {}) })) };
  }

  listThreads(hostId: string, projectId: string, query: ThreadQuery) { return this.options.catalog.listThreads(hostId, projectId, query); }

  async accept(value: unknown): Promise<{ receipt: ProjectChatReceipt; duplicate: boolean }> {
    const parsed = createSchema.safeParse(value);
    if (!parsed.success) throw new ConversationError('Select a saved project and enter a first message of up to 20,000 characters. Titles allow 120 characters.', 400, 'invalid_chat_request');
    if (this.closed) throw new ConversationError('Chat creation is unavailable.', 503, 'creation_unavailable');
    const input = parsed.data;
    parseMessageInput({ id: input.id, hostId: input.hostId, threadId: input.id, text: input.prompt,
      attachments: input.attachments ?? [], ...(input.selection ? { selection: input.selection } : {}) });
    if (input.attachments?.length === 0) delete input.attachments;
    if (input.attachments?.length && (input.hostId !== 'local' || !this.options.localExecutor)) {
      throw new ConversationError('This connection cannot create a chat with images. Select a Mac with native creation support.', 422, 'first_message_images_unsupported');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const known = () => {
      const job = this.jobs.get(input.id);
      if (job && job.fingerprint !== fingerprint) throw new ConversationError('This creation ID was already used for different content or a different project.', 409, 'id_conflict');
      return job;
    };
    const first = known();
    if (first) return { receipt: this.receipt(first), duplicate: true };
    await this.options.catalog.require(input.hostId, input.projectId);
    await this.requireSelection(input.hostId, input.selection, !!input.attachments?.length);
    const second = known();
    if (second) return { receipt: this.receipt(second), duplicate: true };
    if ([...this.jobs.values()].filter(job => ['pending', 'creating'].includes(job.state)).length >= 10) {
      throw new ConversationError('Too many chats are being created. Wait for them to finish.', 429, 'creation_busy');
    }
    const now = new Date().toISOString();
    const executorKind = input.hostId === 'local' && this.options.localExecutor ? 'native' : 'companion';
    const job: Job = { ...input, version: input.selection ? 2 : 1, fingerprint, createdAt: now, updatedAt: now, state: 'pending',
      executorKind,
      attempts: [{ id: input.id, number: 1, createdAt: now }],
      ...(executorKind === 'companion' && this.options.executor.executorThreadId ? { executorThreadId: this.options.executor.executorThreadId } : {}) };
    this.immutableRequest(job); this.save(job); this.jobs.set(job.id, job);
    setImmediate(() => this.dispatch(job));
    return { receipt: this.receipt(job), duplicate: false };
  }

  get(hostId: string, projectId: string, id: string): ProjectChatReceipt {
    if (!isCodexHost(hostId) || !validProjectId(projectId) || !isThreadId(id)) throw new ConversationError('Select a valid chat creation request and project.', 400, 'invalid_chat_request');
    const job = this.jobs.get(id);
    if (!job || job.hostId !== hostId || job.projectId !== projectId) throw new ConversationError('This chat creation request was not accepted for this project.', 404, 'creation_not_found');
    this.publishFirstMessage(job);
    return this.receipt(job);
  }

  async status(hostId: string, projectId: string, id: string): Promise<ProjectChatReceipt> {
    this.get(hostId, projectId, id);
    const job = this.jobs.get(id)!;
    // A GET can recover a late result, including after restart. It cannot send.
    const executor = this.executor(job);
    const refreshModel = job.state === 'completed' && job.executorKind === 'native' && !!job.selection && !!job.thread && !!job.firstTurnId;
    if ((['creating', 'unknown'].includes(job.state) || refreshModel) && executor && (job.executorKind === 'native' || job.executorThreadId) && !this.inflight.has(id)
      && !this.retryAdmissions.has(id) && !this.closed) {
      const attemptId = this.currentAttempt(job).id;
      const work = executor.recoverChat(this.execution(job)).then(result => {
        if (this.closed || this.currentAttempt(job).id !== attemptId) return;
        if (refreshModel) this.refreshCompletedModel(job, result);
        else { this.observe(job, result); this.save(job); }
      }).catch(() => { /* Preserve durable uncertainty when Desktop is unavailable. */ })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, work); await work;
    }
    return this.receipt(job);
  }

  /** A later read may refine model evidence; it must not downgrade or retarget a completed creation. */
  private refreshCompletedModel(job: Job, result: ProjectChatObservation): void {
    if (result.state !== 'completed' || result.hostId !== job.hostId || result.thread.id !== job.thread?.id
      || result.firstTurnId !== job.firstTurnId) return;
    const evidence = modelEvidenceSchema.safeParse(result.modelEvidence);
    if (!evidence.success || JSON.stringify(evidence.data) === JSON.stringify(job.modelEvidence)) return;
    const updated: Job = { ...job, modelEvidence: evidence.data };
    const previousWarning = creationModelWarning(job);
    let notice = job.notice;
    if (previousWarning && notice === previousWarning) notice = undefined;
    else if (previousWarning && notice?.endsWith(` ${previousWarning}`)) notice = notice.slice(0, -previousWarning.length - 1);
    updated.notice = [notice, creationModelWarning(updated)].filter(Boolean).join(' ') || undefined;
    this.save(updated);
    Object.assign(job, updated);
  }

  async retry(id: string, value: unknown): Promise<{ receipt: ProjectChatReceipt; duplicate: boolean }> {
    const parsed = retrySchema.safeParse(value);
    if (!parsed.success) throw new ConversationError('Provide the original project, connection and attempt ID.', 400, 'invalid_chat_retry');
    const input = parsed.data;
    this.get(input.hostId, input.projectId, id);
    if (this.closed) throw new ConversationError('Chat creation is unavailable.', 503, 'creation_unavailable');
    const job = this.jobs.get(id)!;
    if (job.executorKind === 'native') throw new ConversationError('Native creation cannot use the companion approval-timeout retry.', 409, 'creation_retry_unavailable');
    const current = this.currentAttempt(job);
    if (current.number === 2) {
      if (input.attemptId === job.id) return { receipt: this.receipt(job), duplicate: true };
      throw new ConversationError('This request has already used its one approval-timeout retry.', 409, 'creation_retry_limit');
    }
    if (input.attemptId !== current.id) throw new ConversationError('This is not the current creation attempt.', 409, 'creation_attempt_conflict');
    const existing = this.retryAdmissions.get(id);
    if (existing) return { receipt: await existing, duplicate: true };
    if (this.inflight.has(id) || ['pending', 'creating'].includes(job.state)) {
      throw new ConversationError('The original creation attempt is still being checked.', 409, 'creation_busy');
    }
    const work = this.admitRetry(job, current.id);
    this.retryAdmissions.set(id, work);
    try { return { receipt: await work, duplicate: false }; }
    finally { this.retryAdmissions.delete(id); }
  }

  private async admitRetry(job: Job, expectedAttemptId: string): Promise<ProjectChatReceipt> {
    // Re-read the native failure. A cached receipt is not permission to send.
    const observation = await this.options.executor.recoverChat(this.execution(job));
    if (this.closed) throw new ConversationError('Chat creation is unavailable.', 503, 'creation_unavailable');
    if (this.currentAttempt(job).id !== expectedAttemptId) {
      throw new ConversationError('The creation attempt changed. Read its current status.', 409, 'creation_attempt_conflict');
    }
    this.observe(job, observation); this.save(job);
    if (!this.receipt(job).canRetry || !job.approvalFailure) {
      throw new ConversationError('Codex has not proved that this request failed before creation. It will not be sent again.',
        409, 'creation_retry_unavailable');
    }
    await this.options.catalog.require(job.hostId, job.projectId);
    await this.requireSelection(job.hostId, job.selection, !!job.attachments?.length);
    await this.options.executor.ready();
    if (this.closed || this.currentAttempt(job).id !== expectedAttemptId) {
      throw new ConversationError('The creation attempt changed. Read its current status.', 409, 'creation_attempt_conflict');
    }
    const previous = this.currentAttempt(job);
    const next = { id: randomUUID(), number: 2 as const, createdAt: new Date().toISOString(), previousFailure: structuredClone(job.approvalFailure) };
    const admitted: Job = { ...job, attempts: [previous, next], state: 'pending' };
    delete admitted.error; delete admitted.notice; delete admitted.approvalFailure;
    // Persist the new attempt before exposing it to the dispatcher. Failed
    // writes leave the original failed attempt intact and cannot trigger send.
    this.immutableRequest(admitted); this.save(admitted);
    Object.assign(job, admitted); delete job.error; delete job.notice; delete job.approvalFailure;
    setImmediate(() => this.dispatch(job));
    return this.receipt(job);
  }

  verifiedFirstMessage(hostId: string, threadId: string): { id: string; turnId: string; sourceMessageId?: string; text: string; createdAt: string;
    selection?: CodexModelSelection } | undefined {
    const job = [...this.jobs.values()].find(job => job.hostId === hostId && job.thread?.id === threadId && job.state === 'completed' && job.firstTurnId);
    return job ? { id: job.id, turnId: job.firstTurnId!, sourceMessageId: job.firstMessageId, text: job.prompt, createdAt: job.createdAt,
      ...(job.selection ? { selection: { ...job.selection } } : {}) } : undefined;
  }

  hasThread(hostId: string, threadId: string): boolean {
    // Native creation can precede Desktop's directory notification. Bridge only
    // that short indexing gap; normal archive/visibility checks resume afterward.
    return [...this.jobs.values()].some(job => job.hostId === hostId && job.thread?.id === threadId
      && (job.state === 'completed' || (job.executorKind === 'native' && job.threadProjectVerified))
      && Date.now() - Date.parse(job.threadConfirmedAt ?? job.updatedAt) < 60_000);
  }

  private dispatch(job: Job): void {
    // Serialize creation admissions, including companion instructions, so two
    // idle preflights cannot merge helper requests into one native turn.
    if (this.closed || job.state !== 'pending' || this.inflight.size > 0 || this.retryAdmissions.size > 0) return;
    const work = this.create(job).catch(() => {
      // The last durable state already records whether creation may have run.
      console.error('[petroglyphs] Project chat creation could not update its receipt.');
    }).finally(() => this.inflight.delete(job.id));
    this.inflight.set(job.id, work);
  }

  private execution(job: Job): ProjectChatExecution {
    if (!job.requestPath || (job.executorKind !== 'native' && !job.executorThreadId)) throw new ProjectCreationNotSentError();
    const attempt = this.currentAttempt(job);
    return { id: job.id, hostId: job.hostId, projectId: job.projectId, prompt: job.prompt,
      ...(job.title ? { title: job.title } : {}), createdAt: job.createdAt,
      ...(job.attachments?.length ? { attachments: structuredClone(job.attachments) } : {}),
      ...(job.executorThreadId ? { executorThreadId: job.executorThreadId } : {}), requestPath: job.requestPath,
      ...(job.selection ? { selection: { ...job.selection } } : {}),
      ...(attempt.number === 2 && attempt.previousFailure ? { retry: { attemptId: attempt.id, attemptNumber: 2 as const,
        previousFailure: structuredClone(attempt.previousFailure) } } : {}) };
  }

  private immutableRequest(job: Job): void {
    const path = join(this.options.dataDir, 'requests', `${job.id}.json`);
    if (job.requestPath && job.requestPath !== path) throw new Error('Invalid immutable request path');
    const content = JSON.stringify({ requestId: job.id, hostId: job.hostId, projectId: job.projectId,
      prompt: job.prompt, ...(job.title ? { title: job.title } : {}), ...(job.selection ? { selection: job.selection } : {}),
      ...(job.attachments?.length ? { attachments: job.attachments } : {}) });
    try { writeFileSync(path, content, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o400 || readFileSync(path, 'utf8') !== content) {
      throw new Error('Immutable creation request changed');
    }
    job.requestPath = path;
  }

  private observe(job: Job, result: ProjectChatObservation): void {
    if (result.state === 'created' && job.executorKind === 'native' && result.hostId === job.hostId
      && threadSchema.safeParse(result.thread).success) {
      job.thread = result.thread; job.threadConfirmedAt ??= new Date().toISOString();
      job.threadProjectVerified = result.projectVerified; job.firstMessageState = result.firstMessageState;
      job.state = 'unknown'; delete job.error;
      job.notice = result.notice ?? (result.firstMessageState === 'not_sent'
        ? 'The chat was created, but its first message was not sent. Open this chat to continue. This request will not create another chat.'
        : 'The chat was created, but Codex has not confirmed its first message. Check this chat before sending again.');
      return;
    }
    if (result.state === 'failed_before_execution' && job.executorKind !== 'native') {
      const parsed = proofSchema.safeParse(result.proof);
      const proof = parsed.success ? parsed.data : undefined;
      const attempt = this.currentAttempt(job);
      if (result.reason === 'approval_review_timeout' && proof?.requestId === job.id && proof.attemptId === attempt.id
        && proof.hostId === job.hostId && proof.projectId === job.projectId && proof.executorThreadId === job.executorThreadId) {
        job.attempts ??= [attempt]; job.approvalFailure = proof; job.state = 'failed'; delete job.notice;
        job.error = attempt.number === 1
          ? 'Codex’s automatic permission review timed out before creation. Retry this original request once.'
          : 'Codex’s automatic permission review timed out again before creation. This request has used its one retry.';
        return;
      }
    }
    if (result.state === 'completed' && result.hostId === job.hostId && threadSchema.safeParse(result.thread).success
      && typeof result.firstTurnId === 'string' && result.firstTurnId.length > 0) {
      job.thread = result.thread; job.firstTurnId = result.firstTurnId; job.firstMessageId = result.firstMessageId; job.state = 'completed';
      job.threadConfirmedAt ??= new Date().toISOString(); job.firstMessageState = 'sent';
      delete job.error; delete job.notice; delete job.approvalFailure;
      if (result.notice) job.notice = result.notice;
      const evidence = modelEvidenceSchema.safeParse(result.modelEvidence);
      if (evidence.success) job.modelEvidence = evidence.data;
      else delete job.modelEvidence;
      const warning = creationModelWarning(job);
      if (warning) job.notice = [job.notice, warning].filter(Boolean).join(' ');
      return;
    }
    if (result.state !== 'creating' || job.state === 'unknown') {
      delete job.error; delete job.approvalFailure;
      job.state = 'unknown';
      if (!job.thread) job.notice = 'Codex has not confirmed a unique new chat. Check this project’s chats before creating another one. This request will not be sent again.';
    }
  }

  private async create(job: Job): Promise<void> {
    const attemptId = this.currentAttempt(job).id;
    const executor = this.executor(job);
    try {
      await this.options.catalog.require(job.hostId, job.projectId);
      if (!executor || (job.executorKind !== 'native' && (!job.executorThreadId || job.executorThreadId !== executor.executorThreadId))) {
        throw new ProjectCreationNotSentError();
      }
      this.immutableRequest(job);
      await executor.ready();
    } catch {
      if (this.closed) return;
      job.state = 'failed'; job.error = 'The chat was not created. Refresh the project and reconnect Codex Desktop before trying again.';
      this.save(job); return;
    }
    try { await this.requireSelection(job.hostId, job.selection, !!job.attachments?.length); }
    catch (error) {
      if (this.closed) return;
      const invalid = error instanceof ConversationError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 429;
      job.state = invalid ? 'failed' : 'pending';
      delete job.error; delete job.notice;
      if (invalid) job.error = 'The selected model settings are no longer available on this connection. Choose an available model before creating the chat.';
      else {
        job.notice = 'Waiting for this connection’s model catalogue before creating the chat.';
        // One offline host must not monopolize the shared companion. Leave the
        // next attempt to the normal retry interval, behind other queued jobs.
        this.jobs.delete(job.id); this.jobs.set(job.id, job);
      }
      this.save(job); return;
    }
    if (this.closed || this.currentAttempt(job).id !== attemptId) return;
    job.state = 'creating'; delete job.notice; this.save(job);
    const pending = setTimeout(() => {
      if (this.closed || job.state !== 'creating' || this.currentAttempt(job).id !== attemptId) return;
      job.state = 'unknown'; job.notice = 'Codex is still confirming creation. Check this project’s chats before creating another chat.';
      this.save(job);
    }, this.options.unknownAfterMs ?? 20_000);
    pending.unref();
    try {
      const result = await executor!.createChat(this.execution(job));
      if (!this.closed && this.currentAttempt(job).id === attemptId) this.observe(job, result);
    } catch (error) {
      if (this.closed || this.currentAttempt(job).id !== attemptId) return;
      if (error instanceof ProjectCreationNotSentError) {
        job.state = error.busy ? 'pending' : 'failed'; delete job.notice;
        if (error.busy) job.notice = 'Waiting for Codex to finish its current creation request.';
        else job.error = 'The chat was not created. Reconnect Codex Desktop before trying again.';
      } else this.observe(job, { state: 'unknown' });
    } finally { clearTimeout(pending); if (!this.closed) this.save(job); }
  }

  close(): void { this.closed = true; clearInterval(this.timer); this.options.executor.close(); this.options.localExecutor?.close(); }
}
