# Direct Codex Remote Connections

The Mac service can reuse the running Codex Desktop connection. The remote host does not need a new Petroglyphs HTTP service for this route.

Set these variables on the existing paired service:

```text
PETROGLYPHS_CODEX_DESKTOP=1
PETROGLYPHS_AUTO_REPLY_CONFIG=/absolute/path/to/private-auto-reply.json
PETROGLYPHS_DESKTOP_HOST_NAMES=/absolute/path/to/host-names.json
```

The host-names file is optional. It contains display metadata only:

```json
{"hosts":[{"id":"remote-control:env_example","name":"My Mac mini"}]}
```

Names do not enable connections. Desktop's saved connection preferences and completed catalog build determine selectable locations. Without a label, the location shows its environment ID prefix. No login token, device key, account record, or relay credential belongs in this file.

The implementation uses two existing Desktop surfaces:

- Read-only SQLite `local_thread_catalog` under the current `CODEX_HOME`. Desktop maintains this directory through its real remote connections. Search covers title and working directory. Archived, hidden, and cloud chats are excluded. This is a complete initial directory with subsequent Desktop updates, not an online check or a forced remote refresh.
- The current user's private `ipc/ipc.sock`. The service identifies itself as `petroglyphs`, subscribes to the selected host/chat, reads complete snapshots, and sends PNG image input to that target. It never changes Desktop authentication or launches a second remote app-server.

The current integration was developed against Desktop 26.1007.71326, build 20398, and bundled CLI 0.162.0-alpha.17.2. These IPC and catalog schemas are internal and can change. Schema or protocol failures return an unavailable state instead of selecting another host.

Direct receipts live under `dataDir/remote-desktop`. A receipt fixes hostId, threadId, submissionId, and the returned turnId. Unknown sends are reconciled against the original submission marker without replay. Reply text uses the same public-assistant filter as local replies. Complete raw conversation snapshots never leave the Mac service.

Desktop's follower handler has an internal five-second receipt timeout. Its underlying send can continue after that timeout. The service therefore keeps polling the original submission instead of reporting a failed response or sending again. The first Mac mini test exercised this path: Desktop preparation took about 77 seconds before the remote turn request, and the original submission later completed with the correct image description.

PNG input is limited to 10 MiB. The image bytes travel to the remote conversation. This route does not promise a separate user-visible PNG file at a remote filesystem path. Arbitrary file transfer is outside this canvas endpoint.

The service serializes its own drawings for each chat and waits while Desktop reports that chat as busy. The IPC start operation has no atomic idle precondition. A concurrent Desktop message can still join the same turn. The receipt remains bound to its target, and combined replies are labelled. Turn completion is tracked separately from uncertain reply attribution, so a completed shared reply does not block the next drawing.

`PETROGLYPHS_REMOTE_CONFIG` retains the authenticated helper path as backup. A request already admitted by the direct path remains there; the service does not send it again through a helper after a timeout. Existing direct receipts continue to resolve by their stored transport.

The iPad API remains unchanged. Chat location lists the enabled connections. Selecting a concrete chat changes the destination; browsing another location and cancelling preserves the previous target. Locations that are explicitly unavailable show a reason and cannot be selected for a new send.

The Mac and Codex Desktop must remain running. If a connection is unavailable, pending drawings retain their original destination. Reopen that connection in Desktop to resume. This service does not silently redirect to a local chat.
