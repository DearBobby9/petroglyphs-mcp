import { request as httpRequest } from 'node:http';
import {
  CodexModelCatalogError, MODEL_CATALOG_MAX_BYTES, MODEL_CATALOG_TTL_MS, isRecord, isTailscaleIPv4,
  parseModelCatalogSnapshot, readLocalModelCatalog, readPrivateCatalogConfiguration,
  type CatalogModel, type ModelCatalogSnapshot,
} from './codex-model-catalog-source.js';

export { CodexModelCatalogError } from './codex-model-catalog-source.js';
export type { CatalogModel } from './codex-model-catalog-source.js';

const hostIdPattern = /^remote-control:env_[A-Za-z0-9_-]{1,128}$/;
export interface ModelCatalogHostConfiguration { id: string; url: string }
export interface HostModelCatalog {
  hostId: string;
  status: 'available' | 'unavailable';
  source: 'local-app-server' | 'tailscale-model-agent' | null;
  observedAt: string | null;
  expiresAt: string | null;
  models: CatalogModel[];
  reason?: 'not_configured' | 'source_unavailable' | 'catalogue_stale' | 'invalid_catalogue';
}
export interface ModelSelection { model: string; reasoningEffort: string; hasImages?: boolean }

export interface CodexModelCatalogOptions {
  codexPath: string;
  hosts?: ModelCatalogHostConfiguration[];
  timeoutMs?: number;
  now?: () => number;
  /** Testable external boundaries. Defaults perform the real host reads. */
  readLocal?: () => Promise<ModelCatalogSnapshot>;
  request?: typeof httpRequest;
}

function invalidConfiguration(): never {
  throw new CodexModelCatalogError('Model catalogue configuration is invalid.', 503, 'invalid_configuration');
}
function baseUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/100\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\/?$/.test(value)) invalidConfiguration();
  let url: URL;
  try { url = new URL(value); } catch { return invalidConfiguration(); }
  if (!isTailscaleIPv4(url.hostname) || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalidConfiguration();
  return url.origin;
}

function parseConfiguration(value: unknown): ModelCatalogHostConfiguration[] {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'hosts')
    || !Array.isArray(value.hosts) || value.hosts.length > 32) invalidConfiguration();
  const hosts = value.hosts.map(host => {
    if (!isRecord(host) || Object.keys(host).some(key => key !== 'id' && key !== 'url')
      || typeof host.id !== 'string' || !hostIdPattern.test(host.id)) invalidConfiguration();
    return { id: host.id, url: baseUrl(host.url) };
  });
  if (new Set(hosts.map(host => host.id)).size !== hosts.length
    || new Set(hosts.map(host => host.url)).size !== hosts.length) invalidConfiguration();
  return hosts;
}

/** Literal Tailscale IPs and no redirects keep this request on the configured peer. */
function readRemote(base: string, requester: typeof httpRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpRequest> | undefined;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const failure = () => finish(new CodexModelCatalogError('The selected host model catalogue is unavailable.', 503, 'catalogue_unavailable'));
    const timer = setTimeout(failure, timeoutMs);
    try {
      request = requester(`${base}/models`, { method: 'GET', headers: { accept: 'application/json' }, agent: false }, response => {
        const length = response.headers['content-length'];
        if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')
          || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MODEL_CATALOG_MAX_BYTES))) {
          failure(); return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > MODEL_CATALOG_MAX_BYTES) { failure(); return; }
          chunks.push(chunk);
        });
        response.on('error', failure);
        response.on('aborted', failure);
        response.on('end', () => {
          if (settled) return;
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new CodexModelCatalogError('The selected host returned an invalid model catalogue.', 503, 'invalid_catalogue')); }
        });
      });
      request.on('error', failure);
      request.end();
    } catch { failure(); }
  });
}

export class CodexModelCatalog {
  private readonly hosts: Map<string, string>;
  private readonly now: () => number;
  private readonly readLocal: () => Promise<ModelCatalogSnapshot>;
  private readonly requester: typeof httpRequest;
  private readonly timeoutMs: number;
  private readonly snapshots = new Map<string, ModelCatalogSnapshot>();
  private readonly pending = new Map<string, Promise<HostModelCatalog>>();

  constructor(options: CodexModelCatalogOptions) {
    this.hosts = new Map(parseConfiguration({ hosts: options.hosts ?? [] }).map(host => [host.id, host.url]));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) invalidConfiguration();
    this.now = options.now ?? Date.now;
    this.readLocal = options.readLocal ?? (() => readLocalModelCatalog({ codexPath: options.codexPath, timeoutMs: this.timeoutMs }));
    this.requester = options.request ?? httpRequest;
  }

  static async fromEnvironment(options: Omit<CodexModelCatalogOptions, 'hosts'> & { env?: NodeJS.ProcessEnv }): Promise<CodexModelCatalog> {
    const path = (options.env ?? process.env).PETROGLYPHS_MODEL_CATALOG_CONFIG;
    const hosts = path ? parseConfiguration(await readPrivateCatalogConfiguration(path)) : [];
    return new CodexModelCatalog({ ...options, hosts });
  }

  private available(hostId: string, snapshot: ModelCatalogSnapshot): HostModelCatalog {
    return { hostId, status: 'available', source: hostId === 'local' ? 'local-app-server' : 'tailscale-model-agent',
      observedAt: snapshot.observedAt, expiresAt: new Date(Date.parse(snapshot.observedAt) + MODEL_CATALOG_TTL_MS).toISOString(),
      models: structuredClone(snapshot.models) };
  }

  async list(hostId: string): Promise<HostModelCatalog> {
    if (typeof hostId !== 'string' || (hostId !== 'local' && !hostIdPattern.test(hostId))) {
      throw new CodexModelCatalogError('The selected Codex host is unavailable.', 404, 'catalogue_unavailable');
    }
    const url = this.hosts.get(hostId);
    if (hostId !== 'local' && !url) {
      return { hostId, status: 'unavailable', source: null, observedAt: null, expiresAt: null, models: [], reason: 'not_configured' };
    }
    const previous = this.snapshots.get(hostId);
    if (previous && this.now() - Date.parse(previous.observedAt) < MODEL_CATALOG_TTL_MS) return this.available(hostId, previous);
    const pending = this.pending.get(hostId);
    if (pending) return structuredClone(await pending);
    this.snapshots.delete(hostId);
    const refresh = (async (): Promise<HostModelCatalog> => {
      try {
        const raw = hostId === 'local' ? await this.readLocal() : await readRemote(url!, this.requester, this.timeoutMs);
        const snapshot = parseModelCatalogSnapshot(raw, this.now());
        this.snapshots.set(hostId, snapshot);
        return this.available(hostId, snapshot);
      } catch (error) {
        const code = error instanceof CodexModelCatalogError ? error.code : 'catalogue_unavailable';
        return { hostId, status: 'unavailable', source: hostId === 'local' ? 'local-app-server' : 'tailscale-model-agent',
          observedAt: null, expiresAt: null, models: [],
          reason: code === 'catalogue_stale' ? 'catalogue_stale' : code === 'invalid_catalogue' ? 'invalid_catalogue' : 'source_unavailable' };
      }
    })();
    this.pending.set(hostId, refresh);
    try { return await refresh; } finally { this.pending.delete(hostId); }
  }

  async requireSelection(hostId: string, selection: ModelSelection): Promise<CatalogModel> {
    if (!isRecord(selection) || typeof selection.model !== 'string' || !selection.model || selection.model.length > 256
      || typeof selection.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(selection.reasoningEffort)
      || (selection.hasImages !== undefined && typeof selection.hasImages !== 'boolean')) {
      throw new CodexModelCatalogError('Choose a model and reasoning effort from the selected host catalogue.', 400, 'unsupported_model');
    }
    const catalogue = await this.list(hostId);
    if (catalogue.status !== 'available') {
      throw new CodexModelCatalogError('Refresh the selected host model catalogue before sending.', 503, 'catalogue_unavailable');
    }
    const model = catalogue.models.find(model => model.model === selection.model);
    if (!model) throw new CodexModelCatalogError('The selected model is not available on this host.', 400, 'unsupported_model');
    if (!model.supportedReasoningEfforts.some(option => option.reasoningEffort === selection.reasoningEffort)) {
      throw new CodexModelCatalogError('The selected reasoning effort is not supported by this model.', 400, 'unsupported_reasoning_effort');
    }
    if (!model.inputModalities.includes('text') || (selection.hasImages && !model.inputModalities.includes('image'))) {
      throw new CodexModelCatalogError('The selected model does not support this message input.', 400, 'unsupported_input_modality');
    }
    return model;
  }
}
