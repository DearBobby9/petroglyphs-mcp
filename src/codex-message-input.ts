import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CodexRoutingError, isThreadId } from './codex-threads.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
export const isCodexHost = (value: unknown): value is string => typeof value === 'string'
  && (value === 'local' || /^remote-control:env_[A-Za-z0-9_-]{1,128}$/.test(value));

export class ConversationError extends CodexRoutingError {
  constructor(message: string, status: number, readonly code: string) { super(message, status); }
}

export interface MessageAttachmentInput { id: string; name: string; mimeType: 'image/png' | 'image/jpeg'; dataBase64: string }
export interface MessageInput { id: string; hostId: string; threadId: string; text: string; attachments: MessageAttachmentInput[] }
const uuid = z.string().refine(isThreadId);
const inputSchema = z.object({
  id: uuid, hostId: z.string().refine(isCodexHost), threadId: uuid, text: z.string().max(20_000),
  attachments: z.array(z.object({ id: uuid, name: z.string().trim().min(1).max(200)
    .refine(name => !/[\x00-\x1f\x7f/\\]/.test(name)),
  mimeType: z.enum(['image/png', 'image/jpeg']), dataBase64: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
  }).strict()).max(4),
}).strict();

export function imageBytes(base64: string, mimeType: string): Buffer {
  if (base64.length === 0 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ConversationError('Each image must be valid base64 and no larger than 10 MiB.', 400, 'invalid_image');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new ConversationError('The image data is not valid base64.', 400, 'invalid_image');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ConversationError('Each image must be no larger than 10 MiB.', 413, 'image_too_large');
  const png = mimeType === 'image/png' && bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216
    && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (!png && !jpeg) throw new ConversationError('Attach a PNG or JPEG image matching its media type.', 400, 'invalid_image');
  return bytes;
}

export function parseMessageInput(value: unknown): MessageInput {
  const result = inputSchema.safeParse(value);
  if (!result.success) throw new ConversationError('Provide a valid message ID, chat, text and up to four PNG or JPEG images.', 400, 'invalid_message');
  const input = result.data;
  if (!input.text.trim() && input.attachments.length === 0) {
    throw new ConversationError('Enter a message or attach an image.', 400, 'empty_message');
  }
  if (new Set(input.attachments.map(attachment => attachment.id)).size !== input.attachments.length) {
    throw new ConversationError('Each attachment needs a different ID.', 400, 'invalid_attachment_id');
  }
  if (input.attachments.reduce((total, attachment) => total + imageBytes(attachment.dataBase64, attachment.mimeType).length, 0) > MAX_ATTACHMENT_BYTES) {
    throw new ConversationError('Attached images must total no more than 24 MiB.', 413, 'attachments_too_large');
  }
  return input;
}

export function messageFingerprint(input: MessageInput): string {
  return createHash('sha256').update(JSON.stringify({ id: input.id, hostId: input.hostId, threadId: input.threadId,
    text: input.text, attachments: input.attachments.map(attachment => ({ ...attachment,
      dataBase64: createHash('sha256').update(Buffer.from(attachment.dataBase64, 'base64')).digest('hex') })) })).digest('hex');
}
