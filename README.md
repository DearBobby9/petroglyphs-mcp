# petroglyphs-mcp

MCP server that bridges iPad handwriting input with LLMs. Captures handwriting as PNG images and exposes them via [Model Context Protocol](https://modelcontextprotocol.io) tools and resources.

## Quick Start (Claude Desktop + iPad)

**Prerequisites:** [Node.js](https://nodejs.org) 24 or later and [Claude Desktop](https://claude.ai/download) for this MCP setup.

The paired Codex workflow uses Codex inside **ChatGPT Desktop**. It does not require a separate Codex application. Its configuration is described below.

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "petroglyphs": {
      "command": "npx",
      "args": ["-y", "petroglyphs-mcp", "--port", "3333"]
    }
  }
}
```

Restart Claude Desktop — it starts the MCP server automatically with both stdio (for Claude) and HTTP (for the iPad) on port 3333.

> **Note:** Do not run `npx petroglyphs-mcp --port 3333` separately if Claude Desktop is already running — the port will conflict. Claude Desktop manages the server for you.

### Connect the iPad

1. Make sure your iPad and computer are on the **same Wi-Fi network**
2. Find your computer's local IP:
   - **Mac:** System Settings → Wi-Fi → Details → IP Address
   - **Windows:** `ipconfig` in terminal, look for IPv4 under your Wi-Fi adapter
   - **Linux:** `hostname -I` or `ip addr`
3. Open the Petroglyphs iPad app → Server → enter `http://<your-ip>:3333`
4. The connection dot turns green when connected

### Claude Desktop only (no iPad)

If you just want stdio mode without HTTP:

```json
{
  "mcpServers": {
    "petroglyphs": {
      "command": "npx",
      "args": ["-y", "petroglyphs-mcp"]
    }
  }
}
```

### HTTP only (standalone, without Claude Desktop)

```bash
npx -y petroglyphs-mcp --port 3333
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3333` | HTTP server port |
| `--vault-path` | — | Path to Obsidian vault (enables `save_to_obsidian` tool) |
| `--export-path` | `~/Desktop` | Output directory for Excalidraw exports |
| `--max-history` | `50` | Max submissions kept in memory |

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_handwriting` | Returns the latest handwriting image (base64 PNG) with metadata |
| `get_handwriting_history` | Returns the last N submissions with metadata |
| `save_to_obsidian` | Saves content as markdown to an Obsidian vault |
| `export_to_excalidraw` | Exports strokes as an Excalidraw file |
| `clear_history` | Clears all submissions from memory |

## HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/submit` | POST | Submit handwriting image + metadata |
| `/mcp` | POST | MCP Streamable HTTP transport (unpaired installations only) |
| `/device/<token>/mcp` | POST | MCP transport for paired installations |

### Paired Codex chat controls

The paired device API supports Codex conversations and project chat creation through ChatGPT Desktop. These routes require the private device URL and an enabled Codex connection.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/codex/models?hostId=…` | GET | Available models and reasoning levels from the selected machine |
| `/api/codex/model-settings?hostId=…&threadId=…` | GET | The selected chat's current model settings |
| `/api/codex/messages` | POST | Send text and images to a fixed chat |
| `/api/codex/chats` | POST | Create a saved-project chat with its first message; native local creation also accepts images |
| `/api/codex/chats/:id/retry` | POST | Retry one verified companion approval timeout for the same creation request |
| `/api/codex/messages/:id/release-wait?hostId=…&threadId=…` | POST | Release an uncertain request's local queue wait without resending |
| `/api/codex/messages/:id/cancel?hostId=…&threadId=…` | POST | Cancel a message that remains pending before dispatch |
| `/api/codex/diagnostics?hostId=…&threadId=…` | GET | Runtime versions, protocol baseline and actual host read results |
| `/api/codex/controls?hostId=…&threadId=…` | GET | Target execution controls and known pending interaction kinds |
| `/api/codex/controls/stop` | POST | Stop the explicitly named host, chat and turn when its capability is verified |

Message and creation requests accept an optional `selection: {model, reasoningEffort}`. The bridge validates it against that machine's model catalogue and saves it with the request. Changing the draft does not change queued messages. Reusing a request ID with different content or configuration returns a conflict. Without `selection`, existing chat settings or machine defaults apply.

New local chats use the bundled Codex CLI's native `thread/start` interface without an assistant creation turn. The bridge saves the real thread ID and uses `thread/name/set` even for untitled requests to persist the thread. After closing the creating client, a fresh native connection must read the same thread and verify its project, working directory and any returned roots before the bridge opens `codex://threads/<id>` once. This official URI can show or focus the Mac's Codex window. After Desktop takes ownership, the bridge sends the first message through its existing Desktop connection. Normal project permissions remain inherited. An uncertain naming or read-verification result blocks handoff; recovery only reads existing evidence and never automatically creates or sends again.

Local creation uses `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` by default. Set `PETROGLYPHS_NATIVE_CODEX_PATH` to an absolute bundled CLI path when that location differs. The selected Desktop project must have valid local roots and an unambiguous native identity. The bridge validates its explicit ID aliases and every root through `project/list` and `project/read`. Project lists supplement missing Desktop membership with native `thread/list` results for that exact project. Directory equality never establishes membership.

For a local request without `selection`, the bridge saves the effective model and effort returned by `thread/start`. It reapplies these settings to the first Desktop message because Desktop can load different defaults. A null effort remains unset. Remote creation and previously admitted companion requests continue through the configured `PETROGLYPHS_CODEX_CREATOR_THREAD_ID` companion.

Receipts distinguish requested `selection` from `modelEvidence` observed in the matching native turn. `modelVerification` is `pending`, `confirmed`, `different`, or `unverified`. A native model reroute is reported without sending the message again. Chat creation confirmation does not mean its first response has finished.

Creation receipts include `creationMethod`, `attemptId`, `attemptNumber`, and `canRetry`. A known created thread remains available when its first message has `firstMessageState: "not_sent"` or `"unknown"`. Native stage receipts are saved under the configured data directory's `project-chats/native` folder. Status reads recover matching message evidence without creating, opening, or sending again. An interrupted native creation never replays `thread/start`.

Native first-message attachments use the same `{id,name,mimeType,dataBase64}` objects as conversation messages. Limits are four PNG/JPEG images, 10 MiB per image and 24 MiB total. The creation request saves their fixed bytes. `firstMessageRequestId` identifies their conversation receipt. `firstTurnId` and `firstMessageId` identify observed native history when available. Uncertain first sends join the durable conversation queue without a second dispatch. A definitely unsent first message stays available for draft recovery.

Project entries expose `supportsFirstMessageAttachments`. It is true only for native local creation. The remote companion's official `create_thread` interface has no image argument. Its installed executor also rejects an empty prompt before creation, so an empty-chat workaround cannot preserve one complete first message. A direct bridge on another Mac would use that Mac's local native route and its own pairing identity. That deployment requires separate runtime validation.

Messages have a durable admission sequence. Legacy receipts without a sequence retain a stable timestamp/ID order because their original same-millisecond order cannot be recovered. An uncertain request remains `unknown` after queue release and retains `waitReleasedAt` across restarts. Late results still update its original ID. Only `pending` requests can become `cancelled`.

A companion retry requires `{hostId, projectId, attemptId}` matching the receipt. It preserves the original request ID, first message, title, and model settings. The bridge permits one retry only when native approval records prove that the previous creation call timed out before execution. The complete project catalogue must also contain no creation candidate. It rechecks that evidence before dispatch and submits through the same official approval path. Repeated retry submissions return the existing attempt. Uncertain execution outcomes remain read-only and cannot be replayed. Native creation does not use this companion retry mechanism.

Remote messages, images and replies use Codex Remote Connection. The current external Desktop interface does not expose its remote model catalogue. A separate [read-only Tailscale model agent](docs/model-catalog-agent.md) supplies that metadata. It does not send messages or run inference. Unavailable catalogues disable explicit model selection instead of substituting another machine's models.

### Paired bridge startup

Set `PETROGLYPHS_BRIDGE_CONFIG` to a private JSON configuration file:

```json
{
  "deviceToken": "YOUR_EXISTING_32_OR_MORE_HEX_CHARACTER_TOKEN",
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "dataDir": "/absolute/private/bridge-data"
}
```

`PETROGLYPHS_AUTO_REPLY_CONFIG` remains a compatible alias. Reuse the existing token and data directory when upgrading. The token determines bridge identity independently of its network address. Set `PETROGLYPHS_CODEX_DESKTOP=1` to enable conversation services. `PETROGLYPHS_NATIVE_CODEX_PATH` and `PETROGLYPHS_MODEL_CODEX_PATH` override their executable paths when required.

The private Desktop adapter connects to `$CODEX_HOME/ipc/ipc.sock`, or `~/.codex/ipc/ipc.sock` by default. It discovers the owner of the requested host and thread. A different socket name or a missing separate application does not establish that integrated Codex is unavailable. Read [compatibility diagnostics](docs/codex-compatibility.md) for evidence boundaries.

The startup layer owns pairing and the chat directory. Legacy `/api/submit` recovery uses its original files and worker. A legacy recovery error disables those compatibility operations without disabling paired conversation routes. `PETROGLYPHS_LEGACY_SUBMISSIONS=0` explicitly disables that worker while preserving its files. This option does not cancel existing Codex execution.

Legacy pending recovery starts only after all HTTP listeners are ready. Failed startup or server shutdown prevents new legacy queue admissions immediately, including while active HTTP requests are draining. An already admitted CLI call may finish and save its original receipt; shutdown does not cancel its Codex execution or replay an unknown outcome. Undispatched pending receipts stay available for a later successful start.

## Source and verification

Production TypeScript lives in `src/`. `npm run build` writes `dist/`; generated output is not a second source tree. Tests in `tests/*.mjs` use either source modules through `tsx` or the freshly built distribution. Run the complete maintained suite with:

```sh
npm ci
npm test
```

CI uses the same command on Node 24. Tests create temporary local fixtures and servers. A sandbox must permit loopback listeners and test child processes. No test requires an iPad, a real model turn, or deployment credentials.

Runtime and device validation remain separate. See [execution controls](docs/execution-controls.md) and [history polling measurements](docs/history-performance.md). The dated document in `docs/research/` records an earlier inspection, not the current compatibility baseline.

## iPad App

The companion iPad app lives at [petroglyphs-app](https://github.com/surfndev/petroglyphs-app).

## License

MIT

When a device pairing configuration is present, HTTP MCP clients must use the same `/device/<token>/mcp` pairing prefix as the app API. Unauthenticated `/mcp` requests are rejected. Stdio clients are unaffected. Exports must remain inside the configured vault/export directory; symbolic-link subdirectories and file targets are rejected.
