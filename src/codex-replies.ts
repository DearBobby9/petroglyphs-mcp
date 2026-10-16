import { z } from 'zod';

export type SubmissionState = 'pending' | 'dispatching' | 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
export interface ReplyMessage { id: string; text: string; phase: 'commentary' | 'final_answer' | 'unknown' }
export interface SubmissionStatus {
  id: string;
  threadId: string;
  hostId: string;
  state: SubmissionState;
  messages: ReplyMessage[];
  error?: string;
  notice?: string;
  coalescedSubmissionIds?: string[];
}
export interface SubmissionSummary { id: string; threadId: string; hostId: string; createdAt: string }
export const LEGACY_INTERRUPTED_ERROR = 'The Codex response was interrupted. Open the chat on the Mac to continue.';
export const AWAITING_CONFIRMATION_NOTICE = 'Waiting for Codex to confirm this response status. Updates will continue.';
export interface ReplyQuery {
  id: string;
  threadId: string;
  knownSubmissionIds: string[];
  turnId?: string;
  scanCursor?: string | null;
  turnCursor?: string;
}
export interface ReplyResult {
  turnId?: string;
  scanCursor?: string | null;
  turnCursor?: string;
  state?: 'running' | 'completed' | 'failed' | 'unknown';
  messages: ReplyMessage[];
  error?: string;
  notice?: string;
  coalescedSubmissionIds?: string[];
}
type Rpc = (method: string, params: unknown) => Promise<unknown>;
const itemPageSchema = z.object({
  data: z.array(z.object({ turnId: z.string(), item: z.unknown() })),
  nextCursor: z.string().nullable(),
});
const replyTurnSchema = z.object({
  id: z.string(),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  error: z.object({ codexErrorInfo: z.unknown().optional() }).nullable().optional(),
});
const turnPageSchema = z.object({
  data: z.array(replyTurnSchema),
  nextCursor: z.string().nullable(),
});
const userSchema = z.object({ type: z.literal('userMessage'), id: z.string(), content: z.array(z.unknown()) });
const textSchema = z.object({ type: z.literal('text'), text: z.string() });
const agentSchema = z.object({
  type: z.literal('agentMessage'), id: z.string(), text: z.string(),
  phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
});

export function submissionMarker(id: string): string {
  return `Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ${id}。`;
}

/** Only user messages can establish submission attribution. */
export function submissionIdsInUserMessage(item: unknown): string[] | undefined {
  const user = userSchema.safeParse(item);
  if (!user.success) return undefined;
  const ids = new Set<string>();
  for (const content of user.data.content) {
    const text = textSchema.safeParse(content);
    if (!text.success) continue;
    for (const match of text.data.text.matchAll(/Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})。/g)) ids.add(match[1]);
  }
  return [...ids];
}

function parseItems(value: unknown) {
  const result = itemPageSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid Codex reply items');
  return result.data;
}

function failureMessage(status: string, info: unknown): string | undefined {
  if (status !== 'failed') return undefined;
  switch (info) {
    case 'rateLimitExceeded': return 'Codex reached a rate limit. Open the chat on the Mac to retry later.';
    case 'usageLimitExceeded': return 'Codex reached its usage limit. Open the chat on the Mac for details.';
    case 'sessionBudgetExceeded': return 'This Codex session reached its budget. Open the chat on the Mac to continue.';
    case 'contextWindowExceeded': return 'The Codex chat reached its context limit. Open the chat on the Mac to continue.';
    case 'unauthorized': return 'Codex needs authentication. Sign in on the Mac, then continue in the chat.';
    case 'tooManyDenials': return 'Codex could not continue after denied actions. Open the chat on the Mac.';
    default: return 'Codex could not complete this response. Open the chat on the Mac for details.';
  }
}

export async function readSubmissionReply(rpc: Rpc, query: ReplyQuery): Promise<ReplyResult> {
  let turnId = query.turnId;
  let scanCursor = query.scanCursor;
  if (!turnId) {
    // Always inspect the newest page for a queued message that has just started.
    // An older continuation lets legacy receipts progress without scanning the
    // complete chat on every iPad poll.
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const page = parseItems(await rpc('thread/items/list', {
        threadId: query.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      }));
      const match = page.data.find(entry => submissionIdsInUserMessage(entry.item)?.includes(query.id));
      if (match) { turnId = match.turnId; break; }
      const next = pageNumber === 0 && query.scanCursor !== undefined ? query.scanCursor : page.nextCursor;
      scanCursor = next;
      if (!next) break;
      if (seen.has(next)) throw new Error('Codex reply pagination did not advance');
      seen.add(next);
      cursor = next;
    }
    if (!turnId) return { messages: [], scanCursor };
  }

  let turn: z.infer<typeof turnPageSchema>['data'][number] | undefined;
  let turnCursor = query.turnCursor;
  let cursor: string | undefined;
  const seenTurns = new Set<string>();
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const result = turnPageSchema.safeParse(await rpc('thread/turns/list', {
      threadId: query.threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}),
    }));
    if (!result.success) throw new Error('Invalid Codex reply turn');
    turn = result.data.data.find(candidate => candidate.id === turnId);
    if (turn) { turnCursor = cursor; break; }
    const next = pageNumber === 0 && query.turnCursor ? query.turnCursor : result.data.nextCursor;
    turnCursor = next ?? undefined;
    if (!next) break;
    if (seenTurns.has(next)) throw new Error('Codex reply turn pagination did not advance');
    seenTurns.add(next);
    cursor = next;
  }
  if (!turn) return {
    turnId, scanCursor, turnCursor, messages: [], state: 'unknown',
    notice: 'The submission was found, but its response status is not available yet. Updates will retry.',
  };

  const items: unknown[] = [];
  cursor = undefined;
  const seenItems = new Set<string>();
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = parseItems(await rpc('thread/items/list', {
      threadId: query.threadId, turnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}),
    }));
    if (page.data.some(entry => entry.turnId !== turnId)) throw new Error('Codex returned another turn in the reply');
    items.push(...page.data.map(entry => entry.item));
    if (!page.nextCursor) { cursor = undefined; break; }
    if (seenItems.has(page.nextCursor)) throw new Error('Codex reply item pagination did not advance');
    seenItems.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  if (cursor) throw new Error('Codex reply exceeds the per-request item limit');

  return { ...attributeSubmissionReply(turn, items, query), turnCursor };
}

/** Attribute a complete turn without imposing transport-specific paging limits. */
export function attributeSubmissionReply(turnValue: unknown, items: readonly unknown[],
  query: Pick<ReplyQuery, 'id' | 'knownSubmissionIds'>): ReplyResult {
  const parsedTurn = replyTurnSchema.safeParse(turnValue);
  if (!parsedTurn.success) throw new Error('Invalid Codex reply turn');
  const turn = parsedTurn.data;
  const turnId = turn.id;
  const targetIndex = items.findIndex(item => submissionIdsInUserMessage(item)?.includes(query.id));
  if (targetIndex < 0) return {
    turnId, messages: [], state: 'unknown',
    notice: 'The matched response no longer contains this submission. Open the chat on the Mac to inspect it.',
  };
  const known = new Set(query.knownSubmissionIds);
  const isUnrelated = (ids: string[]) => ids.length === 0 || ids.some(id => !known.has(id));
  let blockStart = 0;
  for (let index = 0; index < targetIndex; index++) {
    const ids = submissionIdsInUserMessage(items[index]);
    if (ids && isUnrelated(ids)) blockStart = index + 1;
  }
  let lastInput = targetIndex;
  const related = new Set<string>();
  for (let index = blockStart; index < items.length; index++) {
    const ids = submissionIdsInUserMessage(items[index]);
    if (!ids) continue;
    if (index >= targetIndex && isUnrelated(ids)) return {
      turnId, messages: [], state: 'unknown',
      notice: 'Other input joined this Codex response. Open the chat on the Mac to view the combined conversation.',
    };
    for (const id of ids) related.add(id);
    lastInput = index;
  }
  // Only public assistant text after the associated input block can leave the
  // service. Tool results, plans, reasoning and earlier answers are discarded.
  const messages: ReplyMessage[] = [];
  for (const item of items.slice(lastInput + 1)) {
    const agent = agentSchema.safeParse(item);
    if (agent.success) messages.push({ id: agent.data.id, text: agent.data.text, phase: agent.data.phase ?? 'unknown' });
  }
  const coalescedSubmissionIds = related.size > 1 ? [...related] : undefined;
  // A separate short-lived reader can reconstruct an active desktop turn as
  // interrupted with no error. Only an explicit failed turn is terminal here.
  const notices = [
    ...(turn.status === 'interrupted' ? [AWAITING_CONFIRMATION_NOTICE] : []),
    ...(coalescedSubmissionIds ? ['Codex processed these submissions in the same turn. This reply is shared by those submissions.'] : []),
  ];
  return {
    turnId, messages,
    state: turn.status === 'inProgress' ? 'running' : turn.status === 'completed' ? 'completed'
      : turn.status === 'failed' ? 'failed' : 'unknown',
    error: failureMessage(turn.status, turn.error?.codexErrorInfo),
    ...(coalescedSubmissionIds ? { coalescedSubmissionIds } : {}),
    ...(notices.length ? { notice: notices.join(' ') } : {}),
  };
}
