# Paired Codex conversation API

This API requires `PETROGLYPHS_CODEX_DESKTOP=1`, an active Codex Desktop app, and the existing paired configuration. Local and enabled Remote Connection targets use the same native Desktop IPC. Unavailable targets return an error; messages never move to another host or chat. Existing `/api/submit` and submission receipt endpoints remain available.

Use the existing paired base URL, ending in `/device/TOKEN`, for every endpoint below. Public URLs return `403`. Do not log the token. Responses use `Cache-Control: no-store`.

## Message input

`POST /api/codex/messages`

```json
{
  "id": "028d72a9-c845-4bb5-a206-23ba7ad618cb",
  "hostId": "local",
  "threadId": "00000000-0000-7000-8000-000000000003",
  "text": "Compare these drawings.",
  "attachments": [
    {
      "id": "a92b334f-bfcb-4ecf-aa8a-239929183f33",
      "name": "Drawing.png",
      "mimeType": "image/png",
      "dataBase64": "..."
    }
  ]
}
```

UUIDs use lowercase. `hostId` is `local` or an enabled `remote-control:env_...` connection. Text allows 20,000 UTF-16 code units. Empty text requires an image. Up to four PNG or JPEG attachments are accepted, at most 10 MiB each and 24 MiB decoded in total. Attachment IDs must be unique within a message. Base64 excludes the data URL prefix. File names cannot contain path separators or control characters. Unsupported fields are rejected.

The first accepted request returns `202` with a `MessageReceipt`. The service persists the fixed target, text, image bytes and content fingerprint before returning. The same ID with the same body returns `200` with the existing receipt. Reusing the ID for different content or a different target returns `409`, code `id_conflict`.

`GET /api/codex/messages/:id?hostId=...&threadId=...` returns that receipt. A `404` means the ID has not been accepted for this exact target. After a network timeout, reconcile with this GET. Never automatically create another ID or resubmit an unknown delivery. A user can explicitly retry the same original request after a confirmed `404`.

The queue waits for the current response before starting another turn. It inherits the selected thread's model and settings. It does not replace Desktop's queue, steer a running turn, or implement Stop. Text enters Codex unchanged. Image-only messages contain only the image inputs. There is no visible tracking marker. Native `clientUserMessageId` and returned `userMessage.clientId` associate the original request.

## Receipt and message shapes

```typescript
type State = "pending" | "dispatching" | "queued" | "running"
  | "completed" | "failed" | "unknown";

interface MessageReceipt {
  id: string; hostId: string; threadId: string;
  createdAt: string; updatedAt: string; // ISO 8601, including milliseconds
  state: State;
  turnId?: string;
  message: ConversationMessage;
  error?: string;
  notice?: string;
}

interface ConversationMessage {
  id: string;
  turnId?: string;
  clientMessageId?: string;
  role: "user" | "assistant";
  text: string;
  phase: "user" | "commentary" | "final_answer" | "unknown";
  createdAt: string | null;
  state: State;
  attachments: ConversationAttachment[];
}

interface ConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  availability: "available" | "unavailable";
  byteCount?: number;
  assetPath?: string;
}
```

Pending user messages use `id: "client:<UUID>"`. When native history confirms the input, `id` becomes a stable hash of the native turn and message IDs. Merge optimistic messages by `clientMessageId`, not by text. Different user messages can have identical text. A receipt's `message` always carries that client ID.

`pending` means saved and waiting. `dispatching` means the native mutation boundary has been entered. `queued` confirms native admission. `unknown` means the service must reconcile the original request without replaying it. A service restart changes an in-flight dispatch to `unknown`, while undispatched pending work resumes. `failed` is terminal for this ID; it can mean a rejected send or a failed native turn. The UI can let the user compose a new message, but must not promise that reusing the failed ID executes again.

## Conversation history

`GET /api/codex/conversation?hostId=...&threadId=...&limit=50&before=...`

`hostId` and `threadId` are required. `limit` defaults to 50 and permits 1–100. Omit `before` for the newest page. Supply `beforeCursor` to fetch older messages. Every page is chronological, oldest first.

```typescript
interface ConversationPage {
  hostId: string;
  threadId: string;
  messages: ConversationMessage[];
  beforeCursor: string | null;
  runState: "idle" | "running" | "waiting" | "unknown";
  receipts: MessageReceipt[];
  updatedAt: string;
}
```

Receipts include outstanding messages and the latest 50 saved messages for this target. Pending/failed inputs not yet in native history appear as user messages, so they remain visible after an iPad restart. Cursors are target-bound. A stale cursor returns `409`, code `stale_cursor`; refresh the newest page without submitting anything.

Only public `userMessage` content and `agentMessage` commentary/final text are projected. Tools, reasoning, plans, private Desktop state, memory metadata and diagnostics are omitted. Native history retains the complete public reply text. `createdAt` uses `turnStartedAtMs` when item timestamps are unavailable. Legacy drawing wrappers become image messages. Other user text remains unchanged.

`runState: waiting` indicates Desktop reports a request needing attention. Unknown or interrupted native statuses retain the reply text and remain `unknown`; they are not presented as a failed response. Use a three-second foreground poll and back off on errors. Requests for the same in-flight snapshot are coalesced. Do not interpret a catalog entry or HTTP admission receipt as successful delivery or completion.

## Images

An available attachment has an `assetPath`, for example:

```text
/api/codex/assets/<sha256>?hostId=local&threadId=<UUID>
```

Append this relative API path to the paired base URL while preserving `/device/TOKEN`. Do not resolve a leading slash against the host root. Accept only same-service `/api/codex/assets/` paths. The endpoint checks the exact host/thread scope, returns raw PNG/JPEG bytes with `nosniff`, and has no arbitrary file-path or URL-fetch parameter.

New attachment bytes and receipts survive restarts under `dataDir/conversations`. Embedded PNG/JPEG data URLs from native history become cached paired assets. The service also recovers known legacy drawing PNGs from its own configured receipt directory, after checking the saved target. It never reads a path supplied in a Desktop message and never downloads an attachment URL. Unrecoverable history images have `availability: unavailable` and no `assetPath`; show an explicit image placeholder.

The HTTP body ceiling is 50 MiB. Application validation enforces the smaller decoded image limits. Native IPC explicitly uses its existing 256 MiB frame ceiling for accumulated Desktop history. HTTP conversation responses contain paginated message projections and image references, not the raw snapshot or inline base64.

## Errors and verification

Errors are `{ "error": "safe user-facing text", "code": "stable_category" }`. Common categories include `pairing_required`, `desktop_unavailable`, `invalid_message`, `invalid_image`, `attachments_too_large`, `id_conflict`, `message_not_found`, `asset_not_found`, `invalid_target`, `invalid_cursor`, `stale_cursor`, `queue_full`, and `conversation_unavailable`. Native/private diagnostics and configuration paths do not cross the API boundary.

Run `npm run build`, then `node --import tsx --test tests/conversations.mjs tests/desktop-ipc.mjs`. The tests use isolated temporary stores, Unix sockets and a loopback HTTP server. They do not send anything to real Codex chats. Existing routing tests remain relevant when changing HTTP middleware or Desktop initialization.
