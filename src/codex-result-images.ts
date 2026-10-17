import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { imageBytes, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES } from './codex-message-input.js';

export type ResultImageInput = {
  type: 'resultImage';
  source: 'generated' | 'assistant' | 'tool';
  name: string;
  url: string;
};

export type ResultImageUnavailableReason =
  | 'remote_file_unsupported' | 'outside_workspace' | 'unsupported_source'
  | 'invalid_image' | 'image_too_large' | 'image_missing' | 'snapshot_unavailable'
  | 'total_size_exceeded';

type ResultAttachment = {
  id: string;
  name: string;
  mimeType: string;
  availability: 'available' | 'unavailable';
  byteCount?: number;
  assetPath?: string;
  unavailableReason?: ResultImageUnavailableReason;
};
type PersistedAsset = Pick<ResultAttachment, 'id' | 'name' | 'mimeType' | 'availability'>
  & Partial<Pick<ResultAttachment, 'byteCount' | 'assetPath'>>;
type PersistAsset = (name: string, mimeType: 'image/png' | 'image/jpeg', bytes: Buffer) => PersistedAsset;
type Request = { hostId: string; threadId: string; messageId: string; cwd?: string; inputs: readonly ResultImageInput[] };
type SnapshotManifest = { version: 1; hostId: string; threadId: string; messageId: string; inputDigest: string; attachment: ResultAttachment };
type AttachmentResult = { attachments: ResultAttachment[]; omittedAttachmentCount: number };
type ImageBytes = { mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer };

const mimeExtensions = new Map<string, 'image/png' | 'image/jpeg'>([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg']]);
const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;
const safeHost = (hostId: string) => hostId === 'local' || /^remote-control:env_[A-Za-z0-9_-]{1,128}$/.test(hostId);
const safeThread = (threadId: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId);
const within = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function displayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return clean || fallback;
}

function imageInput(source: ResultImageInput['source'], name: unknown, url: unknown, fallback: string): ResultImageInput | undefined {
  if (typeof url !== 'string' || url.length === 0) return;
  return { type: 'resultImage', source, name: displayName(name, fallback), url };
}

function withoutCode(text: string): string {
  const lines = text.split('\n');
  let fence: { char: string; length: number } | undefined;
  const visible = lines.map(line => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length
        && new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      return ' '.repeat(line.length);
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      return ' '.repeat(line.length);
    }
    return line;
  }).join('\n');
  return visible.replace(/(^|[^\\])(`+)([\s\S]*?)\2/g, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length));
}

type MarkdownImageMatch = [string, string, string] & { index: number };

type MarkdownScanIndex = {
  nextOpener: Int32Array;
  nextAltStop: Int32Array;
  nextAngleStop: Int32Array;
  nextDoubleQuoteStop: Int32Array;
  nextSingleQuoteStop: Int32Array;
  nextNonWhitespace: Int32Array;
  // A non-negative value is the first bare-URL stop. A negative value
  // encodes the position of a malformed backslash escape as -(position + 1).
  bareResult: Int32Array;
};

const markdownWhitespace = /\s/;

function isMarkdownWhitespace(value: string | undefined): boolean {
  return value !== undefined && markdownWhitespace.test(value);
}

function isMarkdownNewline(value: string | undefined): boolean {
  return value === '\n';
}

function isMarkdownDotLineTerminator(value: string | undefined): boolean {
  return value === '\n' || value === '\r' || value === '\u2028' || value === '\u2029';
}

function markdownScanIndex(text: string): MarkdownScanIndex {
  const length = text.length;
  const nextOpener = new Int32Array(length + 1);
  const nextAltStop = new Int32Array(length + 1);
  const nextAngleStop = new Int32Array(length + 1);
  const nextDoubleQuoteStop = new Int32Array(length + 1);
  const nextSingleQuoteStop = new Int32Array(length + 1);
  const nextNonWhitespace = new Int32Array(length + 1);
  const bareResult = new Int32Array(length + 1);
  nextOpener.fill(length);
  nextAltStop.fill(length);
  nextAngleStop.fill(length);
  nextDoubleQuoteStop.fill(length);
  nextSingleQuoteStop.fill(length);
  nextNonWhitespace.fill(length);
  bareResult.fill(length);

  let nextBracket = length;
  let nextNewline = length;
  let nextGreater = length;
  let nextDoubleQuote = length;
  let nextSingleQuote = length;
  for (let position = length - 1; position >= 0; position--) {
    const character = text[position];
    if (character === ']') nextBracket = position;
    if (character === '\n') nextNewline = position;
    if (character === '>') nextGreater = position;
    if (character === '"') nextDoubleQuote = position;
    if (character === "'") nextSingleQuote = position;

    nextOpener[position] = character === '!' && text[position + 1] === '['
      ? position : nextOpener[position + 1];
    nextAltStop[position] = Math.min(nextBracket, nextNewline);
    nextAngleStop[position] = Math.min(nextGreater, nextNewline);
    nextDoubleQuoteStop[position] = Math.min(nextDoubleQuote, nextNewline);
    nextSingleQuoteStop[position] = Math.min(nextSingleQuote, nextNewline);
    nextNonWhitespace[position] = isMarkdownWhitespace(character)
      ? nextNonWhitespace[position + 1] : position;

    if (character === ')' || isMarkdownWhitespace(character)) {
      bareResult[position] = position;
    } else if (character === '\\') {
      bareResult[position] = position + 1 >= length || isMarkdownDotLineTerminator(text[position + 1])
        ? -(position + 1) : bareResult[position + 2];
    } else {
      bareResult[position] = bareResult[position + 1];
    }
  }

  return { nextOpener, nextAltStop, nextAngleStop, nextDoubleQuoteStop,
    nextSingleQuoteStop, nextNonWhitespace, bareResult };
}

function imageMatchFailure(index: MarkdownScanIndex, position: number, nestedSearchStart: number): { resume: number } {
  // Resume at a precomputed later opener so a valid image inside a malformed
  // outer image is still discovered without rescanning the same suffix.
  const nested = index.nextOpener[nestedSearchStart] ?? index.nextOpener[index.nextOpener.length - 1];
  if (nested < index.nextOpener.length - 1) return { resume: nested };
  const length = index.nextOpener.length - 1;
  return { resume: position >= length ? length : position + 1 };
}

function parseMarkdownImage(text: string, index: MarkdownScanIndex, start: number): MarkdownImageMatch | { resume: number } {
  let position = start + 2;
  const altStart = position;
  position = index.nextAltStop[position];
  if (position >= text.length || isMarkdownNewline(text[position])) return imageMatchFailure(index, position, start + 2);
  const altEnd = position;
  if (text[position + 1] !== '(') return imageMatchFailure(index, position, start + 2);

  position += 2;
  position = index.nextNonWhitespace[position];
  const urlStart = position;
  let urlEnd = position;
  if (text[position] === '<') {
    position++;
    const angleStart = position;
    position = index.nextAngleStop[position];
    if (position >= text.length || isMarkdownNewline(text[position]) || position === angleStart) {
      return imageMatchFailure(index, position, start + 2);
    }
    position++;
    urlEnd = position;
  } else {
    const result = index.bareResult[position];
    if (result < 0) return imageMatchFailure(index, -result - 1, start + 2);
    if (result === position) return imageMatchFailure(index, position, start + 2);
    position = result;
    urlEnd = position;
  }

  if (isMarkdownWhitespace(text[position])) {
    position = index.nextNonWhitespace[position];
    const quote = text[position];
    if (quote === '"' || quote === "'") {
      position++;
      position = quote === '"' ? index.nextDoubleQuoteStop[position] : index.nextSingleQuoteStop[position];
      if (position >= text.length || isMarkdownNewline(text[position])) return imageMatchFailure(index, position, start + 2);
      position++;
    }
  }
  position = index.nextNonWhitespace[position];
  if (text[position] !== ')') return imageMatchFailure(index, position, start + 2);
  position++;

  const match = [text.slice(start, position), text.slice(altStart, altEnd), text.slice(urlStart, urlEnd)] as MarkdownImageMatch;
  match.index = start;
  return match;
}

function markdownImageMatches(text: string): MarkdownImageMatch[] {
  const visible = withoutCode(text);
  if (!visible.includes('![')) return [];
  const index = markdownScanIndex(visible);
  const matches: MarkdownImageMatch[] = [];
  let cursor = 0;
  while (cursor < visible.length) {
    const start = visible.indexOf('![', cursor);
    if (start < 0) break;
    if (start > 0 && visible[start - 1] === '\\') {
      cursor = start + 2;
      continue;
    }
    const parsed = parseMarkdownImage(visible, index, start);
    if ('index' in parsed) {
      matches.push(parsed);
      cursor = start + parsed[0].length;
    } else {
      cursor = Math.max(start + 2, parsed.resume);
    }
  }
  return matches;
}

export function stripResultImageSources(text: string): string {
  let output = text;
  const matches = markdownImageMatches(text);
  for (const match of matches.reverse()) {
    const name = displayName(match[1], 'Result image');
    const index = match.index ?? 0;
    output = output.slice(0, index) + `[Image: ${name}]` + output.slice(index + match[0].length);
  }
  return output.replace(/data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}/gi, '[inline image data omitted]');
}

function markdownImages(text: string): ResultImageInput[] {
  return markdownImageMatches(text).map((match, index) => {
    const url = match[2].startsWith('<') && match[2].endsWith('>') ? match[2].slice(1, -1) : match[2];
    return { type: 'resultImage', source: 'assistant', name: displayName(match[1], `Result image ${index + 1}`), url };
  });
}

function namedPath(path: unknown, fallback: string): string {
  if (typeof path !== 'string') return fallback;
  return displayName(basename(path), fallback);
}

/** Extract only explicit image results from known Desktop snapshot fields. */
export function resultImageInputs(item: Record<string, unknown>): ResultImageInput[] {
  if (item.type === 'imageGeneration') {
    const savedPath = item.savedPath;
    if (typeof savedPath === 'string' && savedPath.length > 0) {
      const candidate = imageInput('generated', namedPath(savedPath, 'Generated image'), savedPath, 'Generated image');
      return candidate ? [candidate] : [];
    }
    if (typeof item.result === 'string' && item.result.length > 0) {
      const value = item.result.startsWith('data:') ? item.result : `data:image/png;base64,${item.result}`;
      const candidate = imageInput('generated', item.name ?? 'Generated image', value, 'Generated image');
      return candidate ? [candidate] : [];
    }
    return [];
  }
  if (item.type === 'dynamicToolCall' && Array.isArray(item.contentItems)) {
    return item.contentItems.flatMap((content, index) => {
      if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
      const value = content as Record<string, unknown>;
      if (value.type !== 'inputImage') return [];
      const candidate = imageInput('tool', value.name ?? item.name, value.imageUrl, `Tool image ${index + 1}`);
      return candidate ? [candidate] : [];
    });
  }
  if (item.type === 'functionCallOutput') {
    const output = item.output;
    const values = Array.isArray(output) ? output : [output];
    return values.flatMap((content, index) => {
      if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
      const value = content as Record<string, unknown>;
      if (value.type !== 'input_image') return [];
      const candidate = imageInput('tool', value.name ?? item.name, value.image_url, `Tool image ${index + 1}`);
      return candidate ? [candidate] : [];
    });
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string') return markdownImages(item.text);
  return [];
}

export class CodexResultImages {
  private readonly manifestDir: string;
  private readonly codexHome: string;
  private readonly readTimeoutMs: number;
  private readonly pendingSnapshots = new Map<string, Promise<AttachmentResult>>();

  constructor(options: { dataDir: string; codexHome?: string; readTimeoutMs?: number }) {
    this.readTimeoutMs = options.readTimeoutMs ?? 2000;
    if (!Number.isInteger(this.readTimeoutMs) || this.readTimeoutMs < 1 || this.readTimeoutMs > 30_000) throw new Error('Invalid image read deadline');
    this.manifestDir = join(options.dataDir, 'result-images');
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    mkdirSync(this.manifestDir, { recursive: true, mode: 0o700 });
  }

  attachments(input: Request, persist: PersistAsset): Promise<AttachmentResult> {
    const key = JSON.stringify([input.hostId, input.threadId, input.messageId]);
    const pending = this.pendingSnapshots.get(key);
    if (pending) return pending;
    const snapshot = this.snapshot(input, persist).finally(() => this.pendingSnapshots.delete(key));
    this.pendingSnapshots.set(key, snapshot);
    return snapshot;
  }

  private async snapshot(input: Request, persist: PersistAsset): Promise<AttachmentResult> {
    if (!safeHost(input.hostId) || !safeThread(input.threadId) || !input.messageId) {
      return { attachments: [], omittedAttachmentCount: input.inputs.length };
    }
    const candidates = input.inputs.slice(0, 4);
    const attachments: ResultAttachment[] = [];
    let totalBytes = 0;
    for (const [index, candidate] of candidates.entries()) {
      const identity = `${input.hostId}\0${input.threadId}\0${input.messageId}\0${candidate.source}\0${index}\0${candidate.name}`;
      const inputDigest = digest(identity);
      const manifestPath = join(this.manifestDir, `${inputDigest}.json`);
      const existing = this.readManifest(manifestPath, input, inputDigest);
      if (existing) {
        const pinned = existing.attachment;
        const byteCount = pinned.byteCount ?? 0;
        if (pinned.availability === 'available' && totalBytes + byteCount > MAX_ATTACHMENT_BYTES) {
          attachments.push(this.unavailable(input, index, pinned.name, 'image/unknown', 'total_size_exceeded'));
        } else {
          if (pinned.availability === 'available') totalBytes += byteCount;
          attachments.push({ ...pinned, id: `${input.messageId}:result:${index}` });
        }
        continue;
      }

      const name = displayName(candidate.name, `Result image ${index + 1}`);
      let attachment: ResultAttachment;
      try {
        const image = await this.readImage(input, candidate.url);
        if (totalBytes + image.bytes.length > MAX_ATTACHMENT_BYTES) {
          attachment = this.unavailable(input, index, name, 'image/unknown', 'total_size_exceeded');
        } else {
          const asset = persist(name, image.mimeType, image.bytes);
          if (asset.availability !== 'available' || typeof asset.assetPath !== 'string'
            || !asset.assetPath.startsWith('/api/codex/assets/')) throw new ResultImageFailure('snapshot_unavailable');
          totalBytes += image.bytes.length;
          attachment = { ...asset, id: `${input.messageId}:result:${index}`, name, mimeType: image.mimeType,
            availability: 'available', byteCount: image.bytes.length };
          this.writeManifest(manifestPath, { version: 1, hostId: input.hostId, threadId: input.threadId,
            messageId: input.messageId, inputDigest, attachment });
        }
      } catch (error) {
        const reason = this.reason(error);
        attachment = this.unavailable(input, index, name, 'image/unknown', reason);
        // A timed-out OS read must not be repeated by every history poll. A new
        // message has a different snapshot key and can retry after permissions change.
        if (error instanceof ResultImageTimeout) {
          this.writeManifest(manifestPath, { version: 1, hostId: input.hostId, threadId: input.threadId,
            messageId: input.messageId, inputDigest, attachment });
        }
      }
      attachments.push(attachment);
    }
    return { attachments, omittedAttachmentCount: Math.max(0, input.inputs.length - candidates.length) };
  }

  private readManifest(path: string, input: Request, inputDigest: string): SnapshotManifest | undefined {
    if (!existsSync(path)) return;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid manifest');
      const value = JSON.parse(readManifestFile(path)) as Partial<SnapshotManifest>;
      if (value.version !== 1 || value.hostId !== input.hostId || value.threadId !== input.threadId
        || value.messageId !== input.messageId || value.inputDigest !== inputDigest || !value.attachment
        || typeof value.attachment.id !== 'string' || typeof value.attachment.name !== 'string'
        || (value.attachment.availability !== 'available' && value.attachment.availability !== 'unavailable')
        || (value.attachment.availability === 'available' && (!['image/png', 'image/jpeg'].includes(value.attachment.mimeType ?? '')
          || !Number.isSafeInteger(value.attachment.byteCount) || (value.attachment.byteCount ?? 0) < 1
          || (value.attachment.byteCount ?? 0) > MAX_IMAGE_BYTES || typeof value.attachment.assetPath !== 'string'
          || !value.attachment.assetPath.startsWith('/api/codex/assets/')))
        || (value.attachment.availability === 'unavailable' && typeof value.attachment.unavailableReason !== 'string')) throw new Error('invalid manifest');
      return value as SnapshotManifest;
    } catch {
      return { version: 1, hostId: input.hostId, threadId: input.threadId, messageId: input.messageId,
        inputDigest, attachment: this.unavailable(input, 0, 'Result image', 'image/unknown', 'snapshot_unavailable') };
    }
  }

  private writeManifest(path: string, manifest: SnapshotManifest): void {
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch { /* renamed or already removed */ } }
  }

  private unavailable(input: Request, index: number, name: string, mimeType: string, reason: ResultImageUnavailableReason): ResultAttachment {
    return { id: `${input.messageId}:result:${index}`, name, mimeType, availability: 'unavailable', unavailableReason: reason };
  }

  private reason(error: unknown): ResultImageUnavailableReason {
    if (error instanceof ResultImageFailure) return error.reason;
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'image_too_large') return 'image_too_large';
    if (code === 'invalid_image') return 'invalid_image';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'image_missing' : 'snapshot_unavailable';
  }

  private async readImage(input: Request, url: string): Promise<ImageBytes> {
    if (url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128) throw new ResultImageFailure('image_too_large');
    const data = DATA_URL.exec(url);
    if (data) return { mimeType: data[1] as ImageBytes['mimeType'], bytes: imageBytes(data[2], data[1]) };
    if (url.startsWith('data:')) throw new ResultImageFailure('invalid_image');
    if (/^https?:\/\//i.test(url)) throw new ResultImageFailure('remote_file_unsupported');
    if (input.hostId !== 'local') throw new ResultImageFailure('remote_file_unsupported');

    return readIsolatedImage({ url, cwd: input.cwd, threadId: input.threadId, codexHome: this.codexHome }, this.readTimeoutMs);
  }
}

type LocalImageRequest = { url: string; cwd?: string; threadId: string; codexHome: string };

function readLocalImage(input: LocalImageRequest): ImageBytes {
  const url = input.url;
  let candidatePath: string;
  try {
    if (url.startsWith('file:')) {
      const parsed = new URL(url);
      if (parsed.hostname && parsed.hostname !== 'localhost' || parsed.search || parsed.hash) throw new ResultImageFailure('unsupported_source');
      candidatePath = decodeURIComponent(parsed.pathname);
    } else candidatePath = url;
  } catch (error) {
    if (error instanceof ResultImageFailure) throw error;
    throw new ResultImageFailure('unsupported_source');
  }
  if (!isAbsolute(candidatePath) || candidatePath.length > 4096) throw new ResultImageFailure('unsupported_source');

  let realCandidate: string;
  try { realCandidate = realpathSync(candidatePath); }
  catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ResultImageFailure('image_missing');
    throw new ResultImageFailure('snapshot_unavailable');
  }
  const roots: string[] = [];
  if (input.cwd && isAbsolute(input.cwd)) {
    try { if (statSync(realpathSync(input.cwd)).isDirectory()) roots.push(realpathSync(input.cwd)); } catch { /* An unavailable cwd is not a readable root. */ }
  }
  if (safeThread(input.threadId)) {
    try {
      const generated = join(input.codexHome, 'generated_images', input.threadId);
      if (statSync(realpathSync(generated)).isDirectory()) roots.push(realpathSync(generated));
    } catch { /* No generated image directory is available. */ }
  }
  if (!roots.some(root => within(root, realCandidate))) throw new ResultImageFailure('outside_workspace');

  const mimeType = mimeExtensions.get(extname(realCandidate).toLowerCase());
  if (!mimeType) throw new ResultImageFailure('unsupported_source');
  const stat = statSync(realCandidate);
  if (!stat.isFile()) throw new ResultImageFailure('unsupported_source');
  if (stat.size > MAX_IMAGE_BYTES) throw new ResultImageFailure('image_too_large');
  const descriptor = openSync(realCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_IMAGE_BYTES) throw new ResultImageFailure('image_too_large');
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_IMAGE_BYTES) throw new ResultImageFailure('image_too_large');
    const bytes = imageBytes(buffer.subarray(0, length).toString('base64'), mimeType);
    return { mimeType, bytes };
  } finally { closeSync(descriptor); }
}

class ResultImageFailure extends Error {
  constructor(readonly reason: ResultImageUnavailableReason) { super(reason); }
}

function readManifestFile(path: string): string {
  // Reading a symlinked or replaced manifest could cross the private data boundary.
  const real = realpathSync(path);
  if (!within(realpathSync(dirname(path)), real)) throw new Error('manifest escaped its directory');
  return readFileSync(real, 'utf8');
}


class ResultImageTimeout extends ResultImageFailure {
  constructor() { super('snapshot_unavailable'); }
}

let activeImageReaders = 0;
const readerArgument = '--petroglyphs-result-image-reader';

function readIsolatedImage(input: LocalImageRequest, timeoutMs: number): Promise<ImageBytes> {
  // Keep a stuck OS read outside both the HTTP loop and libuv's shared thread
  // pool. A child still counts against this bound until the OS reports its exit.
  if (activeImageReaders >= 4) return Promise.reject(new ResultImageFailure('snapshot_unavailable'));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(new URL(import.meta.url), [readerArgument], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      });
    } catch {
      // A synchronous spawn failure has no child that can later emit exit or
      // close, and therefore does not consume a reader slot.
      reject(new ResultImageFailure('snapshot_unavailable'));
      return;
    }
    activeImageReaders++;
    let spawned = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeImageReaders--;
    };
    let settled = false;
    const timer = setTimeout(() => finish(new ResultImageTimeout()), timeoutMs);
    const finish = (error?: Error, image?: ImageBytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else resolve(image!);
    };
    child.once('spawn', () => { spawned = true; });
    child.once('exit', () => {
      release();
      finish(new ResultImageFailure('snapshot_unavailable'));
    });
    child.once('close', () => {
      // Spawn failures emit error + close without exit. A live reader that
      // timed out only releases here if its process has actually terminated.
      release();
      finish(new ResultImageFailure('snapshot_unavailable'));
    });
    child.once('error', () => {
      // Before spawn, error is a definite failure (typically ENOENT). After
      // spawn, keep the slot until exit/close because the child may still be
      // blocked in the OS read.
      if (!spawned) release();
      finish(new ResultImageFailure('snapshot_unavailable'));
    });
    child.once('message', value => {
      const result = value as { bytes?: unknown; mimeType?: unknown; reason?: unknown } | null;
      if (result && Buffer.isBuffer(result.bytes) && result.bytes.length <= MAX_IMAGE_BYTES
        && (result.mimeType === 'image/png' || result.mimeType === 'image/jpeg')) {
        finish(undefined, { bytes: result.bytes, mimeType: result.mimeType });
      } else {
        const reason = result?.reason;
        finish(new ResultImageFailure(reason === 'image_missing' || reason === 'outside_workspace'
          || reason === 'unsupported_source' || reason === 'image_too_large' || reason === 'invalid_image'
          ? reason : 'snapshot_unavailable'));
      }
    });
    child.send(input, error => { if (error) finish(new ResultImageFailure('snapshot_unavailable')); });
  });
}

// The same module is the isolated reader entry point in both tsx and dist builds.
if (process.argv[2] === readerArgument && process.argv[1] === fileURLToPath(import.meta.url) && process.send) {
  process.once('message', input => {
    let result: ImageBytes | { reason: ResultImageUnavailableReason };
    try { result = readLocalImage(input as LocalImageRequest); }
    catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
      result = { reason: error instanceof ResultImageFailure ? error.reason
        : code === 'image_too_large' ? 'image_too_large' : code === 'invalid_image' ? 'invalid_image'
          : code === 'ENOENT' || code === 'ENOTDIR' ? 'image_missing' : 'snapshot_unavailable' };
    }
    process.send!(result, () => { if (process.connected) process.disconnect(); });
  });
}
