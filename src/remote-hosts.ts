import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { CodexThreads, isThreadId, type ThreadPage, type ThreadQuery } from './codex-threads.js';
import type { Combo, StrokeMetadata } from './types.js';
import type { SubmissionSummary } from './codex-replies.js';
import { CodexDesktopCatalog } from './codex-desktop-catalog.js';
import { CodexDesktopIpc, type CodexModelSelection } from './codex-desktop-ipc.js';
import { CodexModelCatalog, CodexModelCatalogError } from './codex-model-catalog.js';
import type { ModelAccess } from './codex-model-routes.js';
import { DesktopSubmissions } from './codex-desktop-submissions.js';
import { CodexConversations } from './codex-conversations.js';
import { CodexCompanionCreator } from './codex-companion-creator.js';
import { CodexProjectsCatalog } from './codex-projects-catalog.js';
import { CodexProjectChats } from './codex-project-chats.js';
import { BUNDLED_CODEX_PATH, CodexNativeAppServer } from './codex-native-app-server.js';
import { CodexNativeCreator, readNativeProjectMembership } from './codex-native-creator.js';
import { ConversationError } from './codex-message-input.js';

const hostIdPattern = /^remote-control:env_[A-Za-z0-9_-]{1,128}$/;
const maxResponseBytes = 4 * 1024 * 1024;
const hostConfigSchema = z.object({
  id: z.string().regex(hostIdPattern),
  name: z.string().trim().min(1).max(100),
  url: z.string().max(2048),
  deviceToken: z.string().regex(/^[0-9a-f]{32,256}$/),
}).strict();
const configSchema = z.object({ hosts: z.array(hostConfigSchema).max(32) }).strict();
const threadIdSchema = z.string().refine(isThreadId);
const threadPageSchema = z.object({
  threads: z.array(z.object({
    id: threadIdSchema,
    title: z.string().max(2000),
    cwd: z.string().max(8192),
    updatedAt: z.number().finite(),
  })).max(100),
  nextCursor: z.string().max(4096).nullable(),
});
const receiptSchema = z.object({ id: threadIdSchema, threadId: threadIdSchema, status: z.literal('received') });
const submissionListSchema = z.object({ submissions: z.array(z.object({
  id: threadIdSchema, threadId: threadIdSchema, createdAt: z.string().datetime({ offset: true }),
})).max(20) });
const submissionSchema = z.object({
  id: threadIdSchema,
  threadId: threadIdSchema,
  state: z.enum(['pending', 'dispatching', 'queued', 'running', 'completed', 'failed', 'unknown']),
  messages: z.array(z.object({
    id: z.string().min(1).max(256),
    text: z.string(),
    phase: z.enum(['commentary', 'final_answer', 'unknown']),
  })).max(200),
  error: z.string().optional(),
  notice: z.string().optional(),
  coalescedSubmissionIds: z.array(threadIdSchema).max(100).optional(),
});

export interface HostSummary {
  id: string;
  name: string;
  kind: 'remote';
  configured: boolean;
  /** A configured transport can be attempted. This is not an online check. */
  available: boolean;
  reason?: string;
}

export interface RemoteSubmitPayload {
  image: string;
  strokeMetadata: StrokeMetadata;
  combo?: Combo | null;
  threadId: string;
}

export type RemoteSubmissionStatus = z.infer<typeof submissionSchema> & { hostId: string };
export type RemoteReceipt = z.infer<typeof receiptSchema> & { hostId: string };
type HostConfig = z.infer<typeof hostConfigSchema>;

export class RemoteHostError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface Options {
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface DesktopRuntime {
  catalog: CodexDesktopCatalog;
  submissions: DesktopSubmissions;
  conversations: CodexConversations;
  projectChats: CodexProjectChats;
  models: ModelAccess;
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ts.net')) return true;
  if (host.startsWith('fd7a:115c:a1e0:')) return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && (url.protocol !== 'http:' || !isPrivateHttpHost(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid helper base URL');
  }
  return url.origin;
}

async function configuredHosts(path: string | undefined): Promise<HostConfig[]> {
  if (path === undefined) return [];
  try {
    if (!isAbsolute(path)) throw new Error('Configuration path must be absolute');
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 128 * 1024
      || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
      throw new Error('Configuration must be private');
    }
    const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (new Set(config.hosts.map(host => host.id)).size !== config.hosts.length) throw new Error('Duplicate host');
    return config.hosts.map(host => ({ ...host, url: validateBaseUrl(host.url) }));
  } catch {
    // Paths, input values and Zod diagnostics may include a credential. Keep all
    // configuration failures safe for the HTTP boundary and startup logs.
    throw new RemoteHostError('Remote helper configuration is invalid. Use a private configuration file with valid hosts.', 503);
  }
}

async function cachedHostIds(path: string): Promise<string[]> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) return [];
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const state = data as Record<string, unknown>;
    const ids = new Set<string>();
    const add = (id: unknown) => { if (typeof id === 'string' && hostIdPattern.test(id)) ids.add(id); };
    const connections = state['remote-connection-auto-connect-by-host-id'];
    if (connections && typeof connections === 'object' && !Array.isArray(connections)) {
      Object.keys(connections).forEach(add);
    }
    const projects = state['remote-projects'];
    if (Array.isArray(projects)) {
      for (const project of projects) {
        if (project && typeof project === 'object') add(project.hostId);
      }
    }
    // The desktop cache is optional and not a live catalog. Do not return any
    // cached project paths, conversation content, account or enrollment data.
    return [...ids].sort();
  } catch { return []; }
}

export class RemoteHosts {
  private constructor(
    private readonly hosts: Map<string, HostConfig>,
    private readonly cachePath: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch,
    private readonly desktop?: DesktopRuntime,
  ) {}

  static async fromEnvironment(options: Options = {}): Promise<RemoteHosts> {
    const env = options.env ?? process.env;
    const configs = await configuredHosts(env.PETROGLYPHS_REMOTE_CONFIG);
    let desktop: DesktopRuntime | undefined;
    if (env.PETROGLYPHS_CODEX_DESKTOP === '1') {
      if (!env.PETROGLYPHS_AUTO_REPLY_CONFIG) throw new Error('Desktop routing needs a paired device configuration');
      const settings = JSON.parse(await readFile(env.PETROGLYPHS_AUTO_REPLY_CONFIG, 'utf8')) as { dataDir?: unknown; codexPath?: unknown };
      if (typeof settings.dataDir !== 'string' || !isAbsolute(settings.dataDir)
        || typeof settings.codexPath !== 'string' || !isAbsolute(settings.codexPath)) throw new Error('Invalid Desktop receipt configuration');
      const catalog = new CodexDesktopCatalog({ env });
      const localThreads = new CodexThreads(settings.codexPath);
      const connect = () => CodexDesktopIpc.connect({ timeoutMs: 12_000, maxFrameBytes: 256 * 1024 * 1024 });
      const requireHost = async (hostId: string) => {
        if (hostId === 'local') return;
        const host = (await catalog.listHosts()).find(host => host.id === hostId);
        if (!host?.configured) throw new ConversationError('Enable the selected connection in Codex Desktop.', 404, 'connection_unavailable');
        if (!host.available) throw new ConversationError('Codex Desktop is still loading this connection. Try again after it syncs.', 503, 'connection_unavailable');
      };
      const nativeCodexPath = env.PETROGLYPHS_NATIVE_CODEX_PATH ?? BUNDLED_CODEX_PATH;
      const connectNative = () => CodexNativeAppServer.connect({ codexPath: nativeCodexPath, env });
      const projects = new CodexProjectsCatalog({ env, requireHost, nativeProjectThreads: async identity => {
        const client = await connectNative();
        try { return await readNativeProjectMembership(client, identity); }
        finally { await client.close(); }
      } });
      const models = await CodexModelCatalog.fromEnvironment({ codexPath: env.PETROGLYPHS_MODEL_CODEX_PATH ?? settings.codexPath, env });
      const requireSelection = async (hostId: string, selection: CodexModelSelection, hasImages: boolean) => {
        try { await models.requireSelection(hostId, { ...selection, hasImages }); }
        catch (error) {
          if (error instanceof CodexModelCatalogError) throw new ConversationError(error.message, error.status, error.code);
          throw new ConversationError('The model catalogue is temporarily unavailable.', 503, 'catalogue_unavailable');
        }
      };
      const projectChats = new CodexProjectChats({ dataDir: join(settings.dataDir, 'project-chats'), catalog: projects,
        requireSelection,
        localExecutor: new CodexNativeCreator({ dataDir: join(settings.dataDir, 'project-chats', 'native'), codexPath: nativeCodexPath,
          env, catalog: projects, connectNative, connectDesktop: connect }),
        executor: new CodexCompanionCreator({ helperThreadId: env.PETROGLYPHS_CODEX_CREATOR_THREAD_ID, connect, catalog: projects,
          evidenceDir: join(settings.dataDir, 'project-chats', 'companion-evidence') }) });
      const requireTarget = async (hostId: string, threadId: string) => {
        if (projectChats.hasThread(hostId, threadId)) { await requireHost(hostId); return; }
        return hostId === 'local' ? localThreads.requireThread(threadId) : catalog.requireThread(hostId, threadId);
      };
      desktop = {
        catalog,
        projectChats,
        models: { catalog: models, readSettings: async (hostId, threadId) => {
          await requireTarget(hostId, threadId);
          const client = await connect();
          try { return await client.readSettings(hostId, threadId); }
          finally { client.close(); }
        } },
        conversations: new CodexConversations({ dataDir: join(settings.dataDir, 'conversations'), legacyDataDir: settings.dataDir,
          connect, verifiedFirstMessage: (hostId, threadId) => projectChats.verifiedFirstMessage(hostId, threadId),
          requireTarget, requireSelection }),
        submissions: new DesktopSubmissions({
          dataDir: join(settings.dataDir, 'remote-desktop'),
          // Desktop snapshots include image history. Match the native router's
          // frame ceiling so ordinary accumulated drawings do not hit 32 MiB.
          connect,
        }),
      };
    }
    return new RemoteHosts(new Map(configs.map(host => [host.id, host])),
      options.cachePath ?? join(env.CODEX_HOME || join(homedir(), '.codex'), '.codex-global-state.json'),
      options.timeoutMs ?? 15_000, options.fetch ?? fetch, desktop);
  }

  /** Returns remote hosts only. The HTTP service adds its local host. */
  async listHosts(): Promise<HostSummary[]> {
    const direct = this.desktop ? await this.desktop.catalog.listHosts().catch(() => []) : [];
    const ids = new Set([...direct.map(host => host.id), ...this.hosts.keys(), ...await cachedHostIds(this.cachePath)]);
    return [...ids].map(id => {
      const connection = direct.find(host => host.id === id);
      if (connection && (connection.available || !this.hosts.has(id))) return connection;
      const host = this.hosts.get(id);
      return host ? { id, name: host.name, kind: 'remote' as const, configured: true, available: true }
        : { id, name: `Remote connection (${id.slice('remote-control:env_'.length, 'remote-control:env_'.length + 10)})`,
          kind: 'remote' as const, configured: false, available: false,
          reason: this.desktop ? 'Open this connection in Codex Desktop to sync its chats.' : 'Remote helper is not configured.' };
    });
  }

  private async usesDesktop(hostId: string): Promise<boolean> {
    if (!this.desktop) return false;
    const host = (await this.desktop.catalog.listHosts()).find(host => host.id === hostId);
    if (!host) return false;
    if (!host.available && this.hosts.has(hostId)) return false;
    return true;
  }

  private async requireHost(hostId: string): Promise<HostConfig> {
    if (!hostIdPattern.test(hostId)) throw new RemoteHostError('The selected remote connection is unavailable.', 404);
    const host = this.hosts.get(hostId);
    if (host) return host;
    if ((await cachedHostIds(this.cachePath)).includes(hostId)) {
      throw new RemoteHostError('Remote helper is not configured for this connection.', 503);
    }
    throw new RemoteHostError('The selected remote connection is unavailable.', 404);
  }

  private async request(hostId: string, path: string, body?: RemoteSubmitPayload): Promise<unknown> {
    const host = await this.requireHost(hostId);
    const isSubmission = body !== undefined;
    try {
      const response = await this.fetcher(`${host.url}/device/${host.deviceToken}${path}`, {
        method: isSubmission ? 'POST' : 'GET',
        ...(isSubmission ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404) throw new RemoteHostError('The selected remote chat or submission is unavailable.', 404);
        if (response.status === 400) throw new RemoteHostError('The remote service rejected this request.', 400);
        throw new RemoteHostError('The remote service could not accept this request. Check its connection and configuration.', 503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) throw new Error('Response too large');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof RemoteHostError) throw error;
      throw new RemoteHostError(isSubmission
        ? 'The remote service did not confirm this submission. Check the selected chat before retrying.'
        : 'The remote service is unavailable. Try again when it is connected.', 503);
    }
  }

  async listThreads(hostId: string, query: ThreadQuery): Promise<ThreadPage> {
    if (await this.usesDesktop(hostId)) return this.desktop!.catalog.listThreads(hostId, query);
    const parameters = new URLSearchParams();
    if (query.search) parameters.set('search', query.search);
    if (query.cursor) parameters.set('cursor', query.cursor);
    const result = await this.request(hostId, `/api/codex/threads?${parameters}`);
    const parsed = threadPageSchema.safeParse(result);
    if (!parsed.success) throw new RemoteHostError('The remote service returned an invalid chat list.', 503);
    return parsed.data;
  }

  async submit(hostId: string, payload: RemoteSubmitPayload): Promise<RemoteReceipt> {
    if (await this.usesDesktop(hostId)) {
      await this.desktop!.catalog.requireThread(hostId, payload.threadId);
      return this.desktop!.submissions.accept(hostId, payload.threadId, payload.image);
    }
    // Build a new local-only request. Never forward the central host selector or
    // its pairing code, which could create a proxy loop or change remote scope.
    const body: RemoteSubmitPayload = { image: payload.image, strokeMetadata: payload.strokeMetadata,
      combo: payload.combo ?? null, threadId: payload.threadId };
    const parsed = receiptSchema.safeParse(await this.request(hostId, '/api/submit', body));
    if (!parsed.success || parsed.data.threadId !== payload.threadId) {
      throw new RemoteHostError('The remote service did not confirm the selected chat. Check that chat before retrying.', 503);
    }
    return { ...parsed.data, hostId };
  }

  async submission(hostId: string, id: string): Promise<RemoteSubmissionStatus> {
    if (!isThreadId(id)) throw new RemoteHostError('A valid submission id is required.', 400);
    if (this.desktop?.submissions.has(hostId, id) || (!this.hosts.has(hostId) && await this.usesDesktop(hostId))) {
      return this.desktop!.submissions.get(hostId, id);
    }
    const parsed = submissionSchema.safeParse(await this.request(hostId, `/api/codex/submissions/${id}`));
    if (!parsed.success || parsed.data.id !== id) {
      throw new RemoteHostError('The remote service returned an invalid submission.', 503);
    }
    return { ...parsed.data, hostId,
      // Diagnostic strings from a remote process are not safe HTTP errors.
      ...(parsed.data.error ? { error: 'The remote Codex job reported a problem. Check the selected chat before retrying.' } : {}),
      ...(parsed.data.coalescedSubmissionIds && parsed.data.coalescedSubmissionIds.length > 1
        ? { notice: 'Codex processed these submissions in the same turn. This reply is shared by those submissions.' }
        : parsed.data.notice ? { notice: 'The remote service reported a status note. Check the selected chat for details.' } : {}),
    };
  }

  async listSubmissions(hostId: string, threadId: string): Promise<{ submissions: SubmissionSummary[] }> {
    if (!isThreadId(threadId)) throw new RemoteHostError('A valid threadId is required.', 400);
    const direct = this.desktop?.submissions.list(hostId, threadId).submissions ?? [];
    if (!this.hosts.has(hostId) && (direct.length > 0 || await this.usesDesktop(hostId))) return { submissions: direct };
    const query = new URLSearchParams({ threadId });
    const parsed = submissionListSchema.safeParse(await this.request(hostId, `/api/codex/submissions?${query}`));
    if (!parsed.success || parsed.data.submissions.some(submission => submission.threadId !== threadId)) {
      throw new RemoteHostError('The remote service returned an invalid submission list.', 503);
    }
    return { submissions: [...direct, ...parsed.data.submissions.map(submission => ({ ...submission, hostId }))]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) };
  }

  get conversations(): CodexConversations | undefined { return this.desktop?.conversations; }
  get projectChats(): CodexProjectChats | undefined { return this.desktop?.projectChats; }
  get models(): ModelAccess | undefined { return this.desktop?.models; }

  close(): void { this.desktop?.submissions.close(); this.desktop?.conversations.close(); this.desktop?.projectChats.close(); }
}
