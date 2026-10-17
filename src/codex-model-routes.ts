import type { Express, Response } from 'express';
import type { CodexModelCatalog } from './codex-model-catalog.js';
import type { DesktopModelSettings } from './codex-desktop-ipc.js';
import { ConversationError, isCodexHost } from './codex-message-input.js';
import { CodexRoutingError, isThreadId } from './codex-threads.js';

export interface ModelAccess {
  catalog: Pick<CodexModelCatalog, 'list'>;
  readSettings(hostId: string, threadId: string): Promise<DesktopModelSettings>;
}

export function installModelRoutes(app: Express, access?: ModelAccess): void {
  const authorize = (res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.autoReplyAuthorized) {
      res.status(403).json({ error: 'A paired device URL is required.', code: 'pairing_required' }); return false;
    }
    if (!access) {
      res.status(503).json({ error: 'Codex Desktop model access is not enabled.', code: 'models_unavailable' }); return false;
    }
    return true;
  };
  const failure = (res: Response, error: unknown) => res.status(error instanceof CodexRoutingError ? error.status : 503)
    .json({ error: error instanceof CodexRoutingError ? error.message : 'Codex model settings are temporarily unavailable.',
      code: error instanceof ConversationError ? error.code : 'models_unavailable' });

  app.get('/api/codex/models', async (req, res) => {
    if (!authorize(res)) return;
    try {
      if (!isCodexHost(req.query.hostId)) throw new ConversationError('Select one Codex connection.', 400, 'invalid_target');
      res.json(await access!.catalog.list(req.query.hostId));
    } catch (error) { failure(res, error); }
  });

  app.get('/api/codex/model-settings', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId, threadId } = req.query;
      if (!isCodexHost(hostId) || !isThreadId(threadId)) throw new ConversationError('Select one Codex connection and chat.', 400, 'invalid_target');
      const settings = await access!.readSettings(hostId, threadId);
      res.json({ hostId, threadId, model: settings.model ?? null, reasoningEffort: settings.reasoningEffort ?? null,
        observedAt: new Date().toISOString() });
    } catch (error) { failure(res, error); }
  });
}
