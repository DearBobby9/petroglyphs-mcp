# Codex projects and new chats

Project browsing is implemented for paired local and Remote Connection hosts. Creation uses a dedicated, user-authorized local Codex companion chat. That chat invokes official `create_thread` in the running Desktop app. The backend independently verifies the resulting chat before exposing it to the iPad. Without a configured companion, projects remain readable and `canCreate` is false.

## Project browsing

All paths below use the existing `/device/TOKEN` paired base URL. Public requests return `403`.

`GET /api/codex/projects?hostId=local`

```typescript
interface ProjectPage {
  hostId: string;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    canCreate: boolean;
    reason?: string;
  }>;
}
```

Projects come from Desktop's saved `local-projects` and `remote-projects` definitions. They are not inferred from thread working directories. Remote entries remain bound to their saved host. Disabled/unindexed connections cannot be used. `canCreate` means the configured companion is readable for an attempt; it does not promise model or remote network availability.

The official `list_projects` tool omits a project when its Git metadata query rejects or times out. Thus the saved-project directory can include more entries than one invocation of that tool. During inspection, the saved directory contained 90 local and 12 remote definitions; one official tool invocation returned 90 local and 10 remote projects. The Mac mini's four project definitions matched. This API preserves saved definitions instead of treating a failed Git check as project deletion.

`GET /api/codex/threads?hostId=...&projectId=...&search=...&cursor=...`

The existing thread page shape is unchanged: `{threads:[{id,title,cwd,updatedAt}],nextCursor}`. Omit `projectId` to retain the existing All chats behavior. Project pages use explicit Desktop `thread-project-assignments`, membership host identities, and native `project_id`/legacy-to-server-ID mappings. Explicit reassignment or projectless membership overrides an older server assignment. Matching `cwd` alone never assigns a thread to a project. Cursors bind host, project and search. Incomplete catalogs return a temporary error rather than an apparently empty project.

## Create and send the first message

The installed official `create_thread` implementation requires a non-empty first prompt. It does not expose a project-bound, empty-chat operation. The UI must say **Start chat**, require a first message, and explain that the button creates the chat and sends that message. No placeholder prompt is inserted.

`POST /api/codex/chats`

```json
{
  "id": "44b6e0d0-a6be-47d9-9977-83124b4e43e3",
  "hostId": "local",
  "projectId": "a6f715ae-b5fe-4d36-9a3f-c6c8aac135c5",
  "prompt": "The user's first message",
  "title": "Optional chat title"
}
```

`id` is a lowercase UUID. `prompt` must contain non-whitespace text and allows 20,000 UTF-16 code units. Optional `title` is trimmed, non-empty, and limited to 120 UTF-16 code units. Only the documented fields are accepted. The iPad cannot specify a path, tool, model, caller thread or worktree.

The server validates that `projectId` is saved under the selected host. It durably saves the request fingerprint and target. A new admission returns `202`; the same ID and content return `200` with the existing receipt. Different content or target with an existing ID returns `409`, code `id_conflict`.

`GET /api/codex/chats/:id?hostId=...&projectId=...`

```typescript
interface ProjectChatReceipt {
  id: string;
  hostId: string;
  projectId: string;
  state: "pending" | "creating" | "completed" | "failed" | "unknown";
  createdAt: string;
  updatedAt: string;
  thread?: { id: string; title: string; cwd: string; updatedAt: number };
  error?: string;
  notice?: string;
}
```

`pending` is saved but not dispatched. `creating` marks the helper's native turn submission boundary. After 20 seconds without confirmation it becomes `unknown`, while a read-only observer continues for up to 180 seconds. A late verified result updates the same receipt. GET can recover a later result after the observer ends or the service restarts. Neither a timeout nor a restart replays a possibly written request. A service restart resumes only undispatched `pending` requests. A definitely not-sent busy response returns to `pending`. Only one helper request is dispatched at a time.

`completed` contains a verified thread ID and lets the UI select the chat. It confirms creation, not completion of the model's answer. Continue with the existing conversation API. If the first native turn exists and matches the prompt but its response failed, the receipt is still `completed` with a notice. If the first input cannot be independently verified, creation remains `unknown`.

`failed` is used only for a known preflight failure before calling the native creation tool. The UI can offer an explicit edit and new request ID. Once a creation call may have been written, failures are `unknown`. GET remains safe. A `404` confirms that this ID has not been admitted for the exact selected host/project. The UI can then offer an explicit same-ID retry. Never automatically replay unknown requests or guess a resulting chat by matching title or prompt text.

## Companion setup and verification

Create the dedicated local companion only after the user authorizes that setup. Use the exact bootstrap text in [`docs/project-creator-bootstrap.txt`](docs/project-creator-bootstrap.txt). Its setup reply is `READY`; setup does not create another chat. Configure its actual thread ID on the existing paired service:

```text
PETROGLYPHS_CODEX_DESKTOP=1
PETROGLYPHS_CODEX_CREATOR_THREAD_ID=<authorized local companion UUID>
```

The helper ID is fixed service configuration. An iPad request cannot override it. Each durable receipt also records the helper used, so recovery after a configuration change only reads the original helper. Pending requests never silently move to a different companion. The IPC connection reconnects to the running Desktop process; the service does not restart Desktop or launch a replacement app-server.

The backend writes an immutable `0400` request JSON file under private `dataDir/project-chats/requests/<UUID>.json`. It checks the file's exact content and mode before dispatch. The helper message contains `PETROGLYPHS_CREATE_PROJECT_CHAT_V1`, the request UUID, host, project, and fixed file path. It also includes a generated `functions.exec` script. That script reads only the quoted fixed file with `exec_command`/`cat`, parses JSON, checks identities, and passes the parsed request fields directly to official `create_thread`. The model does not need to retype the user's prompt. Failed reads, truncation or invalid JSON stop before creation.

The bridge sets the helper turn's native `clientUserMessageId` to the request UUID. The helper first checks `list_projects`, then runs the supplied script at most once. Creation uses:

```json
{
  "name": "create_thread",
  "arguments": {
    "prompt": "User input",
    "target": {
      "type": "project",
      "projectId": "validated saved ID",
      "environment": {"type":"local"}
    }
  }
}
```

The official tool resolves the saved project's actual local or remote host and uses its existing checkout. The companion forwards the exact prompt and optional title as data. It must not execute the prompt itself, choose another project, create a worktree, or retry an unconfirmed tool call.

The final response contains one strict JSON object, optionally in a `json` code block. A created result requires the same thread ID in the app's `created-thread` directive:

```text
{"requestId":"request UUID","hostId":"selected host","projectId":"selected project","status":"created","threadId":"real thread UUID"}
::created-thread{threadId="real thread UUID"}
```

An unconfirmed result is `{"requestId":"...","hostId":"...","projectId":"...","status":"unknown"}` without a directive. No extra prose, extra JSON objects, conflicting directives, or `clientThreadId` substitutions are accepted. A final response is a candidate, not evidence of creation by itself. The backend requires all of the following:

1. One helper turn with the exact native request UUID and exact instruction envelope. A merged turn with additional user messages remains unknown.
2. Matching request, host, project, and final directive. Multiple directly visible `create_thread` calls or mismatched arguments remain unknown.
3. A real, visible Desktop catalog entry under the requested host and explicit project membership. Its `source_created_at` must be at or after the admitted second.
4. Complete native history whose first input equals the original prompt, either as user text or the exact official `codex_delegation`/`toolOutput` encoding from this helper.
5. Exactly one matching recent project chat. More than 50 candidates, unavailable evidence, or multiple matching first prompts cannot produce success. The verifier does not select a chat by title or guess when evidence conflicts.

The public conversation uses the completed receipt's verified thread and turn IDs to display the original first prompt as a right-side user message. It replaces the known delegated user wrapper or inserts a stable message for native `toolOutput`. Unrelated tool outputs remain private.

Receipts live under the existing private `dataDir/project-chats` directory. Pending targets and immutable request files are checked again immediately before dispatch. Native errors, socket paths, request-file paths and helper instructions do not appear in HTTP receipts. Ordinary message and project-prompt admission both limit text to 20,000 code units.

## Costs and boundaries

Every creation adds a model turn in the helper, so it adds latency and model usage. The first prompt is stored in the private request file, is available to the helper's tool call, and is sent to the target chat. The helper's model must follow the limited creation instruction; code cannot guarantee that a model calls a tool exactly once. The bridge never replays a possibly submitted request and detects duplicate visible candidates before selecting a result. It cannot undo an extra native chat that the model created, or prove that the model made no unrelated action. Unknown outcomes therefore require checking project chats, not pressing Start chat again blindly.

The production path uses only the existing Desktop thread-follower IPC plus the official tools inside the authorized helper. An independently launched, unmodified official MCP server was investigated: stdio initialization succeeded, but native `tools/list` closed the app-tools pipe. No creation was attempted through it. That unsupported standalone adapter and its runtime settings were removed. No custom pipe authentication or URL workaround is used.

## Verification and remaining gate

`npm run build` checks types. `node --import tsx --test tests/projects.mjs tests/companion-creator.mjs tests/conversations.mjs` uses temporary SQLite directories, native-boundary fixtures and loopback HTTP only. It covers explicit membership and cursor scope; host/project and helper binding; concurrent UUID admission; late/restart reconciliation; busy queueing; wrong, stale or duplicate creation candidates; native delegated input; safe first-message projection; and paired authorization.

No real companion bootstrap, project creation, or first prompt was sent during backend implementation. The two official first-input encodings are source-backed fixtures. An explicitly authorized bootstrap and iPad Start chat test must verify the installed app's runtime schema before claiming device success.
