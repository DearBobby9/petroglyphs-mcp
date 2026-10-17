import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const settingsSchema = z.object({ deviceToken: z.string().regex(/^[0-9a-f]{32,}$/),
  codexPath: z.string().refine(isAbsolute), dataDir: z.string().refine(isAbsolute) });
export type BridgeSettings = z.infer<typeof settingsSchema>;

/** The legacy filename remains an alias; reading settings does not restore jobs. */
export function loadBridgeSettings(env: NodeJS.ProcessEnv = process.env): BridgeSettings | undefined {
  const path = env.PETROGLYPHS_BRIDGE_CONFIG ?? env.PETROGLYPHS_AUTO_REPLY_CONFIG;
  if (!path) return;
  try {
    if (!isAbsolute(path)) throw new Error();
    return settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch { throw new Error('Invalid paired bridge configuration. Check the private configuration file.'); }
}
