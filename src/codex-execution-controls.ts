import type { Express, Response } from 'express';
import { z } from 'zod';
import { CodexDesktopIpcError, type DesktopInterruptReceipt, type DesktopInterruptTarget, type DesktopSnapshot } from './codex-desktop-ipc.js';
import type { RuntimeDiagnostics } from './codex-diagnostics.js';
import { historyTurns, record } from './codex-conversation-history.js';
import { isCodexHost } from './codex-message-input.js';
import { isThreadId } from './codex-threads.js';

interface ControlConnection {
  readSnapshot(hostId: string, threadId: string): Promise<DesktopSnapshot>;
  verifyLocalInterrupt(snapshot: DesktopSnapshot): Promise<boolean>;
  interruptTurn(input: DesktopInterruptTarget): Promise<DesktopInterruptReceipt>;
  close(): void;
}
interface Options {
  runtime: () => Promise<RuntimeDiagnostics>;
  connect: () => Promise<ControlConnection>;
  requireTarget(hostId: string, threadId: string): Promise<unknown>;
}
export interface PendingInteraction {
  kind: 'input' | 'approval' | 'other'; turnId: string | null;
  handlingLocation: 'desktop'; reason: 'no_authoritative_receipt' | 'unsupported_request';
}
export interface ControlCapability { supported: boolean; reason?: string; handlingLocation: 'ipad' | 'desktop' }
export interface ExecutionControls {
  hostId: string; threadId: string; observedAt: string; activeTurnId: string | null;
  capabilities: { stop: ControlCapability; answer: ControlCapability; approve: ControlCapability };
  pendingInteractions: PendingInteraction[];
}
export interface StopReceipt extends DesktopInterruptTarget { status: 'stopped' | 'already_finished'; observedAt: string }

const targetSchema = z.object({ hostId: z.string().refine(isCodexHost), threadId: z.string().refine(isThreadId) }).strict();
const stopSchema = targetSchema.extend({ turnId: z.string().refine(isThreadId) }).strict();
const desktopRequired: ControlCapability = { supported: false, reason: 'no_authoritative_receipt', handlingLocation: 'desktop' };
const inputMethods = new Set(['item/tool/requestUserInput', 'item/tool/requestOptionPicker']);
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'mcpServer/elicitation/request']);

export class ExecutionControlError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'not_sent' | 'unknown' = 'not_sent') {
    super(outcome === 'unknown' ? 'Codex did not confirm this stop. Check the original chat in Desktop.'
      : code === 'unsupported_desktop_version' ? 'This Desktop version has not been verified for execution controls. Use Desktop.'
        : 'Execution controls are unavailable for this chat. Check the original chat in Desktop.');
  }
}

function safeFailure(error: unknown): ExecutionControlError {
  if (error instanceof ExecutionControlError) return error;
  if (error instanceof CodexDesktopIpcError) {
    return new ExecutionControlError(error.outcome === 'unknown' ? 'control_delivery_unknown' : error.code,
      error.status, error.outcome);
  }
  return new ExecutionControlError('controls_unavailable', 503);
}

/** Only expose request kinds. Native request payloads can contain commands, paths, credentials, or instructions. */
function interactions(state: unknown, threadId: string): PendingInteraction[] {
  const value = record(state);
  if (!Array.isArray(value?.requests)) return [];
  return value.requests.flatMap(value => {
    const request = record(value), params = record(request?.params);
    if (!request || request.completed === true || (params?.threadId !== undefined && params.threadId !== threadId)) return [];
    const kind = inputMethods.has(String(request.method)) ? 'input' : approvalMethods.has(String(request.method)) ? 'approval' : 'other';
    return [{ kind, turnId: isThreadId(params?.turnId) ? params.turnId : null, handlingLocation: 'desktop',
      reason: kind === 'other' ? 'unsupported_request' : 'no_authoritative_receipt' } as PendingInteraction];
  });
}

/** Stops name a real turn. The Desktop handler checks that same turn after transport delivery. */
export class CodexExecutionControls {
  private readonly pendingStops = new Map<string, Promise<StopReceipt>>();
  constructor(private readonly options: Options) {}

  async read(hostId: string, threadId: string): Promise<ExecutionControls> {
    if (!targetSchema.safeParse({ hostId, threadId }).success) throw new ExecutionControlError('invalid_target', 400);
    let connection: ControlConnection | undefined;
    try {
      await this.options.requireTarget(hostId, threadId);
      const runtime = await this.options.runtime();
      connection = await this.options.connect();
      const snapshot = await connection.readSnapshot(hostId, threadId);
      if (snapshot.hostId !== hostId || snapshot.threadId !== threadId) throw new ExecutionControlError('protocol_mismatch', 503);
      const active = historyTurns(snapshot.conversationState, threadId).filter(turn => turn.status === 'inProgress');
      const activeTurnId = active.length === 1 && isThreadId(active[0].id) ? active[0].id : null;
      let reason = runtime.compatibility.state !== 'baseline_match' ? 'unsupported_desktop_version'
        : hostId !== 'local' ? 'capability_unverified'
          : active.length > 1 ? 'ambiguous_active_turn' : !activeTurnId ? 'no_active_turn' : undefined;
      if (!reason && !await connection.verifyLocalInterrupt(snapshot)) reason = 'capability_unverified';
      return { hostId, threadId, observedAt: new Date().toISOString(), activeTurnId,
        capabilities: { stop: reason ? { supported: false, reason, handlingLocation: 'desktop' }
          : { supported: true, handlingLocation: 'ipad' }, answer: { ...desktopRequired }, approve: { ...desktopRequired } },
        pendingInteractions: interactions(snapshot.conversationState, threadId) };
    } catch (error) { throw safeFailure(error); }
    finally { connection?.close(); }
  }

  async stop(value: unknown): Promise<StopReceipt> {
    const parsed = stopSchema.safeParse(value);
    if (!parsed.success) throw new ExecutionControlError('invalid_control_target', 400);
    const input = parsed.data;
    const key = `${input.hostId}\0${input.threadId}\0${input.turnId}`;
    const previous = this.pendingStops.get(key);
    if (previous) return structuredClone(await previous);
    const operation = (async (): Promise<StopReceipt> => {
      let connection: ControlConnection | undefined;
      try {
        await this.options.requireTarget(input.hostId, input.threadId);
        if ((await this.options.runtime()).compatibility.state !== 'baseline_match') {
          throw new ExecutionControlError('unsupported_desktop_version', 409);
        }
        if (input.hostId !== 'local') throw new ExecutionControlError('capability_unverified', 409);
        connection = await this.options.connect();
        const receipt = await connection.interruptTurn(input);
        if (receipt.interruptedTurnId !== null && receipt.interruptedTurnId !== input.turnId) {
          throw new ExecutionControlError('control_delivery_unknown', 503, 'unknown');
        }
        return { ...input, status: receipt.interruptedTurnId === input.turnId ? 'stopped' : 'already_finished',
          observedAt: new Date().toISOString() };
      } catch (error) { throw safeFailure(error); }
      finally { connection?.close(); }
    })();
    this.pendingStops.set(key, operation);
    try { return structuredClone(await operation); }
    finally { if (this.pendingStops.get(key) === operation) this.pendingStops.delete(key); }
  }
}

export function installControlRoutes(app: Express, controls?: Pick<CodexExecutionControls, 'read' | 'stop'>): void {
  const authorize = (res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.autoReplyAuthorized) { res.status(403).json({ code: 'pairing_required' }); return false; }
    if (!controls) { res.status(503).json({ code: 'controls_unavailable', handlingLocation: 'desktop' }); return false; }
    return true;
  };
  const failure = (res: Response, error: unknown) => {
    const failure = safeFailure(error);
    res.status(failure.status).json({ error: failure.message, code: failure.code, outcome: failure.outcome, handlingLocation: 'desktop' });
  };
  app.get('/api/codex/controls', async (req, res) => {
    if (!authorize(res)) return;
    const parsed = targetSchema.safeParse(req.query);
    if (!parsed.success) { failure(res, new ExecutionControlError('invalid_target', 400)); return; }
    try { res.json(await controls!.read(parsed.data.hostId, parsed.data.threadId)); }
    catch (error) { failure(res, error); }
  });
  app.post('/api/codex/controls/stop', async (req, res) => {
    if (!authorize(res)) return;
    const parsed = stopSchema.safeParse(req.body);
    if (!parsed.success) { failure(res, new ExecutionControlError('invalid_control_target', 400)); return; }
    try { res.json(await controls!.stop(parsed.data)); }
    catch (error) { failure(res, error); }
  });
}
