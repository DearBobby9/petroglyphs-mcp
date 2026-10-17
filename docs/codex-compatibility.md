# Codex compatibility diagnostics

Desktop in this document means the Codex workspace inside `/Applications/ChatGPT.app`.

`GET /api/codex/diagnostics?hostId=…&threadId=…` requires the existing paired device URL. The response uses `Cache-Control: no-store`.
Optional `appVersion`, `appBuild`, and `appCommit` identify the calling App. `appCommit` must contain 40 lowercase hexadecimal characters.

The response separates three evidence sources:

- `app` contains client-reported build information.
- `mcp`, `desktop`, and `executables` describe installed artifacts. `buildCommit` is the deployment stamp from `PETROGLYPHS_BUILD_COMMIT`. A missing stamp remains null. `sourceCommit` and `sourceDirty` describe the source checkout when the reader first inspected that artifact set. They do not identify running compiled code.
- `host.probe` reports a fresh settings/history read for the requested host and thread. `host.modelCatalog` identifies that host's catalogue source and freshness. Unconfigured remote catalogues remain unavailable.

`compatibility.state=baseline_match` means the installed Desktop artifact matches the inspected baseline. It does not prove the running process loaded that artifact. Each IPC operation still validates its method version and receipt. `host.execution` remains `not_tested`; a diagnostic read never sends, stops, answers, or approves a turn.

The response omits raw snapshots, prompts, model instructions, account data, native error text, and pairing URLs. Home-directory paths use `~`. All executable entries include the configured path, resolved path, and actual `--version` result. `resolvedPath` resolves filesystem symlinks only. If that entry is a wrapper script, the field still names the wrapper and does not identify its final embedded binary. The native creation, model catalogue, configured CLI, and Desktop bundled CLI can differ.

## Inspected baseline

On 2026-10-17 UTC, the installed Desktop was `26.1013.40934`, build `20770`. Its bundled CLI reported `0.163.0-alpha.10.2`. The configured Homebrew CLI reported `0.161.0`.

The Desktop archive SHA-256 was `5ddc4e48259aa6f979e04529b1a5a4ae54b0f5c4ad6db5c6e004924c10916ddb`.
The archive member `.vite/build/src-DsLVGakC.js` declares stream version 11, settings/history version 1, start-turn version 2, and interrupt-turn version 4. Host-routed follower requests add one to the base method version.

The bundled CLI's generated schema includes `turn/interrupt`, command/file/permission approvals, and user input. Those public schema entries do not establish access through an existing Desktop session.
The installed private handler has separate contracts. In particular, interrupt version 4 checks `expectedTurnId` and returns `interruptedTurnId`. Input and approval handlers return `{ok:true}` even when the request no longer exists. Execution controls must use that distinction.

## Local read-only probe

Run from the repository with its installed dependencies:

```sh
node --import tsx scripts/diagnose-codex.mjs --codex-path /opt/homebrew/bin/codex
```

Add `--native-codex-path` or `--model-codex-path` when the service uses overrides. Add both `--host-id` and `--thread-id` to verify one existing chat's settings and history. The script opens its own IPC client and closes it after the read. It does not modify pairing, start turns, create chats, or change approval policy.

`tests/fixtures/diagnostic-outcomes.json` contains sanitized synthetic samples for normal operation, disconnect, unknown delivery, missing owner/takeover, and protocol mismatch. They support deterministic regression tests. They are not device acceptance records.

Unknown delivery remains unknown. Neither diagnostics nor a protocol error authorizes replay. An incompatible stream version reports `protocol_mismatch`, so the client can distinguish incompatibility from an offline host.

## Official create_thread empty-prompt check

The same installed archive's `webview/assets/execution-11111e21e1a0.js` contains the actual tool executor `gp`. It validates arguments with `Rp.safeParse` before calling the creation path. That runtime schema defines `prompt:A().min(1)`. Therefore `prompt:""` fails before creating a chat.

The public tool schema in `webview/assets/app-initial-90eb42395b7d.js` describes prompt as a string without a minimum length. The runtime validation is stricter. The internal UI also has a `startWithoutFirstTurn` path, but the public `create_thread` arguments do not expose that option.

This evidence rules out the proposed empty-string call to the installed official tool. It does not rule out every future or authorized remote creation interface. No empty chat, whitespace placeholder, or new turn was created for this inspection.
