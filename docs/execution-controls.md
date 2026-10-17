# Execution controls

These routes require the existing paired device URL. Responses use `Cache-Control: no-store`.

`GET /api/codex/controls?hostId=…&threadId=…` reads the current Desktop snapshot. The response contains:

```json
{
  "hostId": "local",
  "threadId": "00000000-0000-7000-8000-000000000001",
  "observedAt": "2026-10-17T03:30:00.000Z",
  "activeTurnId": "00000000-0000-7000-8000-000000000002",
  "capabilities": {
    "stop": { "supported": true, "handlingLocation": "ipad" },
    "answer": { "supported": false, "reason": "no_authoritative_receipt", "handlingLocation": "desktop" },
    "approve": { "supported": false, "reason": "no_authoritative_receipt", "handlingLocation": "desktop" }
  },
  "pendingInteractions": [
    { "kind": "input", "turnId": "00000000-0000-7000-8000-000000000002", "handlingLocation": "desktop", "reason": "no_authoritative_receipt" }
  ]
}
```

This example uses synthetic identities. `activeTurnId` is null when no single running turn is known. Stop capability can report `no_active_turn`, `ambiguous_active_turn`, `unsupported_desktop_version`, or `capability_unverified`. Snapshot or connection failures return a failure response rather than fabricated idle state.

Stop is enabled only for a local host whose current owner completes the v4 capability check. The installed binary's method table does not establish a remote host's capability. Remote controls currently report `capability_unverified`, and remote stop POSTs are rejected before any interrupt request.

For a local active turn on the inspected ChatGPT Desktop baseline, this GET performs a bounded no-op interrupt negotiation. It fixes the snapshot's owner, sends a newly generated UUID absent from that chat as `expectedTurnId`, and uses `mode=system`. The inspected v4 implementation returns null before turn interruption or cleanup when the expected ID does not match. Only an `ok:true`, `interruptedTurnId:null` response from that same owner enables stop. An incompatible owner, changed owner, timeout, or malformed response leaves capability unverified. This check invokes the interrupt method with an invalid target; it is not a discovery-only IPC call.

`pendingInteractions` exposes only the request kind (`input`, `approval`, or `other`), turn identity, and handling location. It omits native commands, questions, paths, request IDs, and credentials. Each read uses a fresh snapshot. Interactions handled in Desktop therefore disappear from subsequent responses.

## Stop one turn

`POST /api/codex/controls/stop` accepts exactly:

```json
{
  "hostId": "local",
  "threadId": "00000000-0000-7000-8000-000000000001",
  "turnId": "00000000-0000-7000-8000-000000000002"
}
```

The bridge checks the host/thread target and installed compatibility baseline. It reloads the local owner and repeats the no-op v4 negotiation with that owner before sending the real request. It sends `thread-follower-interrupt-turn` version 4, plus the host-routing version offset. The request includes `conversationId`, `expectedTurnId`, and `mode=user-stop`. It never substitutes the current turn for the requested turn. Both negotiation and final receipt must come from the chosen owner.

The installed Desktop handler checks `expectedTurnId` before interrupting. Its error recovery also refuses to replace that target with another active turn. A confirmed response includes either the exact `interruptedTurnId` or null. The bridge reports:

- `status=stopped`: Desktop confirmed the named turn interruption.
- `status=already_finished`: Desktop reported that the named turn is no longer active. This does not establish task success.
- HTTP 503, `code=control_delivery_unknown`, `outcome=unknown`: delivery occurred, but the exact interruption was not confirmed. Check the original Desktop chat. Do not automatically retry.

The response repeats `hostId`, `threadId`, and `turnId`. Concurrent identical requests share one delivery. Later repeated requests still carry the original turn ID. A stale request cannot stop a new turn.

This control stops one turn. It does not change goal state or approval policy. Desktop may clean up that turn's child work according to its existing stop behavior.

## Input and approval limits

The installed Desktop exposes follower methods for input and approval. Their version 1 handler returns `{ok:true}` even when its request lookup finds no pending request. The methods also lack an `expectedTurnId` parameter. Public app-server schemas do not repair those private handler limits.

The bridge therefore exposes those actions as unsupported and directs the user to the same Desktop chat. It does not send approval decisions, broaden permission scope, or lower approval policy. An interaction disappearing from a snapshot does not prove which device handled it.

The compatibility artifact and method evidence are recorded in [codex-compatibility.md](codex-compatibility.md). Socket tests cover target binding, delay across turns, unknown delivery, receipt mismatch, and duplicate requests. Service tests cover fresh interaction state, pairing, and unsupported versions. They do not establish a physical iPad stop or a real model-turn interruption. Those device acceptance steps remain separate.

The read-only diagnostic probe succeeded against one existing local Desktop chat at `2026-10-17T03:29:01.656Z`. It confirmed settings/history access and a local app-server model catalogue. A separate subagent chat without a Desktop owner timed out. Neither probe sent a control command.

At `2026-10-17T03:40:24.818Z`, the local owner completed the no-op v4 negotiation for that existing chat. The response matched the selected owner and reported `interruptedTurnId:null`. No real turn ID was submitted for interruption. This verifies the target's negotiation path; it does not replace real-stop or device acceptance.
