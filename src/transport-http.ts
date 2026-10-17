import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cors from 'cors';
import { loadAutoReply } from './codex-auto-reply.js';
import { CodexRoutingError, isThreadId } from './codex-threads.js';
import { RemoteHostError, RemoteHosts } from './remote-hosts.js';
import { installConversationRoutes } from './codex-conversation-routes.js';
import { installProjectRoutes } from './codex-project-routes.js';
import { installModelRoutes } from './codex-model-routes.js';
import { installDiagnosticsRoutes } from './codex-diagnostics.js';
import { installControlRoutes } from './codex-execution-controls.js';
import { ConversationError } from './codex-message-input.js';
import { validProjectId } from './codex-projects-catalog.js';
import { BridgeConnection, installBridgeIdentityRoute } from './bridge-connection.js';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { store, DEFAULT_SESSION } from './store.js';
import type { Submission, Combo, StrokeMetadata } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const landingHtml = readFileSync(join(__dirname, '..', 'src', 'landing.html'), 'utf-8');

const sessions = new Map<string, StreamableHTTPServerTransport>();

interface BetaSignup {
  id: string;
  ts: string;
  email: string;
  useCase: string;
  workflow: string;
  ref: string;
}

const betaSignups: BetaSignup[] = [];

export async function startHttp(port: number): Promise<Server> {
  const app = express();
  const autoReply = loadAutoReply();
  const remoteHosts = await RemoteHosts.fromEnvironment();
  const bridgeConnection = autoReply ? new BridgeConnection(autoReply.devicePrefix.slice('/device/'.length)) : undefined;
  installBridgeIdentityRoute(app, bridgeConnection);
  app.use((req, res, next) => {
    if (autoReply && req.path.startsWith(`${autoReply.devicePrefix}/api/`)) {
      res.locals.autoReplyAuthorized = true;
      req.url = req.url.slice(autoReply.devicePrefix.length);
    }
    if (process.env.PETROGLYPHS_REQUIRE_DEVICE_AUTH === '1' && !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required.' });
      return;
    }
    next();
  });

  app.use(cors());
  app.use('/api/codex', (_req, res, next) => {
    if (!res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to access Codex.', code: 'pairing_required' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  app.use('/assets', express.static(join(__dirname, '..', 'public')));
  installConversationRoutes(app, remoteHosts.conversations);
  installProjectRoutes(app, remoteHosts.projectChats);
  installModelRoutes(app, remoteHosts.models);
  installDiagnosticsRoutes(app, remoteHosts.diagnostics);
  installControlRoutes(app, remoteHosts.controls);

  // ── Landing page ──

  app.get('/', (_req, res) => {
    res.type('html').send(landingHtml);
  });

  // ── Engagement signals ──

  app.post('/api/ping', (req, res) => {
    const { signal, ref } = req.body as { signal?: string; ref?: string };
    if (signal) {
      console.log(JSON.stringify({ signal, ref: ref || '', ts: new Date().toISOString() }));
    }
    res.json({ ok: true });
  });

  // ── Beta signup ──

  app.post('/api/beta-signup', (req, res) => {
    const { email, useCase, workflow, ref } = req.body as {
      email?: string;
      useCase?: string;
      workflow?: string;
      ref?: string;
    };

    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const signup: BetaSignup = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      email: email.trim().toLowerCase(),
      useCase: (useCase ?? '').trim(),
      workflow: (workflow ?? '').trim(),
      ref: (ref ?? '').trim(),
    };

    betaSignups.push(signup);
    console.log(JSON.stringify({ signal: 'signup', ...signup }));

    res.json({ success: true });
  });

  app.get('/api/beta-signups', (req, res) => {
    if (req.query['key'] !== process.env.ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ count: betaSignups.length, signups: betaSignups });
  });

  // ── iPad REST API ──

  app.get('/api/health', async (_req, res) => {
    const bridge = res.locals.autoReplyAuthorized ? await bridgeConnection?.metadata().catch(() => undefined) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      ...(res.locals.autoReplyAuthorized ? { autoReply: autoReply?.status() } : {}),
      ...(bridge ? { bridge } : {}),
      version: '0.1.0',
      submissions: store.getCount(DEFAULT_SESSION),
      activeSessions: store.getActiveSessionCount(),
    });
  });

  app.get('/api/validate-code', (req, res) => {
    const code = (req.query['code'] as string | undefined)?.toUpperCase();
    if (!code) {
      res.status(400).json({ valid: false, error: 'Missing code' });
      return;
    }
    const sessionId = store.resolveSession(code);
    if (sessionId) {
      res.json({ valid: true });
    } else {
      res.status(404).json({ valid: false, error: 'Invalid pairing code' });
    }
  });

  app.get('/api/codex/hosts', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!autoReply || !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to access Codex connections.' });
      return;
    }
    try {
      res.json({ hosts: [
        { id: 'local', name: 'This Mac', kind: 'local', configured: true, available: true },
        ...await remoteHosts.listHosts(),
      ] });
    } catch {
      res.status(503).json({ error: 'Codex connections are temporarily unavailable.' });
    }
  });

  app.get('/api/codex/threads', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!autoReply || !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to access Codex chats.' });
      return;
    }
    const { search, cursor, projectId, hostId = 'local' } = req.query;
    if ((search !== undefined && (typeof search !== 'string' || search.length > 200))
      || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096))
      || (projectId !== undefined && !validProjectId(projectId))
      || typeof hostId !== 'string' || !hostId || hostId.length > 200) {
      res.status(400).json({ error: 'Invalid search, cursor, or hostId.' });
      return;
    }
    try {
      const query = { search: (search as string | undefined)?.trim(), cursor: cursor as string | undefined };
      if (projectId !== undefined) {
        if (!remoteHosts.projectChats) throw new ConversationError('Codex Desktop project access is not enabled.', 503, 'projects_unavailable');
        res.json(await remoteHosts.projectChats.listThreads(hostId, projectId as string, query));
        return;
      }
      res.json(hostId === 'local' ? await autoReply.listThreads(query) : await remoteHosts.listThreads(hostId, query));
    } catch (error) {
      const known = error instanceof CodexRoutingError || error instanceof RemoteHostError;
      res.status(known ? error.status : 503)
        .json({ error: known ? error.message : 'Codex chat lookup is unavailable.' });
    }
  });

  app.get('/api/codex/submissions', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!autoReply || !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to recover Codex submissions.' });
      return;
    }
    const { threadId, hostId = 'local' } = req.query;
    if (!isThreadId(threadId) || typeof hostId !== 'string' || !hostId || hostId.length > 200) {
      res.status(400).json({ error: 'A valid threadId and hostId are required.' });
      return;
    }
    try {
      res.json(hostId === 'local' ? autoReply.listSubmissions(threadId) : await remoteHosts.listSubmissions(hostId, threadId));
    } catch (error) {
      const known = error instanceof CodexRoutingError || error instanceof RemoteHostError;
      res.status(known ? error.status : 503)
        .json({ error: known ? error.message : 'Codex submissions are temporarily unavailable. Try again.' });
    }
  });

  app.get('/api/codex/submissions/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!autoReply || !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to read Codex replies.' });
      return;
    }
    const { hostId = 'local' } = req.query;
    if (typeof hostId !== 'string' || !hostId || hostId.length > 200) {
      res.status(400).json({ error: 'Invalid hostId.' });
      return;
    }
    try {
      res.json(hostId === 'local' ? await autoReply.getSubmission(req.params.id) : await remoteHosts.submission(hostId, req.params.id));
    } catch (error) {
      const known = error instanceof CodexRoutingError || error instanceof RemoteHostError;
      res.status(known ? error.status : 503)
        .json({ error: known ? error.message : 'Codex replies are temporarily unavailable. Try again.' });
    }
  });

  app.post('/api/submit', async (req, res) => {
    const { image, strokeMetadata, combo, pairing_code, threadId, hostId } = (req.body ?? {}) as {
      image?: string;
      strokeMetadata?: StrokeMetadata;
      combo?: Combo | null;
      pairing_code?: string;
      threadId?: unknown;
      hostId?: unknown;
    };

    if ((threadId !== undefined || hostId !== undefined) && !res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to send to Codex.' });
      return;
    }
    if (res.locals.autoReplyAuthorized && !isThreadId(threadId)) {
      res.status(400).json({ error: 'Choose a Codex chat before sending. A valid threadId is required.' });
      return;
    }
    if (hostId !== undefined && (typeof hostId !== 'string' || !hostId || hostId.length > 200)) {
      res.status(400).json({ error: 'Invalid hostId.' });
      return;
    }
    if (typeof image !== 'string' || !image || !strokeMetadata) {
      res.status(400).json({ error: 'Missing required fields: image, strokeMetadata' });
      return;
    }
    if (res.locals.autoReplyAuthorized && typeof hostId === 'string' && hostId !== 'local') {
      try {
        res.json(await remoteHosts.submit(hostId, { image, strokeMetadata, combo, threadId: threadId as string }));
      } catch (error) {
        const known = error instanceof RemoteHostError || error instanceof CodexRoutingError;
        res.status(known ? error.status : 503)
          .json({ error: known ? error.message : 'The remote service did not confirm this submission. Check the selected chat before retrying.' });
      }
      return;
    }

    // Resolve session from pairing code, fall back to local
    let sessionId = DEFAULT_SESSION;
    if (pairing_code) {
      const resolved = store.resolveSession(pairing_code);
      if (!resolved) {
        res.status(400).json({ error: 'Invalid pairing code' });
        return;
      }
      sessionId = resolved;
    }

    const submission: Submission = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      imageBase64: image,
      mimeType: 'image/png',
      strokeMetadata,
      combo: combo ?? null,
    };

    if (autoReply && res.locals.autoReplyAuthorized) {
      try { await autoReply.accept(submission, threadId as string); }
      catch (error) {
        if (error instanceof CodexRoutingError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        console.error('[petroglyphs] could not persist auto-reply submission:', error);
        res.status(500).json({ error: 'Could not save image for Codex' });
        return;
      }
    }
    store.addSubmission(sessionId, submission);

    res.json({ id: submission.id, status: 'received', ...(res.locals.autoReplyAuthorized ? { threadId, hostId: 'local' } : {}) });
    console.error(`[petroglyphs] submission received: ${submission.id} (session: ${sessionId === DEFAULT_SESSION ? 'local' : sessionId.slice(0, 8)})`);
  });

  // ── MCP Streamable HTTP ──

  app.post('/mcp', async (req, res) => {
    const existingSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (existingSessionId && sessions.has(existingSessionId)) {
      const transport = sessions.get(existingSessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Stale session ID — tell client to re-initialize
    if (existingSessionId) {
      res.status(404).json({ error: 'Session not found. Please reconnect.' });
      return;
    }

    // New session — pre-generate ID so both transport and server share it
    const sessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        store.removeSession(sid);
      }
    };

    // The native iPad Local mode submits without a pairing code.
    const server = createServer(process.argv.includes('--local-mcp') ? DEFAULT_SESSION : sessionId);
    await server.connect(transport);

    sessions.set(sessionId, transport);

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.path.startsWith('/api/codex/')) { next(error); return; }
    const kind = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    res.status(kind === 'entity.too.large' ? 413 : 400).json({
      error: kind === 'entity.too.large' ? 'The message request is too large.' : 'The message request is not valid JSON.',
      code: kind === 'entity.too.large' ? 'request_too_large' : 'invalid_json',
    });
  });

  return new Promise((resolve, reject) => {
    const onListening = () => {
      const address = listener.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      bridgeConnection?.setPort(actualPort);
      console.error(`[petroglyphs] HTTP server listening on http://localhost:${actualPort}`);
      console.error(`[petroglyphs]   Landing:   GET  http://localhost:${actualPort}/`);
      console.error(`[petroglyphs]   iPad API:  POST http://localhost:${actualPort}/api/submit`);
      console.error(`[petroglyphs]   Health:    GET  http://localhost:${actualPort}/api/health`);
      console.error(`[petroglyphs]   MCP HTTP:  POST http://localhost:${actualPort}/mcp`);
      resolve(listener);
    };
    const bindHost = process.env.PETROGLYPHS_BIND_HOST;
    const listener = bindHost ? app.listen(port, bindHost, onListening) : app.listen(port, onListening);
    listener.once('close', () => remoteHosts.close());
    listener.once('error', reject);
  });
}
