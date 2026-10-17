# petroglyphs-mcp

MCP server that bridges iPad handwriting input with LLMs. Captures handwriting as PNG images and exposes them via [Model Context Protocol](https://modelcontextprotocol.io) tools and resources.

## Quick Start (Claude Desktop + iPad)

**Prerequisites:** [Node.js](https://nodejs.org) (v18+) and [Claude Desktop](https://claude.ai/download)

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
| `/mcp` | POST | MCP Streamable HTTP transport |

### Paired Codex chat controls

The paired device API also supports Codex conversations and project chat creation. These routes require the private device URL and an enabled Codex Desktop connection.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/codex/models?hostId=…` | GET | Available models and reasoning levels from the selected machine |
| `/api/codex/model-settings?hostId=…&threadId=…` | GET | The selected chat's current model settings |
| `/api/codex/messages` | POST | Send text and images to a fixed chat |
| `/api/codex/chats` | POST | Create a chat in a saved project with its first text message |
| `/api/codex/chats/:id/retry` | POST | Retry one verified companion approval timeout for the same creation request |

Message and creation requests accept an optional `selection: {model, reasoningEffort}`. The bridge validates it against that machine's model catalogue and saves it with the request. Changing the draft does not change queued messages. Reusing a request ID with different content or configuration returns a conflict. Without `selection`, existing chat settings or machine defaults apply.

New local chats use the bundled Codex CLI's native `thread/start` interface without an assistant creation turn. The bridge saves the real thread ID, closes its native client, and opens `codex://threads/<id>` once. This official URI can show or focus the Mac's Codex window. After Desktop takes ownership, the bridge sends the first message through its existing Desktop connection. Normal project permissions remain inherited.

Local creation uses `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` by default. Set `PETROGLYPHS_NATIVE_CODEX_PATH` to an absolute bundled CLI path when that location differs. The selected Desktop project must have valid local roots and an unambiguous native identity. The bridge validates its explicit ID aliases and every root through `project/list` and `project/read`. Project lists supplement missing Desktop membership with native `thread/list` results for that exact project. Directory equality never establishes membership.

For a local request without `selection`, the bridge saves the effective model and effort returned by `thread/start`. It reapplies these settings to the first Desktop message because Desktop can load different defaults. A null effort remains unset. Remote creation and previously admitted companion requests continue through the configured `PETROGLYPHS_CODEX_CREATOR_THREAD_ID` companion.

Receipts distinguish requested `selection` from `modelEvidence` observed in the matching native turn. `modelVerification` is `pending`, `confirmed`, `different`, or `unverified`. A native model reroute is reported without sending the message again. Chat creation confirmation does not mean its first response has finished.

Creation receipts include `creationMethod`, `attemptId`, `attemptNumber`, and `canRetry`. A known created thread remains available when its first message has `firstMessageState: "not_sent"` or `"unknown"`. Native stage receipts are saved under the configured data directory's `project-chats/native` folder. Status reads recover matching message evidence without creating, opening, or sending again. An interrupted native creation never replays `thread/start`.

A companion retry requires `{hostId, projectId, attemptId}` matching the receipt. It preserves the original request ID, first message, title, and model settings. The bridge permits one retry only when native approval records prove that the previous creation call timed out before execution. The complete project catalogue must also contain no creation candidate. It rechecks that evidence before dispatch and submits through the same official approval path. Repeated retry submissions return the existing attempt. Uncertain execution outcomes remain read-only and cannot be replayed. Native creation does not use this companion retry mechanism.

Remote messages, images and replies use Codex Remote Connection. The current external Desktop interface does not expose its remote model catalogue. A separate [read-only Tailscale model agent](docs/model-catalog-agent.md) supplies that metadata. It does not send messages or run inference. Unavailable catalogues disable explicit model selection instead of substituting another machine's models.

## iPad App

The companion iPad app lives at [petroglyphs-app](https://github.com/surfndev/petroglyphs-app).

## License

MIT
