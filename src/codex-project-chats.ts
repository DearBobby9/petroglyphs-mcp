import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ProjectCreationNotSentError } from './codex-companion-creator.js';
import { ConversationError, isCodexHost } from './codex-message-input.js';
import { CodexProjectsCatalog, validProjectId } from './codex-projects-catalog.js';
import { isThreadId, type CodexThread, type ThreadQuery } from './codex-threads.js';

export interface ProjectChatReceipt {
  id: string; hostId: string; projectId: string; createdAt: string; updatedAt: string;
  state: 'pending' | 'creating' | 'completed' | 'failed' | 'unknown';
  thread?: CodexThread; error?: string; notice?: string;
}
export interface ProjectChatExecution {
  id: string; hostId: string; projectId: string; prompt: string; title?: string; createdAt: string; executorThreadId: string; requestPath: string;
}
export type ProjectChatObservation = { state: 'creating' | 'unknown' }
  | { state: 'completed'; hostId: string; thread: CodexThread; firstTurnId: string; firstMessageId?: string; notice?: string };
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
  unknownAfterMs?: number;
  retryMs?: number;
}
const createSchema = z.object({ id: z.string().refine(isThreadId), hostId: z.string().refine(isCodexHost),
  projectId: z.string().refine(validProjectId), prompt: z.string().max(20_000).refine(value => value.trim().length > 0),
  title: z.string().trim().min(1).max(120).optional(),
}).strict();
const threadSchema = z.object({ id: z.string().refine(isThreadId), title: z.string(), cwd: z.string(), updatedAt: z.number().finite() });
const jobSchema = createSchema.extend({ version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  state: z.enum(['pending', 'creating', 'completed', 'failed', 'unknown']),
  executorThreadId: z.string().refine(isThreadId).optional(), firstTurnId: z.string().optional(), firstMessageId: z.string().optional(),
  requestPath: z.string().refine(isAbsolute).optional(),
  thread: threadSchema.optional(), error: z.string().optional(), notice: z.string().optional(),
}).strict();
type Job = z.infer<typeof jobSchema>;

/** Durable creation admission. A written native call is never replayed. */
export class CodexProjectChats {
  private readonly jobs = new Map<string, Job>();
  private readonly inflight = new Map<string, Promise<void>>();
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
  }

  private receipt(job: Job): ProjectChatReceipt {
    return { id: job.id, hostId: job.hostId, projectId: job.projectId, createdAt: job.createdAt, updatedAt: job.updatedAt,
      state: job.state, ...(job.thread ? { thread: job.thread } : {}), ...(job.error ? { error: job.error } : {}),
      ...(job.notice ? { notice: job.notice } : {}) };
  }

  async projects(hostId: string) {
    const projects = await this.options.catalog.list(hostId);
    let canCreate = false;
    try { await this.options.executor.ready(); canCreate = true; } catch { /* Saved projects remain readable when creation is unavailable. */ }
    return { hostId, projects: projects.map(({ hostId: _host, ...project }) => ({ ...project, canCreate,
      ...(!canCreate ? { reason: 'The Codex project-creation companion is unavailable. Open Codex Desktop or finish companion setup on the Mac.' } : {}) })) };
  }

  listThreads(hostId: string, projectId: string, query: ThreadQuery) { return this.options.catalog.listThreads(hostId, projectId, query); }

  async accept(value: unknown): Promise<{ receipt: ProjectChatReceipt; duplicate: boolean }> {
    const parsed = createSchema.safeParse(value);
    if (!parsed.success) throw new ConversationError('Select a saved project and enter a first message of up to 20,000 characters. Titles allow 120 characters.', 400, 'invalid_chat_request');
    if (this.closed) throw new ConversationError('Chat creation is unavailable.', 503, 'creation_unavailable');
    const input = parsed.data;
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const known = () => {
      const job = this.jobs.get(input.id);
      if (job && job.fingerprint !== fingerprint) throw new ConversationError('This creation ID was already used for different content or a different project.', 409, 'id_conflict');
      return job;
    };
    const first = known();
    if (first) return { receipt: this.receipt(first), duplicate: true };
    await this.options.catalog.require(input.hostId, input.projectId);
    const second = known();
    if (second) return { receipt: this.receipt(second), duplicate: true };
    if ([...this.jobs.values()].filter(job => ['pending', 'creating'].includes(job.state)).length >= 10) {
      throw new ConversationError('Too many chats are being created. Wait for them to finish.', 429, 'creation_busy');
    }
    const now = new Date().toISOString();
    const job: Job = { ...input, version: 1, fingerprint, createdAt: now, updatedAt: now, state: 'pending',
      ...(this.options.executor.executorThreadId ? { executorThreadId: this.options.executor.executorThreadId } : {}) };
    this.immutableRequest(job); this.save(job); this.jobs.set(job.id, job);
    setImmediate(() => this.dispatch(job));
    return { receipt: this.receipt(job), duplicate: false };
  }

  get(hostId: string, projectId: string, id: string): ProjectChatReceipt {
    if (!isCodexHost(hostId) || !validProjectId(projectId) || !isThreadId(id)) throw new ConversationError('Select a valid chat creation request and project.', 400, 'invalid_chat_request');
    const job = this.jobs.get(id);
    if (!job || job.hostId !== hostId || job.projectId !== projectId) throw new ConversationError('This chat creation request was not accepted for this project.', 404, 'creation_not_found');
    return this.receipt(job);
  }

  async status(hostId: string, projectId: string, id: string): Promise<ProjectChatReceipt> {
    this.get(hostId, projectId, id);
    const job = this.jobs.get(id)!;
    // A GET can recover a late result, including after restart. It cannot send.
    if (['creating', 'unknown'].includes(job.state) && job.executorThreadId && !this.inflight.has(id) && !this.closed) {
      const work = this.options.executor.recoverChat(this.execution(job)).then(result => {
        if (this.closed) return;
        this.observe(job, result); this.save(job);
      }).catch(() => { /* Preserve durable uncertainty when Desktop is unavailable. */ })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, work); await work;
    }
    return this.receipt(job);
  }

  verifiedFirstMessage(hostId: string, threadId: string): { id: string; turnId: string; sourceMessageId?: string; text: string; createdAt: string } | undefined {
    const job = [...this.jobs.values()].find(job => job.hostId === hostId && job.thread?.id === threadId && job.state === 'completed' && job.firstTurnId);
    return job ? { id: job.id, turnId: job.firstTurnId!, sourceMessageId: job.firstMessageId, text: job.prompt, createdAt: job.createdAt } : undefined;
  }

  hasThread(hostId: string, threadId: string): boolean {
    // Native creation can precede Desktop's directory notification. Bridge only
    // that short indexing gap; normal archive/visibility checks resume afterward.
    return [...this.jobs.values()].some(job => job.hostId === hostId && job.state === 'completed' && job.thread?.id === threadId
      && Date.now() - Date.parse(job.updatedAt) < 60_000);
  }

  private dispatch(job: Job): void {
    // One dedicated helper receives one create instruction at a time. This also
    // prevents two idle preflights from merging requests into one native turn.
    if (this.closed || job.state !== 'pending' || this.inflight.size > 0) return;
    const work = this.create(job).catch(() => {
      // The last durable state already records whether creation may have run.
      console.error('[petroglyphs] Project chat creation could not update its receipt.');
    }).finally(() => this.inflight.delete(job.id));
    this.inflight.set(job.id, work);
  }

  private execution(job: Job): ProjectChatExecution {
    if (!job.executorThreadId || !job.requestPath) throw new ProjectCreationNotSentError();
    return { id: job.id, hostId: job.hostId, projectId: job.projectId, prompt: job.prompt,
      ...(job.title ? { title: job.title } : {}), createdAt: job.createdAt, executorThreadId: job.executorThreadId, requestPath: job.requestPath };
  }

  private immutableRequest(job: Job): void {
    const path = join(this.options.dataDir, 'requests', `${job.id}.json`);
    if (job.requestPath && job.requestPath !== path) throw new Error('Invalid immutable request path');
    const content = JSON.stringify({ requestId: job.id, hostId: job.hostId, projectId: job.projectId,
      prompt: job.prompt, ...(job.title ? { title: job.title } : {}) });
    try { writeFileSync(path, content, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o400 || readFileSync(path, 'utf8') !== content) {
      throw new Error('Immutable creation request changed');
    }
    job.requestPath = path;
  }

  private observe(job: Job, result: ProjectChatObservation): void {
    if (result.state === 'completed' && result.hostId === job.hostId && threadSchema.safeParse(result.thread).success
      && typeof result.firstTurnId === 'string' && result.firstTurnId.length > 0) {
      job.thread = result.thread; job.firstTurnId = result.firstTurnId; job.firstMessageId = result.firstMessageId; job.state = 'completed';
      delete job.error; delete job.notice;
      if (result.notice) job.notice = result.notice;
      return;
    }
    if (result.state !== 'creating' || job.state === 'unknown') {
      job.state = 'unknown'; job.notice = 'Codex has not confirmed a unique new chat. Check this project’s chats before creating another one. This request will not be sent again.';
    }
  }

  private async create(job: Job): Promise<void> {
    try {
      await this.options.catalog.require(job.hostId, job.projectId);
      if (!job.executorThreadId || job.executorThreadId !== this.options.executor.executorThreadId) throw new ProjectCreationNotSentError();
      this.immutableRequest(job);
      await this.options.executor.ready();
    } catch {
      if (this.closed) return;
      job.state = 'failed'; job.error = 'The chat was not created. Refresh the project and reconnect Codex Desktop before trying again.';
      this.save(job); return;
    }
    if (this.closed) return;
    job.state = 'creating'; this.save(job);
    const pending = setTimeout(() => {
      if (this.closed || job.state !== 'creating') return;
      job.state = 'unknown'; job.notice = 'Codex is still confirming creation. Check this project’s chats before creating another chat.';
      this.save(job);
    }, this.options.unknownAfterMs ?? 20_000);
    pending.unref();
    try {
      const result = await this.options.executor.createChat(this.execution(job));
      if (!this.closed) this.observe(job, result);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof ProjectCreationNotSentError) {
        job.state = error.busy ? 'pending' : 'failed'; delete job.notice;
        if (error.busy) job.notice = 'Waiting for the project-creation companion to finish its current request.';
        else job.error = 'The chat was not created. Reconnect the project-creation companion before trying again.';
      } else this.observe(job, { state: 'unknown' });
    } finally { clearTimeout(pending); if (!this.closed) this.save(job); }
  }

  close(): void { this.closed = true; clearInterval(this.timer); this.options.executor.close(); }
}
