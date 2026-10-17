import type { Express, Response } from 'express';
import { CodexRoutingError } from './codex-threads.js';
import { ConversationError, isCodexHost } from './codex-message-input.js';
import { validProjectId } from './codex-projects-catalog.js';
import type { CodexProjectChats } from './codex-project-chats.js';

export function installProjectRoutes(app: Express, service?: CodexProjectChats): void {
  const authorize = (res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.autoReplyAuthorized) { res.status(403).json({ error: 'A paired device URL is required.', code: 'pairing_required' }); return false; }
    if (!service) { res.status(503).json({ error: 'Codex Desktop project access is not enabled.', code: 'projects_unavailable' }); return false; }
    return true;
  };
  const failure = (res: Response, error: unknown) => res.status(error instanceof CodexRoutingError ? error.status : 503)
    .json({ error: error instanceof CodexRoutingError ? error.message : 'Codex project access is temporarily unavailable.',
      code: error instanceof ConversationError ? error.code : 'projects_unavailable' });

  app.get('/api/codex/projects', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId } = req.query;
      if (!isCodexHost(hostId)) throw new ConversationError('Select one Codex connection.', 400, 'invalid_target');
      res.json(await service!.projects(hostId));
    } catch (error) { failure(res, error); }
  });

  app.post('/api/codex/chats', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const result = await service!.accept(req.body);
      res.status(result.duplicate ? 200 : 202).json(result.receipt);
    } catch (error) { failure(res, error); }
  });

  app.get('/api/codex/chats/:id', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const { hostId, projectId } = req.query;
      if (!isCodexHost(hostId) || !validProjectId(projectId)) throw new ConversationError('Select one project and connection.', 400, 'invalid_target');
      res.json(await service!.status(hostId, projectId, String(req.params.id)));
    } catch (error) { failure(res, error); }
  });

  app.post('/api/codex/chats/:id/retry', async (req, res) => {
    if (!authorize(res)) return;
    try {
      const result = await service!.retry(String(req.params.id), req.body);
      res.status(result.duplicate ? 200 : 202).json(result.receipt);
    } catch (error) { failure(res, error); }
  });
}
