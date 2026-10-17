import { z } from 'zod';
import type { CodexModelSelection, DesktopTurnModelEvidence } from './codex-desktop-ipc.js';

const setting = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));

export const modelSelectionSchema = z.object({ model: setting(256), reasoningEffort: setting(64) }).strict();
export const modelEvidenceSchema = z.object({
  model: setting(256), reasoningEffort: setting(64).nullable(),
  reroutes: z.array(z.object({ fromModel: setting(256), toModel: setting(256), reason: setting(256) }).strict()).max(100),
}).strict();
export type ModelVerification = 'pending' | 'confirmed' | 'different' | 'unverified';

/** Confirmation belongs to one matched native turn, never the current chat settings. */
export function modelVerificationFor(selection: CodexModelSelection, evidence: DesktopTurnModelEvidence | undefined,
  observed: boolean): ModelVerification {
  if (!evidence) return observed ? 'unverified' : 'pending';
  if (evidence.reroutes.length > 0 || evidence.model !== selection.model
    || (evidence.reasoningEffort !== null && evidence.reasoningEffort !== selection.reasoningEffort)) return 'different';
  return evidence.reasoningEffort === null ? 'unverified' : 'confirmed';
}
