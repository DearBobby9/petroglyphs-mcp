import type { Express, Request, Response } from 'express';
import { CodexDesktopIpcError } from './codex-desktop-ipc.js';
import { CodexRoutingError, isThreadId } from './codex-threads.js';
import { ConversationError, isCodexHost } from './codex-message-input.js';
import type { CodexConversations } from './codex-conversations.js';

/** These routes intentionally have no public/unpaired variant. */
export function installConversationRoutes(app: Express, service?: CodexConversations): void {
  const authorize = (res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required to access Codex conversations.', code: 'pairing_required' });
      return false;
    }
    if (!service) {
      res.status(503).json({ error: 'Codex Desktop conversation access is not enabled on this Mac.', code: 'desktop_unavailable' });
      return false;
    }
    return true;
  };
  const failure = (res: Response, error: unknown) => {
    const known = error instanceof CodexRoutingError || error instanceof CodexDesktopIpcError;
    res.status(known ? error.status : 503).json({
      error: known ? error.message : 'Codex conversation access is temporarily unavailable. Try again when the connection is ready.',
      code: error instanceof ConversationError ? error.code : 'conversation_unavailable',
    });
  };
  const target = (req: Request) => {
    const { hostId, threadId } = req.query;
    if (!isCodexHost(hostId) || !isThreadId(threadId)) throw new ConversationError('Select a valid Codex connection and chat.', 400, 'invalid_target');
    return { hostId, threadId };
  };

  app.get('/api/codex/conversation', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId, threadId } = target(req);
      const { before, limit } = req.query;
      if ((before !== undefined && typeof before !== 'string')
        || (limit !== undefined && (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit)))) {
        throw new ConversationError('Provide one history cursor and a page size from 1 to 100.', 400, 'invalid_page');
      }
      res.json(await service!.conversation(hostId, threadId, { before: before as string | undefined,
        ...(limit !== undefined ? { limit: Number(limit) } : {}) }));
    } catch (error) { failure(res, error); }
  });

  app.post('/api/codex/messages', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const accepted = await service!.accept(req.body);
      res.status(accepted.duplicate ? 200 : 202).json(accepted.receipt);
    } catch (error) { failure(res, error); }
  });

  app.get('/api/codex/messages/:id', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId, threadId } = target(req);
      res.json(await service!.get(hostId, threadId, String(req.params.id)));
    } catch (error) { failure(res, error); }
  });

  app.get('/api/codex/assets/:id', (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId, threadId } = target(req);
      const asset = service!.asset(hostId, threadId, String(req.params.id));
      res.set('X-Content-Type-Options', 'nosniff');
      res.type(asset.mimeType).send(asset.bytes);
    } catch (error) { failure(res, error); }
  });
}
