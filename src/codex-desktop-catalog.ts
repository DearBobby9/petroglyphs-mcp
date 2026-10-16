import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { CodexRoutingError, isThreadId, type CodexThread, type ThreadPage, type ThreadQuery } from './codex-threads.js';

const hostIdPattern = /^remote-control:env_[A-Za-z0-9_-]{1,128}$/;
const cursorSchema = z.object({
  version: z.literal(1),
  hostId: z.string().regex(hostIdPattern),
  search: z.string().max(200),
  updatedAt: z.number().finite(),
  threadId: z.string().refine(isThreadId),
}).strict();
const hostRowSchema = z.object({
  host_id: z.string().regex(hostIdPattern),
  initial_build_complete: z.number().int().nullable(),
  watermark_updated_at: z.number().finite().nullable(),
  last_full_reconciled_at: z.number().finite().nullable(),
});
const threadRowSchema = z.object({
  thread_id: z.string().refine(isThreadId),
  display_title: z.string(),
  cwd: z.string().nullable(),
  source_updated_at: z.number().finite(),
});
const hostNamesSchema = z.object({
  hosts: z.array(z.object({
    id: z.string().regex(hostIdPattern), name: z.string().trim().min(1).max(100),
  }).strict()).max(256),
}).strict();
type HostRow = z.infer<typeof hostRowSchema>;
type Connections = Map<string, boolean>;

export interface DesktopCatalogStatus {
  source: 'codex-desktop-catalog';
  complete: boolean;
  revision: number;
  /** A source thread timestamp in seconds, not the time of the last sync. */
  sourceUpdatedAtWatermark: number | null;
  /** Desktop's last complete reconciliation time, in Unix milliseconds. */
  lastFullReconciledAt: number | null;
  connectionState: 'unknown';
  searchScope: 'title-and-path';
}

export interface DesktopCatalogHostSummary {
  id: string;
  name: string;
  kind: 'remote';
  configured: boolean;
  /** The saved connection can be attempted. This does not establish that it is online. */
  available: boolean;
  reason?: string;
  catalog?: DesktopCatalogStatus;
}

export interface DesktopCatalogThreadPage extends ThreadPage {
  catalog: DesktopCatalogStatus;
}

export interface DesktopCatalogOptions {
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  statePath?: string;
  /** Optional credential-free labels: { hosts: [{ id, name }] }. */
  metadataPath?: string;
  pageSize?: number;
}

export class CodexDesktopCatalogError extends CodexRoutingError {}

const hostSelect = `SELECT h.host_id, s.initial_build_complete,
  s.watermark_updated_at, s.last_full_reconciled_at
  FROM local_thread_catalog_hosts h
  LEFT JOIN local_thread_catalog_sync_state s ON s.host_id = h.host_id
  WHERE h.host_kind = 'remote-control'`;
const visibleThreads = `host_id = ? AND missing_candidate = 0
  AND source_kind NOT IN ('chatgpt', 'exec')
  AND (thread_source IS NULL OR thread_source NOT IN
    ('chatgpt_hidden', 'ambient_suggestions', 'pull_request_fix_automation'))`;

function catalogStatus(row: HostRow, revision: number): DesktopCatalogStatus {
  return {
    source: 'codex-desktop-catalog', complete: row.initial_build_complete === 1, revision,
    sourceUpdatedAtWatermark: row.watermark_updated_at,
    lastFullReconciledAt: row.last_full_reconciled_at,
    connectionState: 'unknown', searchScope: 'title-and-path',
  };
}

function threadFromRow(value: unknown): CodexThread {
  const row = threadRowSchema.parse(value);
  return { id: row.thread_id, title: row.display_title.trim() || '未命名聊天',
    cwd: row.cwd ?? '', updatedAt: row.source_updated_at };
}

async function readConnections(statePath: string): Promise<Connections> {
  try {
    const metadata = await stat(statePath);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) return new Map();
    const data: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return new Map();
    const state = data as Record<string, unknown>;
    const result: Connections = new Map();
    const added = state['added-remote-control-env-ids'];
    if (Array.isArray(added)) {
      for (const value of added) {
        if (typeof value !== 'string') continue;
        const id = value.startsWith('remote-control:') ? value : `remote-control:${value}`;
        if (hostIdPattern.test(id)) result.set(id, true);
      }
    }
    const settings = state['remote-connection-auto-connect-by-host-id'];
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [id, enabled] of Object.entries(settings)) {
        if (hostIdPattern.test(id) && typeof enabled === 'boolean') result.set(id, enabled);
      }
    }
    // Only these connection preferences are consumed. Enrollment, account and
    // persisted conversation data must never enter catalog responses.
    return result;
  } catch { return new Map(); }
}

async function readHostNames(path: string | undefined): Promise<Map<string, string>> {
  if (path === undefined) return new Map();
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 128 * 1024) throw new Error();
    const parsed = hostNamesSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const names = new Map(parsed.hosts.map(host => [host.id, host.name]));
    if (names.size !== parsed.hosts.length) throw new Error();
    return names;
  } catch {
    throw new CodexDesktopCatalogError('Codex Desktop connection labels are unavailable. Check the host names configuration.', 503);
  }
}

function parseQuery(hostId: string, query: ThreadQuery) {
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 200)) {
    throw new CodexDesktopCatalogError('Chat search must contain at most 200 characters.', 400);
  }
  const search = query.search?.trim() ?? '';
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(query.cursor)) throw new Error();
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      if (cursor.hostId !== hostId || cursor.search !== search) throw new Error();
    } catch {
      throw new CodexDesktopCatalogError('The chat list cursor does not match this connection or search. Refresh the list.', 400);
    }
  }
  return { search, cursor };
}

/** Reads Desktop's maintained directory without opening another app-server. */
export class CodexDesktopCatalog {
  private readonly databasePath: string;
  private readonly statePath: string;
  private readonly metadataPath: string | undefined;
  private readonly pageSize: number;

  constructor(options: DesktopCatalogOptions = {}) {
    const env = options.env ?? process.env;
    const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
    this.databasePath = options.databasePath ?? join(codexHome, 'sqlite', 'codex-dev.db');
    this.statePath = options.statePath ?? join(codexHome, '.codex-global-state.json');
    this.metadataPath = options.metadataPath ?? env.PETROGLYPHS_DESKTOP_HOST_NAMES;
    this.pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) {
      throw new CodexDesktopCatalogError('Chat page size must be between 1 and 100.', 400);
    }
  }

  private async read<T>(work: (db: DatabaseSync, revision: number) => T): Promise<T> {
    let db: DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN');
      const row = db.prepare('SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id = 1').get();
      if (typeof row?.catalog_revision !== 'number') throw new Error();
      return work(db, row.catalog_revision);
    } catch (error) {
      if (error instanceof CodexDesktopCatalogError) throw error;
      throw new CodexDesktopCatalogError('Codex Desktop chat directory is unavailable. Open Codex Desktop and let it sync.', 503);
    } finally { db?.close(); }
  }

  async listHosts(): Promise<DesktopCatalogHostSummary[]> {
    const [connections, names] = await Promise.all([
      readConnections(this.statePath), readHostNames(this.metadataPath),
    ]);
    let rows: HostRow[] = [], revision = 0, unavailable = false;
    try {
      ({ rows, revision } = await this.read((db, revision) => ({
        rows: z.array(hostRowSchema).parse(db.prepare(`${hostSelect} ORDER BY h.host_id`).all()), revision,
      })));
    } catch { unavailable = true; }
    const catalog = new Map(rows.map(row => [row.host_id, catalogStatus(row, revision)]));
    const ids = [...new Set([...catalog.keys(), ...connections.keys()])].sort();
    return ids.map(id => {
      const configured = connections.get(id) === true;
      const status = catalog.get(id);
      const available = configured && status?.complete === true;
      const reason = !configured ? 'Enable this saved connection in Codex Desktop.'
        : unavailable ? 'Codex Desktop chat directory is unavailable.'
          : !status?.complete ? 'Codex Desktop has not finished indexing chats for this connection.' : undefined;
      return { id, name: names.get(id) ?? `Remote connection (${id.slice('remote-control:env_'.length, 'remote-control:env_'.length + 10)})`,
        kind: 'remote', configured, available, ...(reason ? { reason } : {}), ...(status ? { catalog: status } : {}) };
    });
  }

  private requireHost(db: DatabaseSync, hostId: string, connections: Connections): HostRow {
    if (!hostIdPattern.test(hostId)) throw new CodexDesktopCatalogError('The selected remote connection is unavailable.', 404);
    const row = db.prepare(`${hostSelect} AND h.host_id = ?`).get(hostId);
    if (!row && !connections.has(hostId)) throw new CodexDesktopCatalogError('The selected remote connection is unavailable.', 404);
    if (connections.get(hostId) !== true) {
      throw new CodexDesktopCatalogError('Enable this saved connection in Codex Desktop.', 503);
    }
    if (!row) throw new CodexDesktopCatalogError('Codex Desktop has not indexed this connection yet.', 503);
    const parsed = hostRowSchema.parse(row);
    if (parsed.initial_build_complete !== 1) {
      throw new CodexDesktopCatalogError('Codex Desktop has not finished indexing chats for this connection.', 503);
    }
    return parsed;
  }

  async listThreads(hostId: string, query: ThreadQuery = {}): Promise<DesktopCatalogThreadPage> {
    const { search, cursor } = parseQuery(hostId, query);
    const connections = await readConnections(this.statePath);
    return this.read((db, revision) => {
      const host = this.requireHost(db, hostId, connections);
      const values: SQLInputValue[] = [hostId];
      let where = visibleThreads;
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
        where += " AND (display_title LIKE ? ESCAPE '\\' OR COALESCE(cwd, '') LIKE ? ESCAPE '\\')";
        values.push(pattern, pattern);
      }
      if (cursor) {
        where += ' AND (source_updated_at < ? OR (source_updated_at = ? AND thread_id < ?))';
        values.push(cursor.updatedAt, cursor.updatedAt, cursor.threadId);
      }
      const rows = db.prepare(`SELECT thread_id, display_title, cwd, source_updated_at
        FROM local_thread_catalog WHERE ${where}
        ORDER BY source_updated_at DESC, thread_id DESC LIMIT ?`).all(...values, this.pageSize + 1);
      const threads = rows.slice(0, this.pageSize).map(threadFromRow);
      const last = threads.at(-1);
      const nextCursor = rows.length > this.pageSize && last
        ? Buffer.from(JSON.stringify({ version: 1, hostId, search, updatedAt: last.updatedAt, threadId: last.id })).toString('base64url')
        : null;
      return { threads, nextCursor, catalog: catalogStatus(host, revision) };
    });
  }

  /** Membership in the last complete directory is not a live authorization or archive check. */
  async requireThread(hostId: string, threadId: string): Promise<CodexThread> {
    if (!isThreadId(threadId)) throw new CodexDesktopCatalogError('A valid threadId is required.', 400);
    const connections = await readConnections(this.statePath);
    return this.read(db => {
      this.requireHost(db, hostId, connections);
      const row = db.prepare(`SELECT thread_id, display_title, cwd, source_updated_at
        FROM local_thread_catalog WHERE ${visibleThreads} AND thread_id = ?`).get(hostId, threadId);
      if (!row) throw new CodexDesktopCatalogError('The selected chat is not in this connection’s active directory. Refresh the list.', 404);
      return threadFromRow(row);
    });
  }
}
