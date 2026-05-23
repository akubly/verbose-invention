# Skill: Testing Interleaved Control-Plane Messages Over an Active Data Stream

**Owner:** Jun  
**Category:** Testing patterns  
**Applies to:** Any protocol where bidirectional control-plane messages (approve/deny, pause/resume, cancel) interleave with an active data stream over the same pipe or emitter.

---

## Problem

In a streaming protocol, most messages flow in one direction: daemon injects a command, extension streams back chunks. When you add a bidirectional control-plane channel (e.g., permission prompting), two new complexity classes emerge:

1. **Direction inversion** — the control-plane message originates from the side that normally _receives_ commands (extension initiates `permission.request`; daemon must respond).
2. **Interleave hazards** — a pending control-plane round-trip races with normal stream events: chunks can arrive before/after/during a prompt; `done: true` can race with a pending approval; pipe drops can leave a prompt orphaned.

Existing `async-iterable-adapter-testing` covers data-plane only (unidirectional chunks). This skill covers the bidirectional layer.

---

## Core Test Matrix

Every control-plane message type needs coverage across four timing dimensions:

| Timing | Description | Key assertion |
|--------|-------------|---------------|
| **Before first chunk** | Control-plane fires before any data | Iterator does not lose the control-plane message; data arrives correctly after |
| **Mid-stream** | Control-plane fires after some chunks, before done | In-flight chunks are preserved; control-plane resolves independently |
| **After done** | Control-plane fires after stream terminal | Must be silently discarded; no double-resolve, no error throw |
| **Concurrent (multiple sessions)** | Control-plane on sess-A + stream on sess-B | No head-of-line blocking; independent resolution |

---

## Fake Double Contract for Bidirectional Control

The test double for the bridge/pipe layer needs both **send** and **receive** hooks for each control-plane message:

```ts
// FakeExtensionClient additions (extension-side)
client.sendPermissionRequest(requestId, toolName, args);      // → daemon
client.permissionResponsesReceived                            // ← daemon
client.lastPermissionResponse()

// FakeDaemon additions (daemon-side)
daemon.sendPermissionResponse(sessionId, requestId, approved); // → extension
daemon.permissionRequestsReceived(sessionId)                   // ← extension
daemon.setPermissionAutoApprove(requestId, approved)           // pre-loaded auto-reply
daemon.pendingPermissionRequests()                             // requests awaiting reply
```

**Design rule:** Auto-respond modes (like `FakeExtensionClient.setPingAutoRespond()` for heartbeat)
should be available for control-plane messages to simplify happy-path tests. Disable for
adversarial tests (timeout, stale response, duplicate response).

---

## Listener Cleanup Pattern

Control-plane listeners follow the same cleanup contract as data-plane listeners
(see `async-iterable-adapter-testing`):

```ts
// Assert cleanup: on() count equals off() count for each control-plane event name
expect(bridge.offCalls.filter(c => c.event === 'permission.request')).toHaveLength(
  bridge.onCalls.filter(c => c.event === 'permission.request').length
);

// Assert same listener reference
const onRef = bridge.onCalls.find(c => c.event === 'permission.request')?.listener;
const offRef = bridge.offCalls.find(c => c.event === 'permission.request')?.listener;
expect(offRef).toBe(onRef);
```

This must hold across all termination paths: normal resolution, timeout, session abandon, pipe drop, early iterator cancellation.

---

## Timeout Testing Pattern

Control-plane timeouts are owned by either the daemon or the extension (lock in ADR).
Test pattern using fake timers:

```ts
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
// NOTE: omit setImmediate — readline breaks with it faked

// Arrange: permission.request arrives, no response sent
client.sendPermissionRequest('req-001', 'delete_file', '{"path":"/etc/passwd"}');
await new Promise<void>(r => setImmediate(r)); // let daemon receive and process

// Act: advance past timeout deadline (value from ADR-9)
vi.advanceTimersByTime(PERMISSION_TIMEOUT_MS + 1);

// Assert: daemon auto-denied, extension received response
const resp = client.lastPermissionResponse();
expect(resp?.approved).toBe(false);
// Assert: no pending listeners remain
expect(bridge.offCalls.length).toBe(bridge.onCalls.length);
```

**Critical:** Always check that the timeout is cancelled on normal resolution to avoid a stale-timer false-positive that marks a resolved session as denied.

---

## Regression Guard Pattern

When adding a control-plane feature, the regression guard for the existing data plane is:

```ts
// 1. Assert throttle edit count is unaffected
//    (permission.request between chunks must not reset or block the throttle)
expect(editCalls.length).toBeLessThan(chunkCount);
expect(editCalls.length).toBeGreaterThan(0);

// 2. Assert final content contains all chunks
const finalContent = editCalls[editCalls.length - 1].text;
for (const chunk of sentChunks) {
  expect(finalContent).toContain(chunk);
}
```

These two assertions together verify that the data-plane throttle/accumulation contract is intact without needing precise timer control.

---

## Protocol Ambiguity Checklist

Before writing a single test file for a new control-plane message type, answer:

- [ ] **Direction**: Who initiates? Who responds?
- [ ] **Wire type**: New top-level message type, or discriminated payload in an existing channel?
- [ ] **Correlation key**: New ID generated by initiator, or reuse of existing `requestId`?
- [ ] **Timeout owner**: Initiator or responder? What is the deadline?
- [ ] **Reconnect behavior**: Are in-flight control messages re-sent on reconnect? Deduplicated how?
- [ ] **Post-terminal race**: What happens if a control message arrives after stream `done: true`?
- [ ] **At-most-once**: Are responses retried on reconnect, or is delivery best-effort?

Unanswered items → flag in test catalog for the ADR author before implementation diverges.

---

## References

- `.squad/decisions/inbox/jun-adr9-permission-test-scenarios.md` — ADR-9 test catalog (29 scenarios)
- `.squad/skills/async-iterable-adapter-testing/SKILL.md` — data-plane half of the testing picture
- `tests/helpers/FakeDaemon.ts`, `FakeExtensionClient.ts` — existing test double contract
- `tests/bridge/bridgeSession.test.ts` — listener-cleanup pattern to mirror
- `src/relay/ports.ts` — `PermissionPrompter` port (relay-layer interface)
