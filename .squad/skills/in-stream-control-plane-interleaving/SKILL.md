# Skill: In-Stream Interleaving for Control-Plane Messages

**Trigger:** You have an established ordered byte-stream protocol (JSON-Lines, pipe, WebSocket)
carrying a data-plane flow (e.g., streaming chunks), and you need to add control-plane
messages (e.g., permission prompts, pause/resume, mid-stream redirects) without introducing
a second channel.

---

## Problem

Adding a second channel for control-plane messages introduces:
- Independent reconnect cycles → doubled resilience complexity
- Loss of ordering guarantee between data and control planes (control message for event N
  may arrive after data message N+1 if the channels race)
- Extra security surface, pipe management, and test infrastructure

---

## Solution: Discriminated Type Dispatch on the Same Channel

Interleave control-plane messages with data-plane messages as first-class discriminated types:

```typescript
// Extend the existing message union — don't add a new channel
type InboundMessage =
  | StreamMessage            // data plane (existing)
  | StreamErrorMessage       // data plane (existing)
  | PermissionRequestMessage // control plane (new)
  | PermissionCancelledMessage; // control plane (new)

type OutboundMessage =
  | InjectMessage            // data plane (existing)
  | PermissionResponseMessage; // control plane (new)
```

**Dispatch in the existing handler — no new router:**
```typescript
switch (msg.type) {
  case 'stream':              return this.handleStream(conn, msg);
  case 'permission.request':  return this.handlePermissionRequest(conn, msg);
  case 'permission.cancelled': return this.handlePermissionCancelled(conn, msg);
  // ...
}
```

---

## Why Ordering Is Preserved

For a single ordered byte stream (TCP, named pipe, Unix socket):
- All messages, regardless of type, arrive in the order they were written
- `permission.request` for tool N is guaranteed to arrive **before** stream output
  from tool N (because the sender's callback fires before execution begins)
- No out-of-order delivery between data and control planes

This guarantee is lost if you introduce a second channel — even two TCP connections to the same server can reorder relative to each other.

---

## Request/Response Correlation Over a Stream

Control-plane messages that require a response use an independent correlation ID
(separate from the data-plane `requestId`):

```typescript
// Control plane uses permissionId, not requestId
{ type: "permission.request", requestId: "req-1", permissionId: "perm-7a2b" }
// → response echoes permissionId only
{ type: "permission.response", permissionId: "perm-7a2b", decision: "allow" }
```

**Why separate IDs?**
- One data-plane `requestId` may trigger multiple control-plane prompts (e.g., tool A,
  then tool B in the same response)
- Control-plane correlation ID lifetime is shorter than the data-plane request lifetime
- Separation makes it obvious which layer each ID belongs to

---

## Timeout Design: Dual-Timer Pattern

When the remote side has a local timeout and the local side has a user-facing timeout:

```
Extension (remote)          Daemon (local)
   timeoutMs = 30,000 ms   user grace = 25,000 ms
```

- **Daemon timer fires first (25s):** sends `permission.response { decision: "deny" }` → extension receives it before its own timer → clean resolution
- **Extension timer fires (30s):** only reachable if `permission.response` was lost or delayed; extension sends `permission.cancelled` → daemon discards any stale state

**Rule:** Remote timer must always be ≥ (local timer + round-trip budget). This guarantees the local response beats the remote auto-fire in all non-failure cases.

---

## Disconnect Abort Invariant

Any pending control-plane Promise MUST be cancelled when the transport disconnects:

```typescript
// In BridgeSession — wire disconnect to abort controller
this.bridge.on('session.disconnected', (sId) => {
  if (sId === this.sessionId) {
    this.permissionAbortController.abort();
  }
});
```

Without this, a `PermissionPrompter.prompt()` call can remain open indefinitely after
the session it belongs to has died.

---

## When NOT to Use This Pattern

- **Truly independent channels:** If the control plane must survive data-plane failures
  independently (e.g., admin out-of-band kill switch), a separate channel is correct
- **Very high-volume data plane:** If data-plane throughput saturates the channel,
  control messages may be delayed. Not a concern for conversational AI streams.
- **Different security requirements:** If control messages need higher integrity
  guarantees than data messages, separate channels with different TLS configurations
  are appropriate

---

## Codebase Example

- ADR-9 (`noble-six-adr9-permission-prompting.md`) — `permission.request` / `permission.response`
  interleaved with `stream` on `\\.\pipe\reach-bridge`
- ADR-8 / `extensionBridge.ts` — `ping` / `pong` heartbeat interleaved with `stream` messages
  on the same pipe (existing precedent)

---

## Related Skills

- `push-to-pull-async-iterator` — adapting push events from this channel into async iterables
- `typed-eventemitter` — composition pattern for typed on/off dispatch
