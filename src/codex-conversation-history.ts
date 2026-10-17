import { createHash } from 'node:crypto';
import { isDesktopBusy } from './codex-desktop-ipc.js';
import { ConversationError } from './codex-message-input.js';
import type { SubmissionState } from './codex-replies.js';
import { resultImageInputs, type ResultImageUnavailableReason } from './codex-result-images.js';

export interface ConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  availability: 'available' | 'unavailable';
  byteCount?: number;
  assetPath?: string;
  unavailableReason?: ResultImageUnavailableReason;
}
export interface ConversationMessage {
  id: string;
  turnId?: string;
  clientMessageId?: string;
  role: 'user' | 'assistant';
  text: string;
  phase: 'user' | 'commentary' | 'final_answer' | 'unknown';
  createdAt: string | null;
  state: SubmissionState | 'cancelled';
  attachments: ConversationAttachment[];
  omittedAttachmentCount?: number;
}
export interface HistoryMessage extends ConversationMessage {
  /** Never exposed directly: only data URLs may be converted into paired assets. */
  imageInputs: unknown[];
  legacyDrawingId?: string;
}
export interface HistoryTurn { id: string; status: string; items: Record<string, unknown>[]; params?: Record<string, unknown>; createdAt: string | null }
export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function timestamp(value: unknown): string | null {
  const number = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : undefined;
  const date = typeof value === 'string' || number !== undefined ? new Date(number ?? value as string) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function historyTurns(state: unknown, threadId: string): HistoryTurn[] {
  const conversation = record(state);
  if (!conversation || conversation.id !== threadId) throw new ConversationError('Codex returned a different chat.', 503, 'invalid_snapshot');
  const history = record(record(conversation.turnHistory)?.history);
  const values: unknown[] = [];
  if (history) {
    const entities = record(history.entitiesByKey);
    if (!entities || !Array.isArray(history.islands)) throw new ConversationError('Codex chat history is not ready.', 503, 'history_unavailable');
    for (const island of history.islands) {
      const entries = record(island)?.entries;
      if (!Array.isArray(entries)) throw new ConversationError('Codex chat history is incomplete.', 503, 'history_unavailable');
      for (const entry of entries) {
        const key = record(entry)?.value;
        if (typeof key !== 'string' || !record(entities[key])) throw new ConversationError('Codex chat history is incomplete.', 503, 'history_unavailable');
        values.push(entities[key]);
      }
    }
  }
  if (Array.isArray(conversation.turns)) values.push(...conversation.turns);
  if (!history && !Array.isArray(conversation.turns)) throw new ConversationError('Codex chat history is not loaded.', 503, 'history_unavailable');
  const turns = new Map<string, HistoryTurn>();
  for (const value of values) {
    const turn = record(value);
    const id = turn?.turnId ?? turn?.id;
    if (!turn || typeof id !== 'string' || !Array.isArray(turn.items)) throw new ConversationError('Codex chat history is incomplete.', 503, 'history_unavailable');
    turns.set(id, { id, status: String(turn.status ?? 'unknown'), items: turn.items.map(record).filter((item): item is Record<string, unknown> => !!item),
      params: record(turn.params), createdAt: timestamp(turn.turnStartedAtMs ?? turn.startedAt ?? turn.createdAt ?? turn.startTime) });
  }
  return [...turns.values()];
}

// Remove only the two exact application-generated wrappers. Ordinary text that
// happens to mention Petroglyphs or a submission ID is preserved verbatim.
function drawingText(text: string): { text: string; id?: string } {
  const marker = /^Petroglyphs 自动消息：iPad 刚发送了一张图，提交 ID ([0-9a-f-]{36})。/;
  const match = marker.exec(text);
  if (!match) return { text };
  const tail = text.slice(match[0].length);
  if (tail === '请查看本条消息附带的画布图片，用中文回复：若图中有明确问题就回答；否则简要说明看到了什么，意图不清楚时询问。请以本条消息的图片为准。'
    || /^请使用 view_image 读取这张本机 PNG：[^\r\n]+，然后用中文回复：若图中有明确问题就回答；否则简要说明看到了什么，意图不清楚时询问。请勿用最新图片工具替换这张指定图片，以免连续发送时混淆。$/.test(tail)) {
    return { text: '', id: match[1] };
  }
  return { text };
}

export function historyMessages(turns: HistoryTurn[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const turn of turns) {
    const userItems = turn.items.filter(item => item.type === 'userMessage');
    const state: SubmissionState = turn.status === 'inProgress' ? 'running' : turn.status === 'completed' ? 'completed'
      : turn.status === 'failed' ? 'failed' : 'unknown';
    for (const [index, item] of turn.items.entries()) {
      const resultImages = resultImageInputs(item);
      if (item.type !== 'userMessage' && item.type !== 'agentMessage' && resultImages.length === 0) continue;
      const user = item.type === 'userMessage';
      if (!user && item.type === 'agentMessage' && typeof item.text !== 'string' && resultImages.length === 0) continue;
      if (!user && item.type === 'agentMessage' && item.phase !== undefined && item.phase !== null
        && item.phase !== 'commentary' && item.phase !== 'final_answer') continue;
      const content = user && Array.isArray(item.content) ? item.content.map(record).filter((value): value is Record<string, unknown> => !!value) : [];
      const sourceText = user ? content.filter(value => value.type === 'text' && typeof value.text === 'string').map(value => value.text).join('\n')
        : item.type === 'agentMessage' && typeof item.text === 'string' ? item.text : '';
      const drawing = user ? drawingText(sourceText) : { text: sourceText };
      const rawId = typeof item.id === 'string' ? item.id : `position-${index}`;
      const id = createHash('sha256').update(`${turn.id}\0${rawId}`).digest('hex');
      const clientMessageId = user ? (typeof item.clientId === 'string' ? item.clientId
        : typeof item.clientUserMessageId === 'string' ? item.clientUserMessageId
        : userItems.length === 1 && typeof turn.params?.clientUserMessageId === 'string' ? turn.params.clientUserMessageId
          : typeof item.id === 'string' ? item.id : undefined) : undefined;
      messages.push({ id, turnId: turn.id, ...(clientMessageId ? { clientMessageId } : {}), role: user ? 'user' : 'assistant',
        text: drawing.text, phase: user ? 'user' : item.type !== 'agentMessage' ? 'final_answer'
          : item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : 'unknown',
        createdAt: timestamp(item.createdAt ?? item.timestamp) ?? turn.createdAt, state, attachments: [],
        imageInputs: user ? content.filter(value => value.type === 'image' || value.type === 'localImage') : resultImages,
        ...(drawing.id ? { legacyDrawingId: drawing.id } : {}),
      });
    }
  }
  return messages;
}

export function conversationRunState(state: unknown): 'idle' | 'running' | 'waiting' | 'unknown' {
  const value = record(state);
  if (!value) return 'unknown';
  if (Array.isArray(value.requests) && value.requests.length > 0) return 'waiting';
  if (isDesktopBusy(value)) return 'running';
  if (record(value.threadRuntimeStatus)?.type === 'idle' || value.resumeState === 'resumed') return 'idle';
  return 'unknown';
}
