import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CodexRoutingError, CodexThreads, isThreadId, type ThreadQuery } from './codex-threads.js';
import { AWAITING_CONFIRMATION_NOTICE, LEGACY_INTERRUPTED_ERROR, submissionMarker,
  type ReplyMessage, type SubmissionState, type SubmissionStatus, type SubmissionSummary } from './codex-replies.js';
import type { Submission } from './types.js';

const execFileAsync = promisify(execFile);
interface Settings { threadId?: string; deviceToken: string; codexPath: string; dataDir: string }
interface Job {
  id: string; threadId: string; imagePath: string; state: SubmissionState; createdAt: string; updatedAt: string;
  receipt?: string; error?: string; turnId?: string; replyScanCursor?: string | null; replyTurnCursor?: string;
  messages?: ReplyMessage[]; notice?: string; coalescedSubmissionIds?: string[];
}

export class CodexAutoReply {
  readonly devicePrefix: string;
  private busy = false;
  private readonly jobs: Job[] = [];
  private readonly threads: CodexThreads;
  private readonly replyPolls = new Map<string, { checkedAt: number; inflight?: Promise<SubmissionStatus> }>();

  constructor(private readonly settings: Settings) {
    if (!/^[0-9a-f]{32,}$/.test(settings.deviceToken)
      || !isAbsolute(settings.codexPath) || !isAbsolute(settings.dataDir)) throw new Error('Invalid Codex auto-reply configuration');
    this.devicePrefix = `/device/${settings.deviceToken}`;
    this.threads = new CodexThreads(settings.codexPath);
    mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(settings.dataDir).filter(n => n.endsWith('.json'))) {
      const job = JSON.parse(readFileSync(join(settings.dataDir, name), 'utf8')) as Job;
      if (!isThreadId(job.threadId)) throw new Error('Invalid saved Codex target');
      // A crash after CLI admission has an ambiguous outcome. Never replay it automatically.
      if (job.state === 'dispatching') { job.state = 'unknown'; job.error = 'Service restarted during dispatch; inspect Codex before retrying'; this.save(job); }
      this.recoverInterruptedFailure(job);
      this.jobs.push(job);
    }
    this.jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    void this.drain();
  }

  private save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    const path = join(this.settings.dataDir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  listThreads(query: ThreadQuery) { return this.threads.list(query); }

  listSubmissions(threadId: string): { submissions: SubmissionSummary[] } {
    if (!isThreadId(threadId)) throw new CodexRoutingError('A valid threadId is required.', 400);
    return { submissions: this.jobs.filter(job => job.threadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
      .map(job => ({ id: job.id, threadId: job.threadId, hostId: 'local', createdAt: job.createdAt })) };
  }

  private recoverInterruptedFailure(job: Job): void {
    if (job.state !== 'failed' || job.error !== LEGACY_INTERRUPTED_ERROR) return;
    // Repair only the known erroneous terminal cache. Keep the original queue
    // receipt, submission id, turn association and PNG; this never requeues it.
    job.state = 'unknown';
    delete job.error;
    job.notice = AWAITING_CONFIRMATION_NOTICE;
    this.save(job);
  }

  private submissionStatus(job: Job): SubmissionStatus {
    return {
      id: job.id, threadId: job.threadId, hostId: 'local', state: job.state, messages: job.messages ?? [],
      ...(job.error ? { error: job.error } : {}),
      ...(job.notice ? { notice: job.notice } : {}),
      ...(job.coalescedSubmissionIds ? { coalescedSubmissionIds: job.coalescedSubmissionIds } : {}),
    };
  }

  async getSubmission(id: string): Promise<SubmissionStatus> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!isThreadId(id) || !job) throw new CodexRoutingError('This submission is not available for this device.', 404);
    this.recoverInterruptedFailure(job);
    if (job.state === 'pending' || job.state === 'dispatching' || job.state === 'completed' || job.state === 'failed') {
      return this.submissionStatus(job);
    }
    const poll = this.replyPolls.get(id);
    if (poll?.inflight) return poll.inflight;
    if (poll && Date.now() - poll.checkedAt < 3000) return this.submissionStatus(job);
    const current: { checkedAt: number; inflight?: Promise<SubmissionStatus> } = { checkedAt: Date.now() };
    this.replyPolls.set(id, current);
    current.inflight = (async () => {
      try {
        const reply = await this.threads.readReply({
          id, threadId: job.threadId, turnId: job.turnId,
          scanCursor: job.replyScanCursor, turnCursor: job.replyTurnCursor,
          knownSubmissionIds: this.jobs.filter(candidate => candidate.threadId === job.threadId).map(candidate => candidate.id),
        });
        job.replyScanCursor = reply.scanCursor;
        job.replyTurnCursor = reply.turnCursor;
        if (reply.turnId) job.turnId = reply.turnId;
        if (reply.state) {
          job.state = reply.state;
          job.messages = reply.messages;
          job.error = reply.error;
          job.notice = reply.notice;
          job.coalescedSubmissionIds = reply.coalescedSubmissionIds;
        }
        this.save(job);
        return this.submissionStatus(job);
      } finally {
        current.checkedAt = Date.now();
        delete current.inflight;
      }
    })();
    return current.inflight;
  }

  async accept(submission: Submission, threadId: string): Promise<void> {
    const bytes = Buffer.from(submission.imageBase64, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new CodexRoutingError('Expected a PNG image.', 400);
    await this.threads.requireThread(threadId);
    const imagePath = join(this.settings.dataDir, `${submission.id}.png`);
    writeFileSync(imagePath, bytes, { mode: 0o600, flag: 'wx' });
    const job: Job = { id: submission.id, threadId, imagePath, state: 'pending', createdAt: submission.timestamp, updatedAt: submission.timestamp };
    this.save(job);
    this.jobs.push(job);
    setImmediate(() => { void this.drain(); });
  }

  status() {
    const latest = this.jobs.at(-1);
    return { enabled: true, pending: this.jobs.filter(j => j.state === 'pending' || j.state === 'dispatching').length,
      latest: latest ? { id: latest.id, threadId: latest.threadId, state: latest.state, error: latest.error } : null };
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const job of this.jobs) {
        if (job.state !== 'pending') continue;
        job.state = 'dispatching'; this.save(job);
        try {
          const message = `${submissionMarker(job.id)}请使用 view_image 读取这张本机 PNG：${job.imagePath}，然后用中文回复：若图中有明确问题就回答；否则简要说明看到了什么，意图不清楚时询问。请勿用最新图片工具替换这张指定图片，以免连续发送时混淆。`;
          const { stdout } = await execFileAsync(this.settings.codexPath,
            ['queue', '--thread', job.threadId, '--message', message],
            { timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` } });
          if (!stdout.includes('Queued message')) throw new Error('CLI did not return a queue receipt');
          job.state = 'queued'; job.receipt = stdout.trim();
        } catch {
          job.state = 'unknown'; job.error = 'Codex did not confirm queue admission. Inspect the selected chat before retrying.';
          console.error(`[petroglyphs] auto-reply outcome unknown for ${job.id}: ${job.error}`);
        }
        this.save(job);
      }
    } catch (error) { console.error('[petroglyphs] auto-reply storage failure:', error); }
    finally { this.busy = false; }
  }
}

export function loadAutoReply(): CodexAutoReply | null {
  const path = process.env.PETROGLYPHS_AUTO_REPLY_CONFIG;
  return path ? new CodexAutoReply(JSON.parse(readFileSync(path, 'utf8')) as Settings) : null;
}
