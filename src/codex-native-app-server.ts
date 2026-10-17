import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const BUNDLED_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export type NativeCreationMethod = 'project/list' | 'project/read' | 'thread/start' | 'thread/read' | 'thread/list' | 'thread/name/set';
export interface NativeCreationClient {
  request(method: NativeCreationMethod, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export class NativeAppServerError extends Error {
  constructor(readonly outcome: 'not_sent' | 'unknown') { super('The native Codex service did not confirm the request.'); }
}
interface Pending {
  written: boolean; mutating: boolean; timer: NodeJS.Timeout;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An owned stdio client. It inherits normal Codex configuration and never executes a model turn. */
export class CodexNativeAppServer implements NativeCreationClient {
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private nextId = 0;
  private buffer = '';
  private bytesRead = 0;
  private failed = false;
  private closing?: Promise<void>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs: number) {
    this.exited = new Promise(resolve => child.once('close', () => { this.fail(); resolve(); }));
    child.on('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    // Native diagnostics can contain account or configuration values.
    child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
  }

  static async connect(options: { codexPath: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CodexNativeAppServer> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!isAbsolute(options.codexPath) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new NativeAppServerError('not_sent');
    }
    const child = spawn(options.codexPath, ['app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env });
    const client = new CodexNativeAppServer(child, timeoutMs);
    try {
      await client.send('initialize', { clientInfo: { name: 'petroglyphs-native-creator', title: 'Petroglyphs native chat creation', version: '1.0.0' },
        capabilities: { experimentalApi: true } }, false);
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  request(method: NativeCreationMethod, params: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params, method === 'thread/start' || method === 'thread/name/set');
  }

  private send(method: string, params: Record<string, unknown>, mutating: boolean): Promise<unknown> {
    if (this.failed || this.closing || this.child.stdin.destroyed) return Promise.reject(new NativeAppServerError('not_sent'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const request: Pending = { written: false, mutating, resolve, reject, timer: setTimeout(() => {
        this.pending.delete(id); reject(new NativeAppServerError(mutating && request.written ? 'unknown' : 'not_sent'));
      }, this.timeoutMs) };
      this.pending.set(id, request);
      try {
        // write() accepting bytes does not establish server execution. From this
        // boundary onward, a missing response cannot authorize another creation.
        request.written = true;
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch { this.pending.delete(id); clearTimeout(request.timer); reject(new NativeAppServerError(mutating ? 'unknown' : 'not_sent')); }
    });
  }

  private receive(chunk: string): void {
    if (this.failed || this.closing) return;
    this.bytesRead += Buffer.byteLength(chunk);
    if (this.bytesRead > 16 * 1024 * 1024) { this.fail(); return; }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.fail(); return; }
      if (!record(message)) { this.fail(); return; }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) continue;
      this.pending.delete(message.id as number); clearTimeout(pending.timer);
      // Even an explicit mutating error can follow partial execution. Keep it
      // uncertain instead of inferring that thread/start is safe to replay.
      if (message.error !== undefined || !Object.hasOwn(message, 'result')) {
        pending.reject(new NativeAppServerError(pending.mutating && pending.written ? 'unknown' : 'not_sent'));
      } else pending.resolve(message.result);
    }
  }

  private fail(): void {
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeAppServerError(pending.mutating && pending.written ? 'unknown' : 'not_sent'));
    }
    this.pending.clear(); this.buffer = '';
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail();
    this.closing = (async () => {
      this.child.stdin.end(); this.child.kill('SIGTERM');
      const force = setTimeout(() => this.child.kill('SIGKILL'), 500);
      try { await this.exited; } finally { clearTimeout(force); }
    })();
    return this.closing;
  }
}
