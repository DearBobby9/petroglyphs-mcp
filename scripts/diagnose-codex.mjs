import { parseArgs } from 'node:util';
import { CodexDiagnostics, runtimeDiagnosticsReader } from '../src/codex-diagnostics.ts';
import { CodexDesktopIpc } from '../src/codex-desktop-ipc.ts';
import { CodexModelCatalog } from '../src/codex-model-catalog.ts';
import { isCodexHost } from '../src/codex-message-input.ts';
import { isThreadId } from '../src/codex-threads.ts';

const { values } = parseArgs({ options: {
  'codex-path': { type: 'string' }, 'native-codex-path': { type: 'string' }, 'model-codex-path': { type: 'string' },
  'host-id': { type: 'string' }, 'thread-id': { type: 'string' },
} });
if (!values['codex-path'] || !values['codex-path'].startsWith('/')) {
  throw new Error('Provide the configured absolute --codex-path. This probe never guesses the active CLI.');
}
const hostId = values['host-id'], threadId = values['thread-id'];
if ((hostId !== undefined || threadId !== undefined) && (!isCodexHost(hostId) || !isThreadId(threadId))) {
  throw new Error('Provide both --host-id and --thread-id for one read-only host probe.');
}
const runtime = runtimeDiagnosticsReader({ codexPath: values['codex-path'], nativeCodexPath: values['native-codex-path'],
  modelCodexPath: values['model-codex-path'], buildCommit: process.env.PETROGLYPHS_BUILD_COMMIT });
if (!hostId) console.log(JSON.stringify(await runtime(), null, 2));
else {
  const service = new CodexDiagnostics({ runtime, requireTarget: async () => {},
    connect: () => CodexDesktopIpc.connect({ timeoutMs: 5000, maxFrameBytes: 256 * 1024 * 1024 }),
    catalog: await CodexModelCatalog.fromEnvironment({ codexPath: values['model-codex-path'] ?? values['codex-path'] }),
  });
  console.log(JSON.stringify(await service.read({ hostId, threadId }), null, 2));
}
