import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { readSubmissionReply, type ReplyQuery, type ReplyResult } from './codex-replies.js';

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const interactiveSources = ['cli', 'vscode', 'appServer'];
const pageSchema = z.object({
  data: z.array(z.object({
    id: z.string().regex(threadIdPattern),
    name: z.string().nullable().optional(),
    cwd: z.string(),
    updatedAt: z.number().finite(),
    projectId: z.string().nullable().optional(),
    parentThreadId: z.string().nullable().optional(),
    ephemeral: z.boolean().optional(),
    source: z.unknown(),
  })),
  nextCursor: z.string().nullable(),
});

export interface CodexThread {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  projectId?: string;
  projectName?: string;
}

export interface ThreadQuery { search?: string; cursor?: string }
export interface ThreadPage { threads: CodexThread[]; nextCursor: string | null }

export class CodexRoutingError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && threadIdPattern.test(value);
}

// Keep each connection short lived. The desktop app does not always expose a
// control socket, but a stdio app-server can read the same local thread store.
class CodexSession {
  private readonly child;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private buffer = '';
  private bytesRead = 0;
  private failure: Error | undefined;
  private closing = false;
  private readonly exited: Promise<void>;
  private readonly deadline: NodeJS.Timeout;

  constructor(codexPath: string, timeoutMs: number) {
    this.child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    this.deadline = setTimeout(() => {
      this.fail(new CodexRoutingError('Codex chat lookup timed out. Try again.', 503));
    }, timeoutMs);
    this.exited = new Promise(resolve => {
      this.child.once('close', () => {
        clearTimeout(this.deadline);
        if (!this.closing) this.fail(new CodexRoutingError('Codex chat lookup is unavailable.', 503));
        resolve();
      });
    });
    this.child.on('error', () => this.fail(new CodexRoutingError('Could not start Codex chat lookup.', 503)));
    this.child.stdin.on('error', () => this.fail(new CodexRoutingError('Codex chat lookup disconnected.', 503)));
    // stderr can contain local configuration and account details. Never return
    // it in an HTTP error or persist it in a submission receipt.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private receive(chunk: string): void {
    if (this.failure || this.closing) return;
    this.bytesRead += Buffer.byteLength(chunk);
    if (this.bytesRead > 16 * 1024 * 1024) {
      this.fail(new CodexRoutingError('Codex chat lookup returned too much data.', 503));
      return;
    }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; result?: unknown; error?: unknown };
      try { message = JSON.parse(line); }
      catch { this.fail(new CodexRoutingError('Codex returned an invalid chat response.', 503)); return; }
      if (!message || typeof message !== 'object') {
        this.fail(new CodexRoutingError('Codex returned an invalid chat response.', 503));
        return;
      }
      const request = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!request) continue;
      this.pending.delete(message.id!);
      if (message.error) request.reject(new CodexRoutingError('Codex could not load chats. Refresh and try again.', 503));
      else request.resolve(message.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'petroglyphs', title: 'Petroglyphs', version: '0.1.0' },
      capabilities: null,
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.deadline);
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      this.child.kill('SIGKILL');
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 500);
    try { await this.exited; }
    finally { clearTimeout(forceKill); }
  }
}

export class CodexThreads {
  private activeLookups = 0;

  constructor(private readonly codexPath: string, private readonly timeoutMs = 8_000) {}

  private async withSession<T>(work: (session: CodexSession) => Promise<T>): Promise<T> {
    if (this.activeLookups >= 4) throw new CodexRoutingError('Codex chat lookup is busy. Try again.', 503);
    this.activeLookups++;
    let session: CodexSession | undefined;
    try {
      session = new CodexSession(this.codexPath, this.timeoutMs);
      await session.initialize();
      return await work(session);
    } finally {
      try { await session?.close(); }
      finally { this.activeLookups--; }
    }
  }

  private async page(session: CodexSession, query: ThreadQuery, limit: number): Promise<ThreadPage> {
    const result = await session.request('thread/list', {
      limit,
      archived: false,
      sourceKinds: interactiveSources,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(query.search ? { searchTerm: query.search } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const parsed = pageSchema.safeParse(result);
    if (!parsed.success) throw new CodexRoutingError('Codex returned an invalid chat list.', 503);
    return {
      threads: parsed.data.data
        .filter(thread => !thread.ephemeral && !thread.parentThreadId && isAbsolute(thread.cwd)
          && typeof thread.source === 'string' && interactiveSources.includes(thread.source))
        .map(thread => ({
          id: thread.id,
          title: thread.name?.trim() || '未命名聊天',
          cwd: thread.cwd,
          updatedAt: thread.updatedAt,
          ...(thread.projectId ? { projectId: thread.projectId } : {}),
        })),
      nextCursor: parsed.data.nextCursor,
    };
  }

  list(query: ThreadQuery): Promise<ThreadPage> {
    return this.withSession(session => this.page(session, query, 50));
  }

  readReply(query: ReplyQuery): Promise<ReplyResult> {
    return this.withSession(session => readSubmissionReply((method, params) => session.request(method, params), query));
  }

  async requireThread(threadId: string): Promise<void> {
    if (!isThreadId(threadId)) throw new CodexRoutingError('A valid threadId is required.', 400);
    // thread/read also accepts archived chats. Validate against a fresh active
    // list so a saved iPad selection cannot revive or target an archived chat.
    await this.withSession(async session => {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const page = await this.page(session, { cursor }, 100);
        if (page.threads.some(thread => thread.id === threadId)) return;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seenCursors.has(cursor)) throw new CodexRoutingError('Codex chat pagination did not advance.', 503);
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      throw new CodexRoutingError('The selected chat is unavailable on this Mac. Choose another chat.', 404);
    });
  }
}
