import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CodexRoutingError, isThreadId } from './codex-threads.js';
import { CodexDesktopIpcError } from './codex-desktop-ipc.js';
import { attributeSubmissionReply, submissionIdsInUserMessage, submissionMarker, type ReplyResult, type SubmissionState,
  type SubmissionStatus, type SubmissionSummary } from './codex-replies.js';

export interface DesktopConnection {
  readSnapshot(hostId: string, threadId: string): Promise<{ hostId: string; threadId: string; conversationState: unknown }>;
  startImageTurn(input: { hostId: string; threadId: string; submissionId: string; imageBase64: string; prompt: string }):
    Promise<{ turnId?: string; clientUserMessageId: string }>;
  close(): void;
}

interface Job {
  id: string;
  hostId: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
  state: SubmissionState;
  turnId?: string;
  turnFinished?: boolean;
  deliveryCode?: string;
  error?: string;
  notice?: string;
  reply?: ReplyResult;
}

interface Options {
  dataDir: string;
  connect: () => Promise<DesktopConnection>;
  retryMs?: number;
}

interface DesktopReplyResult extends ReplyResult { turnFinished?: boolean }

const hostPattern = /^remote-control:env_[A-Za-z0-9_-]{1,128}$/;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Locate the submitted input in a fully hydrated Desktop snapshot. */
export async function readDesktopSubmissionReply(state: unknown, job: {
  id: string; threadId: string; turnId?: string; knownSubmissionIds: string[];
}): Promise<DesktopReplyResult> {
  const conversation = object(state);
  if (!conversation || conversation.id !== job.threadId) throw new Error('Desktop returned a different chat');
  const history = object(object(conversation.turnHistory)?.history);
  let turns: Record<string, unknown>[];
  if (history) {
    const entities = object(history.entitiesByKey);
    if (!entities || !Array.isArray(history.islands)) throw new Error('Invalid Desktop history');
    const keys = history.islands.flatMap(island => {
      const entries = object(island)?.entries;
      if (!Array.isArray(entries)) throw new Error('Invalid Desktop history island');
      return entries.map(entry => object(entry)?.value);
    });
    turns = [...new Set(keys)].map(key => {
      if (typeof key !== 'string' || !object(entities[key])) throw new Error('Incomplete Desktop history');
      return entities[key] as Record<string, unknown>;
    });
  } else if (Array.isArray(conversation.turns)) {
    turns = conversation.turns.map(turn => {
      const parsed = object(turn);
      if (!parsed) throw new Error('Invalid Desktop turn');
      return parsed;
    });
  } else throw new Error('Desktop history is not loaded');

  const normalized = turns.map(turn => {
    const id = turn.turnId ?? turn.id;
    if (typeof id !== 'string' || !Array.isArray(turn.items)) throw new Error('Invalid Desktop turn items');
    return { id, status: turn.status, error: turn.error, items: turn.items };
  });
  // Desktop has already loaded the full history. Paging this snapshot through
  // the local RPC scanner would repeatedly hide old markers after a lost receipt.
  const matched = job.turnId ? normalized.find(turn => turn.id === job.turnId)
    : [...normalized].reverse().find(turn => turn.items.some(item => submissionIdsInUserMessage(item)?.includes(job.id)));
  const reply: ReplyResult = matched ? attributeSubmissionReply(matched, matched.items, job)
    : job.turnId ? { turnId: job.turnId, messages: [], state: 'unknown',
      notice: 'The submission was found, but its response status is not available yet. Updates will retry.' }
      : { messages: [] };
  const sharedInput = matched?.items.some(item => {
    const message = object(item);
    if (message?.type !== 'userMessage' || !Array.isArray(message.content)) return false;
    const text = message.content.flatMap(content => {
      const value = object(content);
      return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    }).join('\n');
    return !job.knownSubmissionIds.some(id => text.includes(submissionMarker(id)));
  });
  if (sharedInput && reply.messages.length > 0) {
    reply.notice = [reply.notice, 'Codex combined this drawing with other input in the same reply.'].filter(Boolean).join(' ');
  }
  // Reply attribution can remain unknown after a shared or interrupted turn.
  // The actual Desktop turn lifecycle, independently, determines queue release.
  return { ...reply, ...(matched ? { turnFinished: ['completed', 'failed', 'interrupted'].includes(String(matched.status)) } : {}) };
}

/** Durable receipts are shared by neither hosts nor transports. Never replay an uncertain send. */
export class DesktopSubmissions {
  private readonly jobs: Job[] = [];
  private readonly polls = new Map<string, { checkedAt: number; inflight?: Promise<SubmissionStatus> }>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private connection?: Promise<DesktopConnection>;
  private draining = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.dataDir)) throw new Error('Desktop receipt directory must be absolute');
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(options.dataDir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
      const job = JSON.parse(readFileSync(join(options.dataDir, name), 'utf8')) as Job;
      if (!isThreadId(job.id) || name !== `${job.id}.json` || !isThreadId(job.threadId) || !hostPattern.test(job.hostId)) {
        throw new Error('Invalid Desktop receipt');
      }
      if (job.state === 'dispatching') {
        job.state = 'unknown';
        job.notice = 'The service restarted while sending. Checking the original chat before any retry.';
        this.save(job);
      }
      this.jobs.push(job);
    }
    this.jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.timer = setInterval(() => { void this.drain(); }, options.retryMs ?? 3000);
    this.timer.unref();
    void this.drain();
  }

  private getConnection(): Promise<DesktopConnection> {
    return this.connection ??= this.options.connect().catch(error => { this.connection = undefined; throw error; });
  }

  private resetConnection(): void {
    const old = this.connection;
    this.connection = undefined;
    void old?.then(connection => connection.close()).catch(() => {});
  }

  private save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    const path = join(this.options.dataDir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  async accept(hostId: string, threadId: string, imageBase64: string) {
    if (!hostPattern.test(hostId) || !isThreadId(threadId)) throw new CodexRoutingError('Choose a valid remote chat.', 400);
    if (imageBase64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
      throw new CodexRoutingError('Send a PNG drawing no larger than 10 MiB.', 413);
    }
    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new CodexRoutingError('Send a PNG drawing no larger than 10 MiB.', 413);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new CodexRoutingError('Expected a PNG image.', 400);
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const job: Job = { id, hostId, threadId, state: 'pending', createdAt: timestamp, updatedAt: timestamp };
    writeFileSync(join(this.options.dataDir, `${id}.png`), bytes, { flag: 'wx', mode: 0o600 });
    this.save(job);
    this.jobs.push(job);
    setImmediate(() => { void this.drain(); });
    return { id, threadId, hostId, status: 'received' as const };
  }

  has(hostId: string, id: string): boolean { return this.jobs.some(job => job.hostId === hostId && job.id === id); }

  list(hostId: string, threadId: string): { submissions: SubmissionSummary[] } {
    return { submissions: this.jobs.filter(job => job.hostId === hostId && job.threadId === threadId)
      .slice(-20).reverse().map(({ id, threadId, hostId, createdAt }) => ({ id, threadId, hostId, createdAt })) };
  }

  private status(job: Job): SubmissionStatus {
    return { id: job.id, hostId: job.hostId, threadId: job.threadId, state: job.state,
      messages: job.reply?.messages ?? [], ...(job.error ? { error: job.error } : {}),
      ...(job.notice ? { notice: job.notice } : {}),
      ...(job.reply?.coalescedSubmissionIds ? { coalescedSubmissionIds: job.reply.coalescedSubmissionIds } : {}) };
  }

  async get(hostId: string, id: string): Promise<SubmissionStatus> {
    const job = this.jobs.find(job => job.hostId === hostId && job.id === id);
    if (!job) throw new CodexRoutingError('This submission is not available for this connection.', 404);
    if (['pending', 'dispatching', 'completed', 'failed'].includes(job.state)) return this.status(job);
    const cached = this.polls.get(id);
    if (cached?.inflight) return cached.inflight;
    if (cached && Date.now() - cached.checkedAt < 3000) return this.status(job);
    const poll: { checkedAt: number; inflight?: Promise<SubmissionStatus> } = { checkedAt: Date.now() };
    this.polls.set(id, poll);
    poll.inflight = (async () => {
      try {
        await this.refresh(job);
        return this.status(job);
      } catch {
        this.resetConnection();
        throw new CodexRoutingError('Codex Desktop replies are temporarily unavailable. Updates will retry.', 503);
      } finally { poll.checkedAt = Date.now(); delete poll.inflight; }
    })();
    return poll.inflight;
  }

  private refresh(job: Job): Promise<void> {
    const current = this.refreshes.get(job.id);
    if (current) return current;
    const refresh = this.readReply(job).finally(() => { this.refreshes.delete(job.id); });
    this.refreshes.set(job.id, refresh);
    return refresh;
  }

  private async readReply(job: Job): Promise<void> {
    const snapshot = await (await this.getConnection()).readSnapshot(job.hostId, job.threadId);
    if (snapshot.hostId !== job.hostId || snapshot.threadId !== job.threadId) throw new Error('Desktop returned another target');
    const reply = await readDesktopSubmissionReply(snapshot.conversationState, {
      id: job.id, threadId: job.threadId, turnId: job.turnId,
      knownSubmissionIds: this.jobs.filter(other => other.hostId === job.hostId && other.threadId === job.threadId).map(other => other.id),
    });
    if (reply.turnId) job.turnId = reply.turnId;
    if (reply.turnFinished !== undefined) job.turnFinished = reply.turnFinished;
    if (reply.state) {
      job.state = reply.state;
      job.reply = reply;
      job.error = reply.error;
      job.notice = reply.notice;
    }
    this.save(job);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      for (const [index, job] of this.jobs.entries()) {
        if (this.closed || job.state !== 'pending') continue;
        const prior = this.jobs.slice(0, index).find(other => other.hostId === job.hostId && other.threadId === job.threadId
          && !other.turnFinished
          && ['pending', 'dispatching', 'queued', 'running', 'unknown'].includes(other.state));
        if (prior) {
          if (prior.state === 'pending' || prior.state === 'dispatching') continue;
          try { await this.refresh(prior); } catch { this.resetConnection(); continue; }
          if (!prior.turnFinished && !['completed', 'failed'].includes(prior.state)) continue;
        }
        let connection: DesktopConnection;
        try { connection = await this.getConnection(); }
        catch { job.notice = 'Waiting for Codex Desktop to reconnect.'; this.save(job); continue; }
        job.state = 'dispatching';
        delete job.notice;
        this.save(job);
        try {
          const result = await connection.startImageTurn({ hostId: job.hostId, threadId: job.threadId,
            submissionId: job.id, imageBase64: readFileSync(join(this.options.dataDir, `${job.id}.png`)).toString('base64'),
            prompt: `${submissionMarker(job.id)}请查看本条消息附带的画布图片，用中文回复：若图中有明确问题就回答；否则简要说明看到了什么，意图不清楚时询问。请以本条消息的图片为准。` });
          if (result.clientUserMessageId !== job.id) throw new Error('Unexpected message receipt');
          job.turnId = result.turnId;
          job.state = 'queued';
          delete job.error;
        } catch (error) {
          const details = object(error);
          if (error instanceof CodexDesktopIpcError) job.deliveryCode = error.code;
          if (details?.outcome === 'not_sent') {
            if (details.status === 400 || details.status === 404 || details.status === 413) {
              job.state = 'failed';
              job.error = 'Codex could not accept this drawing or target. Refresh the selected chat before sending again.';
            } else {
              job.state = 'pending';
              job.notice = details.status === 409 ? 'Waiting for the current Codex reply to finish.' : 'Waiting for the selected Codex connection.';
            }
          } else {
            job.state = 'unknown';
            job.notice = details?.code === 'follower_timeout'
              ? 'Waiting for Codex Desktop to confirm delivery. Updates will continue without sending the drawing again.'
              : 'Codex did not confirm this send. Checking the original chat; the image will not be sent again automatically.';
          }
          if (details?.status !== 409) this.resetConnection();
        }
        this.save(job);
      }
    } catch (error) {
      console.error('[petroglyphs] Desktop receipt processing failed:', error instanceof Error ? error.name : 'Error');
    } finally { this.draining = false; }
  }

  close(): void { this.closed = true; clearInterval(this.timer); this.resetConnection(); }
}
