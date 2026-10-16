import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ConversationError, isCodexHost } from './codex-message-input.js';
import { isThreadId, type CodexThread, type ThreadPage, type ThreadQuery } from './codex-threads.js';

export interface SavedCodexProject { id: string; name: string; path: string; hostId: string }
export interface CreatedProjectThread extends CodexThread { createdAt: number }
interface State {
  projects: SavedCodexProject[];
  assignments: Record<string, unknown>;
  membershipHosts: Record<string, unknown>;
  aliasesByHost: Record<string, unknown>;
  projectless: Set<string>;
}
interface Options {
  env?: NodeJS.ProcessEnv;
  statePath?: string;
  databasePath?: string;
  requireHost: (hostId: string) => Promise<unknown>;
  pageSize?: number;
}
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const validProjectId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) && !value.startsWith('g-p-');
const cursorSchema = z.object({ v: z.literal(1), hostId: z.string().refine(isCodexHost),
  projectId: z.string().refine(validProjectId), search: z.string().max(200), updatedAt: z.number().finite(), threadId: z.string().refine(isThreadId),
}).strict();
const threadSchema = z.object({ thread_id: z.string().refine(isThreadId), display_title: z.string(),
  cwd: z.string().nullable(), source_updated_at: z.number().finite(), project_id: z.string().nullable() });

/** Desktop's saved definitions and explicit memberships, never cwd inference. */
export class CodexProjectsCatalog {
  private readonly statePath: string;
  private readonly databasePath: string;
  private readonly pageSize: number;

  constructor(private readonly options: Options) {
    const env = options.env ?? process.env;
    const root = env.CODEX_HOME || join(homedir(), '.codex');
    this.statePath = options.statePath ?? join(root, '.codex-global-state.json');
    this.databasePath = options.databasePath ?? join(root, 'sqlite', 'codex-dev.db');
    this.pageSize = options.pageSize ?? 50;
  }

  private async state(): Promise<State> {
    try {
      const info = await stat(this.statePath);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid state');
      const state = obj(JSON.parse(await readFile(this.statePath, 'utf8')));
      const projects: SavedCodexProject[] = [];
      for (const [id, value] of Object.entries(obj(state['local-projects']))) {
        const project = obj(value);
        if (!validProjectId(id) || project.id !== id || typeof project.name !== 'string'
          || !project.name.trim() || !Array.isArray(project.rootPaths) || project.chatGptBacking != null) continue;
        const path = project.rootPaths.find(value => typeof value === 'string' && value.length > 0);
        projects.push({ id, name: project.name.slice(0, 500), path: typeof path === 'string' ? path : '', hostId: 'local' });
      }
      if (Array.isArray(state['remote-projects'])) for (const value of state['remote-projects']) {
        const project = obj(value);
        if (!validProjectId(project.id) || !isCodexHost(project.hostId) || project.hostId === 'local'
          || typeof project.label !== 'string' || !project.label.trim() || typeof project.remotePath !== 'string'
          || !project.remotePath || project.chatGptBacking != null) continue;
        projects.push({ id: project.id, name: project.label.slice(0, 500), path: project.remotePath, hostId: project.hostId });
      }
      return { projects, assignments: obj(state['thread-project-assignments']),
        membershipHosts: obj(state['thread-project-membership-host-ids']), aliasesByHost: obj(state['app-server-project-id-by-legacy-project-id-by-host']),
        projectless: new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'].filter(isThreadId) : []) };
    } catch { throw new ConversationError('Codex Desktop project definitions are unavailable. Open Codex Desktop and try again.', 503, 'projects_unavailable'); }
  }

  async list(hostId: string): Promise<SavedCodexProject[]> {
    if (!isCodexHost(hostId)) throw new ConversationError('Select a valid Codex connection.', 400, 'invalid_target');
    await this.options.requireHost(hostId);
    return (await this.state()).projects.filter(project => project.hostId === hostId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async require(hostId: string, projectId: string): Promise<SavedCodexProject> {
    if (!validProjectId(projectId)) throw new ConversationError('Select a saved Codex project.', 400, 'invalid_project');
    const project = (await this.list(hostId)).find(project => project.id === projectId);
    if (!project) throw new ConversationError('This saved project is not available on the selected connection. Refresh Projects.', 404, 'project_not_found');
    return project;
  }

  private belongs(state: State, project: SavedCodexProject, threadId: string, serverProjectId: string | null): boolean {
    const membershipHost = state.membershipHosts[threadId];
    if (membershipHost !== undefined && membershipHost !== project.hostId) return false;
    if (state.projectless.has(threadId) && (membershipHost === undefined || membershipHost === project.hostId)) return false;
    if (Object.hasOwn(state.assignments, threadId)) {
      const assignment = obj(state.assignments[threadId]);
      return assignment.projectId === project.id && (project.hostId === 'local'
        ? assignment.projectKind === 'local' : assignment.projectKind === 'remote' && assignment.hostId === project.hostId);
    }
    if (serverProjectId === project.id) return true;
    for (const [hostKey, values] of Object.entries(state.aliasesByHost)) {
      if ((hostKey === project.hostId || hostKey.startsWith(`${project.hostId}:`)) && obj(values)[project.id] === serverProjectId) return true;
    }
    return false;
  }

  async listThreads(hostId: string, projectId: string, query: ThreadQuery = {}): Promise<ThreadPage> {
    if (!isCodexHost(hostId) || !validProjectId(projectId)) throw new ConversationError('Select a valid Codex project and connection.', 400, 'invalid_project');
    if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 200)) throw new ConversationError('Search must contain at most 200 characters.', 400, 'invalid_search');
    const search = query.search?.trim() ?? '';
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,2048}$/.test(query.cursor)) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
        if (cursor.hostId !== hostId || cursor.projectId !== projectId || cursor.search !== search) throw new Error();
      } catch { throw new ConversationError('The chat list cursor does not match this project or connection.', 400, 'invalid_cursor'); }
    }
    await this.options.requireHost(hostId);
    const state = await this.state();
    const project = state.projects.find(project => project.hostId === hostId && project.id === projectId);
    if (!project) throw new ConversationError('This saved project is no longer available. Refresh Projects.', 404, 'project_not_found');
    let db: DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN');
      const sync = db.prepare('SELECT initial_build_complete FROM local_thread_catalog_sync_state WHERE host_id = ?').get(hostId);
      if (sync?.initial_build_complete !== 1) throw new Error('Incomplete catalog');
      const rows = db.prepare(`SELECT thread_id, display_title, cwd, source_updated_at, project_id FROM local_thread_catalog
        WHERE host_id = ? AND missing_candidate = 0 AND source_kind NOT IN ('chatgpt', 'exec')
          AND (thread_source IS NULL OR thread_source NOT IN ('chatgpt_hidden', 'ambient_suggestions', 'pull_request_fix_automation'))
        ORDER BY source_updated_at DESC, thread_id DESC`).all(hostId);
      const filtered = rows.map(row => threadSchema.parse(row)).filter(row =>
        this.belongs(state, project, row.thread_id, row.project_id)
        && (!search || `${row.display_title}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
        && (!cursor || row.source_updated_at < cursor.updatedAt || (row.source_updated_at === cursor.updatedAt && row.thread_id < cursor.threadId)));
      const threads: CodexThread[] = filtered.slice(0, this.pageSize).map(row => ({ id: row.thread_id,
        title: row.display_title.trim() || '未命名聊天', cwd: row.cwd ?? '', updatedAt: row.source_updated_at }));
      const last = threads.at(-1);
      return { threads, nextCursor: filtered.length > this.pageSize && last ? Buffer.from(JSON.stringify({
        v: 1, hostId, projectId, search, updatedAt: last.updatedAt, threadId: last.id,
      })).toString('base64url') : null };
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('Codex Desktop has not finished loading project chats. Try again after it syncs.', 503, 'project_chats_unavailable');
    } finally { db?.close(); }
  }

  /** Bounded native evidence for creation reconciliation; never a cwd search. */
  async creationCandidates(hostId: string, projectId: string, since: string): Promise<{ threads: CreatedProjectThread[]; truncated: boolean }> {
    const timestamp = Date.parse(since);
    if (!Number.isFinite(timestamp)) throw new ConversationError('Invalid creation time.', 400, 'invalid_chat_request');
    await this.options.requireHost(hostId);
    const state = await this.state();
    const project = state.projects.find(project => project.hostId === hostId && project.id === projectId);
    if (!project) throw new ConversationError('This saved project is no longer available.', 404, 'project_not_found');
    let db: DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN');
      const sync = db.prepare('SELECT initial_build_complete FROM local_thread_catalog_sync_state WHERE host_id = ?').get(hostId);
      if (sync?.initial_build_complete !== 1) throw new Error('Incomplete catalog');
      const rows = db.prepare(`SELECT thread_id, display_title, cwd, source_updated_at, source_created_at, project_id
        FROM local_thread_catalog WHERE host_id = ? AND source_created_at >= ? AND missing_candidate = 0
          AND source_kind NOT IN ('chatgpt', 'exec')
          AND (thread_source IS NULL OR thread_source NOT IN ('chatgpt_hidden', 'ambient_suggestions', 'pull_request_fix_automation'))
        ORDER BY source_created_at, thread_id`).all(hostId, Math.floor(timestamp / 1000));
      const matches = rows.filter(row => typeof row.thread_id === 'string' && typeof row.source_created_at === 'number'
        && this.belongs(state, project, row.thread_id, typeof row.project_id === 'string' ? row.project_id : null));
      return { threads: matches.slice(0, 50).map(row => {
        const thread = threadSchema.parse(row);
        return { id: thread.thread_id, title: thread.display_title.trim() || '未命名聊天', cwd: thread.cwd ?? '',
          updatedAt: thread.source_updated_at, createdAt: row.source_created_at as number };
      }), truncated: matches.length > 50 };
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('Codex Desktop has not finished indexing the new chat.', 503, 'project_chats_unavailable');
    } finally { db?.close(); }
  }
}
