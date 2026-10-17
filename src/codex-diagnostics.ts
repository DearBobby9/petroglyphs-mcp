import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { z } from 'zod';
import { CodexDesktopIpcError, type DesktopModelSettings, type DesktopSnapshot } from './codex-desktop-ipc.js';
import { isCodexHost } from './codex-message-input.js';
import { isThreadId } from './codex-threads.js';
import type { HostModelCatalog } from './codex-model-catalog.js';
import { BUNDLED_CODEX_PATH } from './codex-native-app-server.js';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Installed-artifact inspection is a compatibility baseline, not a successful host operation. */
export const DESKTOP_COMPATIBILITY_BASELINE = Object.freeze({
  desktopVersion: '26.1013.40934', desktopBuild: '20770', bundledCliVersion: '0.163.0-alpha.10.2',
  asarSha256: '5ddc4e48259aa6f979e04529b1a5a4ae54b0f5c4ad6db5c6e004924c10916ddb',
  inspectedAt: '2026-10-17T03:21:25.000Z',
  protocol: { snapshot: 11, readSettings: 1, loadHistory: 1, startTurn: 2, interruptTurn: 4,
    hostRoutedFollowerVersionOffset: 1 },
});

export const DESKTOP_COMPATIBILITY_BASELINES = Object.freeze([
  DESKTOP_COMPATIBILITY_BASELINE,
  Object.freeze({
    desktopVersion: '26.1013.31256', desktopBuild: '20586', bundledCliVersion: '0.163.0-alpha.10.2',
    asarSha256: 'bf9c41fa9770fbfacfba93042ff71c24cb65c82935819377275faac08103383f',
    inspectedAt: '2026-10-17T04:14:10.364Z',
    // Installed IPC handlers and an exact-owner no-op interrupt were checked on mini.
    protocol: { snapshot: 11, readSettings: 1, loadHistory: 1, startTurn: 2, interruptTurn: 4,
      hostRoutedFollowerVersionOffset: 1 },
  }),
]);

/** Match the complete inspected artifact identity; a version string alone is not sufficient. */
export function matchingDesktopCompatibilityBaseline(input: {
  version: string | null; build: string | null; asarSha256: string | null; bundledCliVersion: string | null;
}): (typeof DESKTOP_COMPATIBILITY_BASELINES)[number] | undefined {
  return DESKTOP_COMPATIBILITY_BASELINES.find(baseline => input.version === baseline.desktopVersion
    && input.build === baseline.desktopBuild && input.asarSha256 === baseline.asarSha256
    && input.bundledCliVersion === baseline.bundledCliVersion);
}

export interface RuntimeDiagnostics {
  mcp: { version: string | null; buildCommit: string | null; sourceCommit: string | null; sourceDirty: boolean | null };
  desktop: { version: string | null; build: string | null; asarSha256: string | null; artifactPath: string };
  executables: { configuredCli: ExecutableDiagnostic; nativeAppServer: ExecutableDiagnostic;
    modelAppServer: ExecutableDiagnostic; desktopBundledCli: ExecutableDiagnostic };
  compatibility: { state: 'baseline_match' | 'unverified'; reason: string | null;
    evidence: 'installed_artifact'; baseline: (typeof DESKTOP_COMPATIBILITY_BASELINES)[number] };
}
export interface ExecutableDiagnostic { path: string; resolvedPath: string | null; version: string | null }
export interface RuntimeDiagnosticOptions {
  codexPath: string; nativeCodexPath?: string; modelCodexPath?: string; desktopAppPath?: string;
  repositoryRoot?: string; buildCommit?: string;
}
export interface DiagnosticConnection {
  readSnapshot(hostId: string, threadId: string): Promise<DesktopSnapshot>;
  readSettings(hostId: string, threadId: string): Promise<DesktopModelSettings>;
  close(): void;
}
export interface DiagnosticsOptions {
  runtime: () => Promise<RuntimeDiagnostics>;
  connect: () => Promise<DiagnosticConnection>;
  requireTarget: (hostId: string, threadId: string) => Promise<unknown>;
  catalog: { list(hostId: string): Promise<HostModelCatalog> };
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}
async function output(file: string, args: string[], cwd?: string): Promise<string | null> {
  try { return (await execute(file, args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim(); }
  catch { return null; }
}
async function executable(path: string): Promise<ExecutableDiagnostic> {
  const resolved = await realpath(path).catch(() => null);
  const value = isAbsolute(path) ? await output(path, ['--version']) : null;
  const version = value?.match(/^codex-cli ([A-Za-z0-9.+_-]+)$/)?.[1] ?? null;
  return { path: displayPath(path), resolvedPath: resolved ? displayPath(resolved) : null, version };
}
async function digest(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest('hex');
  } catch { return null; }
}

/** Recompute when installed executables change. The result never includes stderr or account configuration. */
export function runtimeDiagnosticsReader(options: RuntimeDiagnosticOptions): () => Promise<RuntimeDiagnostics> {
  const app = options.desktopAppPath ?? '/Applications/ChatGPT.app';
  const bundled = join(app, 'Contents/Resources/codex-cli/bin/codex');
  const paths = [options.codexPath, options.nativeCodexPath ?? BUNDLED_CODEX_PATH,
    options.modelCodexPath ?? options.codexPath, bundled];
  const asar = join(app, 'Contents/Resources/app.asar');
  const plist = join(app, 'Contents/Info.plist');
  let cached: { key: string; value: Promise<RuntimeDiagnostics> } | undefined;
  return async () => {
    const stats = await Promise.all([...paths, asar, plist].map(async path => {
      const info = await stat(path).catch(() => null);
      return [path, info?.size ?? null, info?.mtimeMs ?? null];
    }));
    const key = JSON.stringify(stats);
    if (cached?.key === key) return structuredClone(await cached.value);
    const value = (async (): Promise<RuntimeDiagnostics> => {
      const repositoryRoot = options.repositoryRoot ?? root;
      const [executables, version, build, asarSha256, sourceCommit, dirty, pkg] = await Promise.all([
        Promise.all(paths.map(executable)),
        output('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleShortVersionString', plist]),
        output('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleVersion', plist]), digest(asar),
        output('/usr/bin/git', ['rev-parse', 'HEAD'], repositoryRoot),
        output('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal'], repositoryRoot),
        readFile(join(repositoryRoot, 'package.json'), 'utf8').then(value => JSON.parse(value)).catch(() => null),
      ]);
      const matchedBaseline = matchingDesktopCompatibilityBaseline({ version, build, asarSha256,
        bundledCliVersion: executables[3].version });
      const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
      return {
        mcp: { version: typeof pkg?.version === 'string' ? pkg.version : null, buildCommit: commit(options.buildCommit),
          sourceCommit: commit(sourceCommit), sourceDirty: dirty === null ? null : dirty.length > 0 },
        desktop: { version, build, asarSha256, artifactPath: displayPath(asar) },
        executables: { configuredCli: executables[0], nativeAppServer: executables[1], modelAppServer: executables[2], desktopBundledCli: executables[3] },
        compatibility: { state: matchedBaseline ? 'baseline_match' : 'unverified', reason: matchedBaseline ? null : 'installed_artifact_not_in_baseline',
          evidence: 'installed_artifact', baseline: matchedBaseline ?? DESKTOP_COMPATIBILITY_BASELINE },
      };
    })();
    cached = { key, value };
    return structuredClone(await value);
  };
}

export function diagnosticFailure(error: unknown): { code: string; outcome: 'not_sent' | 'unknown'; handlingLocation: 'desktop' } {
  return { code: error instanceof CodexDesktopIpcError ? error.code : 'desktop_unavailable',
    outcome: error instanceof CodexDesktopIpcError ? error.outcome : 'not_sent', handlingLocation: 'desktop' };
}

const querySchema = z.object({
  hostId: z.string().refine(isCodexHost), threadId: z.string().refine(isThreadId),
  appVersion: z.string().regex(/^[A-Za-z0-9.+_-]{1,64}$/).optional(),
  appBuild: z.string().regex(/^[A-Za-z0-9.+_-]{1,64}$/).optional(),
  appCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
}).strict();

export class CodexDiagnostics {
  constructor(private readonly options: DiagnosticsOptions) {}

  async read(input: z.infer<typeof querySchema>) {
    const runtime = await this.options.runtime();
    let connection: DiagnosticConnection | undefined;
    let probe: { status: 'verified_read'; operations: string[]; revision: number }
      | { status: 'unavailable'; code: string; outcome: 'not_sent' | 'unknown'; handlingLocation: 'desktop' };
    try {
      await this.options.requireTarget(input.hostId, input.threadId);
      connection = await this.options.connect();
      await connection.readSettings(input.hostId, input.threadId);
      const snapshot = await connection.readSnapshot(input.hostId, input.threadId);
      if (snapshot.hostId !== input.hostId || snapshot.threadId !== input.threadId) {
        throw new CodexDesktopIpcError('Desktop target mismatch.', 503, 'not-sent', 'protocol_mismatch');
      }
      probe = { status: 'verified_read', operations: ['read_settings', 'read_history'], revision: snapshot.revision };
    } catch (error) { probe = { status: 'unavailable', ...diagnosticFailure(error) }; }
    finally { connection?.close(); }
    const catalog = await this.options.catalog.list(input.hostId).catch(() => null);
    return {
      version: 1, observedAt: new Date().toISOString(), hostId: input.hostId, threadId: input.threadId,
      app: { version: input.appVersion ?? null, build: input.appBuild ?? null, commit: input.appCommit ?? null,
        evidence: 'client_reported' }, ...runtime,
      host: { probe, modelCatalog: { status: catalog?.status ?? 'unavailable', source: catalog?.source ?? null,
        observedAt: catalog?.observedAt ?? null, expiresAt: catalog?.expiresAt ?? null, reason: catalog?.reason ?? null },
      execution: { send: 'not_tested', stop: 'not_tested', answer: 'not_tested', approve: 'not_tested' } },
    };
  }
}

export function installDiagnosticsRoutes(app: Express, diagnostics?: Pick<CodexDiagnostics, 'read'>): void {
  app.get('/api/codex/diagnostics', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.autoReplyAuthorized) { res.status(403).json({ code: 'pairing_required' }); return; }
    if (!diagnostics) { res.status(503).json({ code: 'diagnostics_unavailable', handlingLocation: 'desktop' }); return; }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ code: 'invalid_diagnostic_target' }); return; }
    try { res.json(await diagnostics.read(parsed.data)); }
    catch { res.status(503).json({ code: 'diagnostics_unavailable', handlingLocation: 'desktop' }); }
  });
}
