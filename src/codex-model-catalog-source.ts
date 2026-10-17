import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

export const MODEL_CATALOG_TTL_MS = 5 * 60_000;
export const MODEL_CATALOG_MAX_BYTES = 1024 * 1024;
const MAX_MODELS = 256;
const modalities = new Set(['text', 'image', 'audio']);

export interface CatalogModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: Array<'text' | 'image' | 'audio'>;
  isDefault: boolean;
}

export interface ModelCatalogSnapshot {
  version: 1;
  source: 'codex-app-server';
  observedAt: string;
  models: CatalogModel[];
}

export type ModelCatalogErrorCode = 'catalogue_unavailable' | 'invalid_catalogue' | 'catalogue_stale'
  | 'invalid_configuration' | 'unsupported_model' | 'unsupported_reasoning_effort' | 'unsupported_input_modality';

export class CodexModelCatalogError extends Error {
  constructor(message: string, readonly status: number, readonly code: ModelCatalogErrorCode) { super(message); }
}

function unavailable(): CodexModelCatalogError {
  return new CodexModelCatalogError('The selected host model catalogue is unavailable.', 503, 'catalogue_unavailable');
}
function invalid(): never {
  throw new CodexModelCatalogError('The selected host returned an invalid model catalogue.', 503, 'invalid_catalogue');
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) invalid();
  return value;
}
function effort(value: unknown): string {
  const result = text(value, 32);
  if (!/^[a-z][a-z0-9_-]*$/.test(result)) invalid();
  return result;
}

/** Whitelist public capabilities; never return model instructions or account metadata. */
export function parseCatalogModels(value: unknown): CatalogModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS) invalid();
  const models = value.map((item): CatalogModel => {
    if (!isRecord(item) || !Array.isArray(item.supportedReasoningEfforts)
      || item.supportedReasoningEfforts.length === 0 || item.supportedReasoningEfforts.length > 16
      || !Array.isArray(item.inputModalities) || item.inputModalities.length === 0 || item.inputModalities.length > 3
      || item.inputModalities.some(value => typeof value !== 'string' || !modalities.has(value))
      || typeof item.isDefault !== 'boolean') invalid();
    const options = item.supportedReasoningEfforts.map(value => {
      if (!isRecord(value)) invalid();
      return { reasoningEffort: effort(value.reasoningEffort), description: text(value.description, 2000, true) };
    });
    const defaultReasoningEffort = effort(item.defaultReasoningEffort);
    if (new Set(options.map(option => option.reasoningEffort)).size !== options.length
      || !options.some(option => option.reasoningEffort === defaultReasoningEffort)
      || new Set(item.inputModalities).size !== item.inputModalities.length) invalid();
    return {
      id: text(item.id, 256), model: text(item.model, 256), displayName: text(item.displayName, 200),
      description: text(item.description, 4000, true), supportedReasoningEfforts: options,
      defaultReasoningEffort, inputModalities: [...item.inputModalities] as CatalogModel['inputModalities'], isDefault: item.isDefault,
    };
  });
  if (new Set(models.map(model => model.model)).size !== models.length
    || new Set(models.map(model => model.id)).size !== models.length) invalid();
  return models;
}

export function parseModelCatalogSnapshot(value: unknown, now = Date.now()): ModelCatalogSnapshot {
  if (!isRecord(value) || value.version !== 1 || value.source !== 'codex-app-server'
    || typeof value.observedAt !== 'string') invalid();
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== value.observedAt
    || observedAt > now + 30_000) invalid();
  if (now - observedAt >= MODEL_CATALOG_TTL_MS) {
    throw new CodexModelCatalogError('The selected host model catalogue has expired.', 503, 'catalogue_stale');
  }
  return { version: 1, source: 'codex-app-server', observedAt: value.observedAt, models: parseCatalogModels(value.models) };
}

export function isTailscaleIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const parts = value.split('.').map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** Open one owned private configuration file; all diagnostics remain path-free. */
export async function readPrivateCatalogConfiguration(path: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(path)) throw new Error();
    file = await open(path, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 128 * 1024
      || (process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))) throw new Error();
    const contents = await file.readFile('utf8');
    if (Buffer.byteLength(contents) > 128 * 1024) throw new Error();
    return JSON.parse(contents);
  } catch {
    throw new CodexModelCatalogError('Model catalogue configuration must be valid and private.', 503, 'invalid_configuration');
  } finally { await file?.close(); }
}

export interface ModelCatalogReaderOptions {
  codexPath: string;
  timeoutMs?: number;
}

/** Executes only initialize and model/list against this host's installed Codex CLI. */
export async function readLocalModelCatalog(options: ModelCatalogReaderOptions): Promise<ModelCatalogSnapshot> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!isAbsolute(options.codexPath) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new CodexModelCatalogError('Model catalogue reader configuration is invalid.', 503, 'invalid_configuration');
  }
  const child = spawn(options.codexPath, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let closing = false;
  let failure: Error | undefined;
  let buffer = '';
  let bytesRead = 0;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error = unavailable()) => {
    if (failure) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const exited = new Promise<void>(resolve => child.once('close', () => {
    if (!closing) fail();
    resolve();
  }));
  child.on('error', () => fail());
  child.stdin.on('error', () => fail());
  // Codex stderr may include configuration and account details. Do not retain it.
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closing || failure) return;
    bytesRead += Buffer.byteLength(chunk);
    if (bytesRead > 4 * MODEL_CATALOG_MAX_BYTES) { fail(); return; }
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { fail(); return; }
      if (!isRecord(message)) { fail(); return; }
      const request = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!request) continue;
      pending.delete(message.id as number);
      if (message.error !== undefined) request.reject(unavailable());
      else request.resolve(message.result);
    }
  });
  const deadline = setTimeout(() => fail(), timeoutMs);
  const request = (method: 'initialize' | 'model/list', params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  try {
    await request('initialize', { clientInfo: { name: 'petroglyphs-model-catalog', title: 'Petroglyphs model catalogue', version: '1.0.0' }, capabilities: null });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const models: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await request('model/list', { includeHidden: false, cursor, limit: 100 });
      if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 100
        || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096))) invalid();
      for (const model of result.data) {
        if (!isRecord(model) || typeof model.hidden !== 'boolean') invalid();
        if (!model.hidden) models.push(model);
      }
      if (models.length > MAX_MODELS) invalid();
      if (result.nextCursor === null) {
        const snapshot: ModelCatalogSnapshot = { version: 1, source: 'codex-app-server', observedAt: new Date().toISOString(), models: parseCatalogModels(models) };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > MODEL_CATALOG_MAX_BYTES) invalid();
        return snapshot;
      }
      if (cursors.has(result.nextCursor)) invalid();
      cursor = result.nextCursor; cursors.add(cursor);
    }
    return invalid();
  } catch (error) {
    throw error instanceof CodexModelCatalogError ? error : unavailable();
  } finally {
    closing = true;
    clearTimeout(deadline);
    child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, 500);
    try { await exited; } finally { clearTimeout(force); }
  }
}
