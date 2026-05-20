# Decisions Archive

**Last updated:** 2026-05-19

---

## Phase 6 Architecture — LOCKED (2026-05-19)

**By:** Noble Six (Lead/Architect)  
**Status:** LOCKED (was PROPOSED)  

Aaron resolved all three architectural blockers. This document finalizes seven ADRs and locks the Phase 6 architecture for implementation.

### ADR-1: Use Copilot CLI Extension API for Session Attach

**Status:** ACCEPTED

Use the Copilot CLI extension API (`joinSession()`, `session.send()`, `session.on()`) as the sole attach mechanism. The extension runs as a forked Node child of the CLI process. It self-registers with the daemon over a named pipe on startup.

**Consequences:**  
✅ Push-based registration eliminates port-discovery gap entirely.  
✅ Extension lifecycle is tied to CLI lifecycle.  
✅ Bidirectional streaming is native.  
❌ Coupled to `@github/copilot-sdk@0.2.2`. Mitigation: pin 0.2.x, extension is <100 LOC.  
❌ Adds install surface (extension file deployed to user extensions dir).

---

### ADR-2: Push-Based Discovery with listSessions() Fallback

**Status:** ACCEPTED

Primary discovery is push-based. Each CLI extension instance opens a named pipe connection to the daemon and sends a `hello` message. Daemon maintains live-session map. `listSessions()` is used only as fallback for dormant sessions (on disk but no running extension).

**Consequences:**  
✅ Authoritative — daemon knows exactly which sessions have a live extension.  
✅ Low latency — registration is immediate on CLI startup.  
✅ No polling overhead.  
❌ Dormant sessions require `listSessions()` fallback. Two code paths for session enumeration.  
❌ If extension fails to register (daemon not running), session is invisible until daemon starts.

---

### ADR-3: Single Named Pipe, Multiplexed by sessionId

**Status:** ACCEPTED

A single named pipe (`\\.\pipe\reach-bridge`) serves all extension connections. Each message includes a `sessionId` field for routing. Protocol framing: UTF-8 JSON, newline-delimited. Max message size: 64 KB per line.

**Consequences:**  
✅ Single pipe simplifies firewall/security surface — one endpoint to secure.  
✅ Multiplexing by sessionId scales to 10+ concurrent sessions.  
✅ JSON-Lines is human-readable, debuggable, and trivial to parse.  
❌ Single pipe is a single point of failure. Mitigation: daemon auto-restarts (Windows service recovery), extensions reconnect.  
❌ 64 KB message limit means very large responses must be chunked. Acceptable — relay already chunks at 4096 chars for Telegram.

---

### ADR-4: Extension Crash = Session Unreachable (No Auto-Recovery)

**Status:** ACCEPTED

Extension crash marks the session as `unreachable` in the daemon's session map. Session remains in `/list` with an `[unreachable]` tag. No automatic re-fork — user restarts the CLI or opens a new session.

**Consequences:**  
✅ Simple, predictable failure mode.  
✅ Daemon stays healthy regardless of extension state.  
✅ Deterministic for testing.  
❌ User must manually restart CLI to re-establish the bridge. Acceptable — CLI restarts are fast.  
❌ `/attach` on unreachable session produces an error.

---

### ADR-5: Daemon Service Account — Logged-In User

**Status:** ACCEPTED

The Reach Windows service runs as the logged-in interactive user, not LocalSystem. `src/service/install.ts` determines the current user at install time via `whoami /upn` (preferred) or `wmic useraccount where name='%USERNAME%' get sid` (fallback). Installer prompts for password if required.

**Implementation notes:**
- `serviceaccount` block in `install.ts` sets `--username` and `--password` on service registration.
- If password prompt fails or is cancelled, installer exits with clear error: `"Service install requires your Windows password to run as your account."`
- UPN format (`user@domain`) preferred for compatibility.

**Consequences:**  
✅ Eliminates pipe DACL / integrity-level problem entirely.  
✅ Daemon sees only current user's CLI sessions.  
✅ Fixes existing `LookupAccountName failed: 1332` bug.  
❌ Service stops when user logs off. Acceptable — Reach is personal-host tool.  
❌ Multi-user-on-same-host requires one install per user. Acceptable — explicit single-user scope decision.  
❌ Requires user password at install time. Acceptable — one-time cost.

---

### ADR-6: Extension Reconnect Policy — Exponential Backoff

**Status:** ACCEPTED

Exponential backoff with parameters:
- **Base interval:** 1 second
- **Multiplier:** 2×
- **Ceiling:** 300 seconds (5 minutes)
- **Termination:** Never give up while CLI session is alive
- **Logging:** Each attempt logs attempt number, elapsed time, error message

Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s, 300s, …

On successful reconnect, extension re-sends `hello` message (re-registration) and resets backoff timer.

**Consequences:**  
✅ Daemon restarts don't require user intervention — extensions reconnect automatically.  
✅ Bounded worst-case reconnect latency: 5 minutes after backoff ceiling is reached.  
✅ Deterministic for tests — Jun can inject controlled delays and assert on attempt counts.  
✅ Logging on each attempt provides debuggability.  
❌ Stale extensions could attempt reconnects for hours if daemon down. Acceptable — CPU cost negligible (~one syscall per 5 minutes at ceiling).  
❌ Worst-case 5-minute reconnect delay after daemon restart. Acceptable — daemon restarts rare.

---

### ADR-7: Heartbeat Protocol — Ping/Pong + Pipe Teardown

**Status:** ACCEPTED

Use BOTH mechanisms:

1. **Fast path — Pipe teardown detection:** Daemon listens for `close` event on each extension's pipe connection. When CLI dies, OS closes pipe handle, daemon receives event. Detection latency: <1 second.

2. **Slow path — Ping/pong heartbeat:** Daemon sends `ping` every 30 seconds to each connected extension. Extension replies with `pong` within 5 seconds. If daemon misses one pong (30s cycle passes without pong), it waits 15s grace period before marking session `unreachable`.

**Protocol messages:**
```json
{"type": "ping", "id": "uuid-v4"}
{"type": "pong", "id": "uuid-v4"}
```

**Timing analysis:**
- **Pipe close (fast path):** <1s detection.
- **Missed pong (slow path):** Worst case = 30s + 5s + 15s = **50s**. Typical case = 5s + 15s = **20s**. Aaron's target of ≤45s is met in typical case; worst case is 50s (one cycle boundary overshoot). Acceptable.

**Consequences:**  
✅ Fast disconnect detection via pipe close — sub-second for normal CLI exits.  
✅ Catches network-style hangs.  
✅ Deterministic for tests.  
✅ UUID correlation prevents stale pongs after reconnect.  
❌ 30s background traffic per session (negligible — ~50 bytes per ping/pong pair per 30s cycle).  
❌ Worst-case detection is 50s, slightly above Aaron's 45s target. Acceptable — overshoot is boundary condition.

---

### Updated Phase 6 Status

| Dimension | Status |
|-----------|--------|
| **Architecture** | LOCKED |
| **Open architectural questions** | NONE — all gated decisions resolved |
| **ADRs** | 7 accepted (ADR-1 through ADR-7) |
| **Implementation gates** | Test doubles (`FakeDaemon`, `FakeExtensionClient`) needed Days 1–2 per Jun. Carter can start named-pipe server skeleton in parallel. Kat can start `install.ts` refactor in parallel. |

**Out of scope (Phase 6):**
- Multi-user-on-same-host (explicit single-user scope decision, ADR-5)
- Conversational Session 0 (command-only, Decision #1)
- Per-session git worktrees
- `/afk` / `/back` commands (deferred — not load-bearing)

---

### Day 1 Parallel Tasks

All three tasks below have **no hard data dependencies** and can start immediately in parallel.

**Carter — Named Pipe Server Skeleton + Extension Handshake**  
**Start:** Immediately  
**Deliverable:** `src/bridge/extensionBridge.ts` — pipe server on `\\.\pipe\reach-bridge`, accepts connections, parses JSON-Lines, handles `hello` → `session.registered` handshake. Stub `inject` and `stream` message handlers. Also `extension.mjs` skeleton — connects to pipe, sends `hello`, handles `ping`/`pong`, implements reconnect loop per ADR-6.

**Kat — install.ts Refactor for User-Account Service Install**  
**Start:** Immediately  
**Deliverable:** Refactored `src/service/install.ts` — service installs as current user (not LocalSystem) per ADR-5. `whoami /upn` primary, `wmic` fallback. Password prompt flow. Clear error on cancellation. Fixes existing `LookupAccountName failed: 1332` bug.

**Jun — FakeDaemon + FakeExtensionClient Test Doubles**  
**Start:** Immediately  
**Deliverable:** `test/helpers/FakeDaemon.ts` — spawns pipe server on random pipe name, accepts connections, sends/receives protocol messages, exposes assertion helpers. `test/helpers/FakeExtensionClient.ts` — connects to pipe, sends `hello`, responds to `ping`, exposes message log for assertions.

---

# Pipe Protocol — Carter (2026-05-19)

**To:** Jun (test doubles), Kat (install.ts)  
**From:** Carter  
**Date:** 2026-05-19

---

## Canonical Message Schema for `\\.\pipe\reach-bridge`

All messages are UTF-8 JSON, newline-delimited (JSON-Lines).  
Max frame size: **64 KB** (both directions).  
Pipe path: `\\.\pipe\reach-bridge`

---

### Inbound (extension → daemon)

#### `register` — first message sent by extension on every connect

```json
{ "type": "register", "sessionId": "<string>" }
```

- Must be the **first message** on every new pipe connection.
- `sessionId` = value of `SESSION_ID` env var (set by CLI).
- Daemon replies with `registered` or closes the connection on invalid sessionId.

#### `pong` — heartbeat reply

```json
{ "type": "pong", "id": "<uuid-v4>" }
```

- Must echo the exact `id` from the corresponding `ping`.
- Must arrive within the pong window (5 s) to avoid grace-period start.

#### `session.event` — CLI session event forwarded to daemon

```json
{ "type": "session.event", "sessionId": "<string>", "payload": { /* any object */ } }
```

- Extension sends this whenever a notable SDK session event occurs.
- `payload` shape TBD during relay refactor (Phase 6 Days 3–4).

#### `session.command-result` — result of a daemon-injected command

```json
{
  "type": "session.command-result",
  "sessionId": "<string>",
  "payload": { "text": "<response string>" }
}
```

Or on error:

```json
{
  "type": "session.command-result",
  "sessionId": "<string>",
  "payload": { "error": "<error message string>" }
}
```

---

### Outbound (daemon → extension)

#### `registered` — handshake acknowledgement

```json
{ "type": "registered", "sessionId": "<string>" }
```

- Sent immediately after a valid `register` is received.
- Signals that the extension is now the live relay for this sessionId.

#### `ping` — heartbeat probe (every 30 s)

```json
{ "type": "ping", "id": "<uuid-v4>" }
```

- Extension must reply with `pong` carrying the same `id` within 5 s.
- If no pong in 5 s: 15 s grace period begins. After grace: session evicted.

#### `session.command` — inject a message into the CLI session

```json
{
  "type": "session.command",
  "sessionId": "<string>",
  "payload": { "text": "<user message string>" }
}
```

- Extension calls `session.send(payload.text)` on the SDK session.
- Must reply with `session.command-result`.

---

## Connection Lifecycle

```
Extension                     Daemon
   │── connect ──────────────>│
   │── register ─────────────>│ (first message)
   │<── registered ───────────│
   │  (active, bidirectional) │
   │<── ping ─────────────────│ (every 30 s)
   │── pong ────────────────>│
   │<── session.command ──────│
   │── session.command-result>│
   │── session.event ─────────>│
   │── [pipe close] ──────────>│ (fast-path disconnect, <1 s)
```

---

## Jun: FakeDaemon implementation notes

- Spawn pipe server on a **configurable pipe name** (not hardcoded `reach-bridge`) so tests can run in parallel without collision.
- After accepting a connection: wait for `register`, then send `registered`.
- Expose `sendPing(sessionId)` → sends `ping` with new UUID, returns a Promise that resolves when `pong` arrives (with timeout).
- Expose `getMessages(sessionId)` → returns all inbound messages received from that session.
- Expose `sendCommand(sessionId, text)` → sends `session.command`.

## Jun: FakeExtensionClient implementation notes

- Connect to configured pipe name, send `register` with a test sessionId.
- Auto-reply to `ping` with matching `pong` (controllable: add `setPongEnabled(false)` to simulate missed heartbeat).
- Expose `getOutbound()` → all messages sent to daemon.
- Expose `waitForMessage(type)` → Promise that resolves on next message of given type.

---

## Kat: No protocol changes required

The bridge is completely isolated from `install.ts`. No action needed on this protocol.


---

# Test Doubles Contract — Message Schema

**Author:** Jun (Test Engineer)  
**Date:** 2026-05-19  
**Status:** DRAFT — awaiting Carter's `carter-pipe-protocol.md` to confirm alignment  
**Relates to:** ADR-3 (pipe protocol), ADR-7 (heartbeat), Phase 6 Day 1

---

## Purpose

This document records the exact message shapes used in `tests/helpers/FakeDaemon.ts`
and `tests/helpers/FakeExtensionClient.ts`. Carter should confirm that
`src/bridge/extensionBridge.ts` and `extension.mjs` use identical field names
and types. Any divergence is a contract break that will cause test doubles to
diverge from the real implementation.

---

## Wire Protocol

Per ADR-3:
- **Transport:** UTF-8 JSON, newline-delimited (JSON-Lines)
- **Framing:** One JSON object per line (`\n` delimiter, no embedded newlines in values)
- **Max line size:** 64 KB
- **Routing:** Every message includes a `sessionId` field

---

## Message Shapes

### Extension → Daemon (InboundMessage)

#### `hello` — extension registration (ADR-2)
```json
{
  "type": "hello",
  "sessionId": "string — Copilot CLI session ID",
  "sessionName": "string — human-readable name, e.g. 'reach-myapp'"
}
```
- Sent on connect and on every successful reconnect (ADR-6).
- Daemon responds with `session.registered`.

#### `pong` — heartbeat reply (ADR-7)
```json
{
  "type": "pong",
  "id": "string — must echo the UUID from the paired ping",
  "sessionId": "string"
}
```
- Must arrive within 5 s of the paired `ping`.
- Daemon matches by `id` to cancel the miss-detection timer.

#### `stream` — CLI response chunk (extension → daemon → relay)
```json
{
  "type": "stream",
  "sessionId": "string",
  "requestId": "string — correlates with the inject that triggered this response",
  "chunk": "string — partial response text",
  "done": "boolean — true on the final chunk of a response"
}
```

#### `stream.error` — CLI error notification
```json
{
  "type": "stream.error",
  "sessionId": "string",
  "requestId": "string",
  "error": "string — human-readable error description"
}
```

---

### Daemon → Extension (OutboundMessage)

#### `session.registered` — registration acknowledgement (ADR-2)
```json
{
  "type": "session.registered",
  "sessionId": "string"
}
```
- Sent immediately after a valid `hello` is received.

#### `ping` — heartbeat probe (ADR-7)
```json
{
  "type": "ping",
  "id": "string — unique ID for this ping (monotonic counter in FakeDaemon: 'ping-N')",
  "sessionId": "string"
}
```
- Sent every 30 s to each registered connection.
- Real implementation should use UUID v4; test double uses `ping-N` for readability.
- **Carter: confirm the real daemon uses `crypto.randomUUID()` here.**

#### `inject` — relay injects a message into the CLI session
```json
{
  "type": "inject",
  "sessionId": "string",
  "requestId": "string — unique per request, echoed in stream/stream.error replies",
  "text": "string — the Telegram message to send to Copilot"
}
```

---

## Heartbeat Timing (ADR-7)

| Parameter | Value | Controlled by |
|-----------|-------|---------------|
| Ping interval | 30 000 ms | `setInterval` in FakeDaemon.startHeartbeat() |
| Pong deadline | 5 000 ms | `setTimeout` set before _writeTo in _sendHeartbeat() |
| Grace period | 15 000 ms | `setTimeout` inside pong-deadline callback |
| Total worst-case | 50 000 ms | matches ADR-7 |

**Test-double note:** All timing uses standard `setTimeout`/`setInterval`.
Tests fake only those two (not `setImmediate`) so readline 'line' events still
fire synchronously through the in-memory PassThrough transport.

---

## Implementation Notes for Carter

1. **`hello` re-send on reconnect:** FakeExtensionClient calls `sendHello()`
   as a discrete step. The real `extension.mjs` must also re-send `hello`
   after every successful reconnect per ADR-6.

2. **Synchronous transport gotcha:** In the test doubles, PassThrough streams
   deliver data synchronously. The pong-deadline `setTimeout` handle must be
   registered in `pendingPings` *before* `_writeTo` is called, or the pong
   arrives and clears a handle that doesn't exist yet. Real named-pipe I/O is
   async so this race doesn't occur in production, but it's worth noting for
   local integration testing.

3. **`ping` id format:** Test double uses `ping-N` (monotonic counter).
   Production should use `crypto.randomUUID()`. Either format is valid as long
   as `pong.id === ping.id`.

4. **`requestId` generation:** Not specified in ADRs. Test double uses caller-
   supplied strings. Production should use `crypto.randomUUID()`.

---

## Files

| File | Role |
|------|------|
| `tests/helpers/FakeDaemon.ts` | In-process daemon double; in-memory transport |
| `tests/helpers/FakeExtensionClient.ts` | In-process extension double |
| `tests/helpers/fakePipe.smoke.test.ts` | 15-test smoke suite (all passing ✅) |

---

## Open Questions for Carter

- [ ] Confirm `ping.id` field name (docs say `id`, ADR-7 schema says `id` — matches ✅)
- [ ] Confirm `inject` message exists and uses field names `requestId` + `text`
- [ ] Confirm `stream.error` is the error shape (vs `error` top-level or embedded)
- [ ] Any additional message types in `extension.mjs` not captured above?
- [ ] Does `session.registered` carry any extra fields (e.g., timestamp)?


---

# Decision: install.ts Refactored to User-Account Service (ADR-5 Implementation)

**From:** Kat (Bot Dev)  
**To:** Carter (Pipe Server), Team  
**Date:** 2026-05-19  
**Status:** IMPLEMENTED

---

## What Changed

`src/service/install.ts` now installs Reach as a Windows Service running under the currently logged-in user account, not NetworkService/LocalSystem. This is the implementation of ADR-5.

### Key changes

- `install()` is now `async` — it resolves the current user then prompts for a Windows password before calling the SCM.
- `resolveCurrentUser()` uses `os.userInfo().username` + `process.env.USERDOMAIN` (no `LookupAccountName`, no spawned processes).
- `createService()` now accepts an optional `account: ServiceAccount` field. When provided, `logOnAs` is set in the node-windows config. When omitted (uninstall path), no `logOnAs` block is written.
- `promptPassword()` uses readline with echo suppressed via the `_writeToOutput` override pattern.
- `main()` is now `async` and wraps the top-level call in `.catch()`.

### API additions (exported)

```typescript
export interface ServiceAccount { username, domain, password }
export function resolveCurrentUser(): { username, domain }
export async function promptPassword(prompt): Promise<string>
```

---

## Impact on Carter (Named Pipe Server)

**The service now runs in the user's session.** This is the whole point of ADR-5:

- The named pipe `\\.\pipe\reach-bridge` will be created in a user-session context, not the LocalSystem/NetworkService context. This eliminates the DACL/integrity-level barrier that was blocking extension connections.
- The daemon process sees the current user's environment, so `%USERPROFILE%`, `%APPDATA%`, and any user-specific paths are correct.
- The service stops on logoff (expected behaviour for a single-user personal tool).

**No pipe protocol changes required** — this is purely a service account change.

---

## Trade-off Documented (Password Prompt)

`node-windows` requires a Windows account password to register a service under a user account (Windows SCM API requirement). A password-less path via Scheduled Task was considered but rejected because:
1. It would require dropping `node-windows` entirely.
2. Scheduled Tasks have different restart semantics (no SCM auto-restart on crash).
3. ADR-5 explicitly accepted the password cost: "Requires user password at install time. Acceptable — one-time cost."

The password is never stored — it is passed directly to `CreateService` via node-windows and lives only in memory during the install invocation.

---

## CLI Commands Preserved

No CLI changes. `npm run service:install` and `npm run service:uninstall` continue to work as before.

---

## Verification

- `npx tsc --noEmit` ✅
- `npm run lint` ✅
- `npx vitest run` — 296 passed, 4 skipped, 0 failed ✅
- Service install test suite: 22/22 passed ✅


---

# ADR-8: Canonical Pipe Wire Protocol

**Author:** Noble Six (Lead / Architect)  
**Date:** 2026-05-19  
**Status:** ACCEPTED  
**Supersedes:** Carter's `carter-pipe-protocol.md` and Jun's `jun-test-doubles-contract.md` (both were good-faith interpretations of ADR-3; neither was wrong — ADR-3 specified framing but not message shapes)

---

## Context

Carter and Jun executed Phase 6 Day 1 in parallel, as designed. Carter built the real pipe server (`extensionBridge.ts` + `extension.mjs`); Jun built the test doubles (`FakeDaemon.ts` + `FakeExtensionClient.ts`). Both compile, all 296 tests pass. But the two implementations disagree on six of eight protocol concerns:

| Concern | Carter (real) | Jun (test doubles) |
|---|---|---|
| Registration type | `register` | `hello` |
| Registration ack | `registered` | `session.registered` |
| Registration fields | `{type, sessionId}` | `{type, sessionId, sessionName}` |
| Command to CLI | `session.command` with `{text}` | `inject` with `{requestId, text}` |
| Response back | `session.command-result` with `{text}`/`{error}` | `stream` with `{requestId, chunk, done}` + `stream.error` |
| Event push | `session.event` with `{payload}` | (replaced by `stream`) |
| Ping sessionId | absent on `ping` | present on `ping` |
| Pong sessionId | absent on `pong` | present on `pong` |
| Heartbeat timing | 30s/5s/15s | 30s/5s/15s ✅ |

The root cause: ADR-3 locked the transport (JSON-Lines, single pipe, 64 KB frames, sessionId multiplexing) but left the exact message shapes unspecified. Both agents designed reasonable schemas independently.

The relay (`src/relay/relay.ts`) already streams Copilot responses chunk-by-chunk, editing a Telegram placeholder message at 800 ms intervals. Phase 6 replaces the direct SDK call with pipe-bridged communication. Any wire protocol that treats CLI responses as single-shot (`session.command-result` with one `text` blob) forces the extension to buffer the entire response before sending — destroying the streaming UX that Phase 5 built.

## Decision

Adopt Jun's streaming-oriented schema (`inject`/`stream`/`requestId`/`chunk`/`done`) as the canonical wire protocol, with targeted adjustments from Carter's design where his choices are simpler or more correct.

### Per-concern verdicts

**1. Registration type: `hello` (Jun's) ✅**

`hello` is the established term in ADR-2 ("sends a `hello` message") and ADR-6 ("re-sends `hello` on reconnect"). Carter's `register` is functionally identical but diverges from the language already locked in the ADR ledger. Keep `hello` for consistency with existing documentation.

*Trade-off:* `register` is arguably more descriptive of the action. Accepting a small readability cost to avoid a terminology split between ADR text and wire protocol.

**2. Registration ack: `session.registered` (Jun's) ✅**

Jun's `session.registered` is namespaced (`session.*`), which groups it with other session-lifecycle messages. Carter's `registered` is shorter but flat. In a multiplexed protocol with multiple message families, namespacing wins — it makes log grep, dispatch tables, and documentation easier.

*Trade-off:* One more `.` in the type string. Negligible wire cost.

**3. Registration fields: `sessionId` + `sessionName` (Jun's) ✅**

Jun added `sessionName` (human-readable, e.g. "reach-myapp"). The relay needs this to show session labels in Telegram messages. Without it, the daemon would need a separate lookup from `sessionId` → name via `listSessions()` on every registration — an extra async hop on a fast path.

*Trade-off:* Carter's extension currently reads only `SESSION_ID` from env. It will also need to read `SESSION_NAME` (or a similar env var set by the CLI). If the CLI doesn't set one, the extension should default `sessionName` to the `sessionId` value. This is a one-line change in `extension.mjs`.

**4. Command to CLI: `inject` with `{requestId, text}` (Jun's) ✅**

Jun's `inject` is a verb (correct — this is an imperative command from daemon to extension). Carter's `session.command` with `payload: { text }` wraps the text in an unnecessary `payload` envelope. `inject` is flatter and self-describing.

More importantly, Jun adds `requestId` — a correlation ID that ties every response chunk back to the command that triggered it. Without `requestId`, the daemon has no way to match incoming `stream` chunks to the original Telegram message that needs editing. The relay must correlate request → response to update the correct placeholder.

*Trade-off:* `inject` is less obviously a "session" message. Acceptable — the `sessionId` field provides the namespace.

**5. Response back: `stream` + `stream.error` (Jun's) ✅**

This is the decisive divergence. Carter's `session.command-result` returns a single `{text}` or `{error}` — the extension buffers the entire Copilot response and sends it in one shot. This destroys streaming.

Jun's design:
- `stream` with `{requestId, chunk, done}` — each SDK chunk is forwarded immediately. The daemon (and then the relay) can edit the Telegram placeholder in real time.
- `stream.error` with `{requestId, error}` — error case is a separate message type, not a field variant inside the same envelope. Cleaner dispatch.
- `done: true` on the final chunk signals completion without requiring a separate "end of response" message type.

This maps exactly onto how `relay.ts` already works: `for await (const chunk of session.send(text))` becomes chunk-by-chunk pipe messages that the daemon forwards to the relay.

*Trade-off:* More messages on the wire per response (one per SDK chunk vs. one blob). Negligible cost — chunks are small (typically <1 KB), pipe is localhost, and the alternative (buffering) defeats the entire streaming UX.

**6. Event push: `session.event` (Carter's, deferred) — RETAINED but DEFERRED**

Carter defined `session.event` as a generic event-forwarding channel. Jun replaced it entirely with `stream`/`stream.error`. Both are partially right.

Decision: Retain `session.event` in the canonical schema as a **future-use** message type for non-response events (tool calls, permission prompts, session lifecycle notifications). It is NOT used in the Day 2 migration or the Day 3–4 relay refactor. It stays in the type union for forward compatibility but has no handler yet.

*Trade-off:* Carrying a dead type in the union adds one unused branch in the dispatch switch. Removing it now and adding it later would require a protocol version bump. Cheaper to keep it.

**7. Ping: add `sessionId` (Jun's) ✅**

Jun's ping includes `sessionId`. Carter's does not (daemon broadcasts a single ping per connection, which is inherently 1:1 with a session). Jun's version is redundant on the wire but makes every message self-describing — any message can be logged, replayed, or debugged without knowing which socket it arrived on.

Decision: Include `sessionId` on `ping`. The daemon knows the sessionId for each connection; adding it costs 20–40 bytes per ping.

*Trade-off:* Slightly larger ping frame. Negligible.

**8. Pong: add `sessionId` (Jun's) ✅**

Same rationale as ping. Include `sessionId` on `pong` for self-describing messages.

---

## Canonical Message Schema

### Transport (restated from ADR-3)

- **Pipe path:** `\\.\pipe\reach-bridge`
- **Framing:** UTF-8 JSON, newline-delimited (JSON-Lines). One JSON object per `\n`-terminated line.
- **Max line size:** 64 KB
- **Routing:** Every message includes a `sessionId` field.

---

### Extension → Daemon (Inbound)

#### `hello` — registration (first message on every connect/reconnect)

```json
{
  "type": "hello",
  "sessionId": "abc-123",
  "sessionName": "reach-myapp"
}
```

- **Must** be the first message on every new pipe connection.
- **Must** be re-sent on every successful reconnect (ADR-6).
- `sessionId`: value of `SESSION_ID` env var (set by CLI).
- `sessionName`: human-readable label. Read from `SESSION_NAME` env var if available; fall back to `sessionId`.
- Daemon replies with `session.registered` or closes the connection on invalid `sessionId`.

#### `pong` — heartbeat reply

```json
{
  "type": "pong",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionId": "abc-123"
}
```

- `id` **must** echo the exact value from the corresponding `ping`.
- Must arrive within 5 s of the paired `ping` (ADR-7).

#### `stream` — CLI response chunk

```json
{
  "type": "stream",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "chunk": "Here is the first part of the response...",
  "done": false
}
```

Final chunk:

```json
{
  "type": "stream",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "chunk": "...and that's the end.",
  "done": true
}
```

- One `stream` message per SDK chunk received from `session.send()`.
- `requestId` correlates with the `inject` that triggered this response.
- `done: true` on the final chunk. Exactly one `done: true` per `requestId`.
- Empty `chunk` with `done: true` is valid (signals completion with no additional text).

#### `stream.error` — CLI error

```json
{
  "type": "stream.error",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "error": "SDK session crashed: ECONNRESET"
}
```

- Sent instead of (or after partial) `stream` chunks when the SDK call fails.
- Terminal: no more `stream` messages will arrive for this `requestId` after a `stream.error`.
- `error` is a human-readable string.

#### `session.event` — generic event (RESERVED, not yet implemented)

```json
{
  "type": "session.event",
  "sessionId": "abc-123",
  "payload": { "kind": "tool_call", "name": "read_file", "args": "..." }
}
```

- Reserved for future use (tool-call notifications, permission prompts, etc.).
- No handler required in Day 2 migration. Daemon should log and ignore unknown `session.event` payloads.

---

### Daemon → Extension (Outbound)

#### `session.registered` — registration acknowledgement

```json
{
  "type": "session.registered",
  "sessionId": "abc-123"
}
```

- Sent immediately after a valid `hello` is accepted.
- Signals the extension is the live relay for this `sessionId`.

#### `ping` — heartbeat probe

```json
{
  "type": "ping",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionId": "abc-123"
}
```

- Sent every 30 s to each registered connection.
- `id`: `crypto.randomUUID()` in production; test doubles may use `ping-N` counters.
- Extension **must** reply with `pong` carrying the same `id` within 5 s.

#### `inject` — relay sends a message into the CLI session

```json
{
  "type": "inject",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "text": "How do I fix the auth bug?"
}
```

- `requestId`: generated by the daemon (`crypto.randomUUID()`). Unique per inject.
- Extension calls `sdkSession.send(text)` and streams back `stream` chunks correlated by `requestId`.
- Extension **must not** batch — each SDK chunk should produce a `stream` message immediately.

---

## Heartbeat Timing (restated from ADR-7)

| Parameter | Value |
|-----------|-------|
| Ping interval | 30 000 ms |
| Pong deadline | 5 000 ms |
| Grace period | 15 000 ms |
| Total worst-case detection | 50 000 ms |

No changes. Both implementations already agree on timing.

---

## Reconnect / `hello`-Resend Rule (restated from ADR-6)

On successful pipe reconnect:

1. Extension re-sends `hello` with the same `sessionId` and `sessionName`.
2. Extension resets backoff counter to 0.
3. Daemon evicts any stale connection for the same `sessionId` (already implemented in `handleRegister()`).
4. Daemon sends `session.registered` ack.
5. Daemon resumes heartbeat pings to the new connection.

The `hello`-on-reconnect rule is load-bearing: it re-establishes the session mapping. An extension that reconnects without `hello` will never receive `inject` messages.

---

## Migration Tasks

### Carter — `extensionBridge.ts` + `extension.mjs` (Day 2)

These are the changes Carter must make to align the real implementation with this ADR.

#### `extensionBridge.ts` (daemon side)

1. **Rename `register` → `hello` in message types and dispatch.**
   - `RegisterMessage.type` → `'hello'`
   - `handleLine()` switch case: `'register'` → `'hello'`
   - `handleRegister()` → `handleHello()` (or keep name, just change the case label)

2. **Add `sessionName` field to `HelloMessage` interface.**
   ```typescript
   export interface HelloMessage {
     type: 'hello';
     sessionId: string;
     sessionName: string;
   }
   ```
   - Store `sessionName` on `InternalConnection` so the daemon can expose it via `getSession()`.

3. **Rename `registered` → `session.registered` in outbound ack.**
   - `RegisteredMessage.type` → `'session.registered'`
   - Update the `conn.send()` call in `handleHello()`.

4. **Add `sessionId` to `PingMessage`.**
   ```typescript
   export interface PingMessage {
     type: 'ping';
     id: string;
     sessionId: string;
   }
   ```
   - Update `sendPing()` to include `sessionId: conn.sessionId`.

5. **Replace `session.command` → `inject` with `requestId`.**
   ```typescript
   export interface InjectMessage {
     type: 'inject';
     sessionId: string;
     requestId: string;
     text: string;
   }
   ```
   - Update `sendCommand()` to generate `requestId` via `randomUUID()` and send flat `{type, sessionId, requestId, text}`.
   - Return the `requestId` from `sendCommand()` so callers can correlate responses.

6. **Replace `session.command-result` listener with `stream` + `stream.error` handling.**
   ```typescript
   export interface StreamChunkMessage {
     type: 'stream';
     sessionId: string;
     requestId: string;
     chunk: string;
     done: boolean;
   }

   export interface StreamErrorMessage {
     type: 'stream.error';
     sessionId: string;
     requestId: string;
     error: string;
   }
   ```
   - Add `'stream'` and `'stream.error'` cases to `handleLine()` dispatch.
   - Emit typed events: `this._emitter.emit('stream', sessionId, requestId, chunk, done)` and `this._emitter.emit('stream.error', sessionId, requestId, error)`.
   - Update `BridgeEmitter` interface with new event signatures.

7. **Update `PongMessage` to expect `sessionId`.**
   - Add `sessionId: string` to `PongMessage` interface.
   - No behavioral change needed (daemon already matches by `id`).

8. **Retain `session.event` in type union** but no handler changes needed (existing `'session.event'` case in dispatch can stay as-is; mark it as reserved).

#### `extension.mjs` (extension side)

1. **Rename `register` → `hello` in outbound registration.**
   - Change `sendToDaemon({ type: 'register', sessionId: SESSION_ID })` to `sendToDaemon({ type: 'hello', sessionId: SESSION_ID, sessionName: SESSION_NAME })`.
   - Add `const SESSION_NAME = process.env['SESSION_NAME'] ?? SESSION_ID;` near `SESSION_ID`.

2. **Rename `registered` → `session.registered` in inbound dispatch.**
   - `handleMessage()` switch: `'registered'` → `'session.registered'`.

3. **Add `sessionId` to outbound `pong`.**
   - Change `sendToDaemon({ type: 'pong', id: msg.id })` to `sendToDaemon({ type: 'pong', id: msg.id, sessionId: SESSION_ID })`.

4. **Rename `session.command` → `inject` in inbound dispatch.**
   - Switch case: `'session.command'` → `'inject'`.
   - Update `handleCommand()` signature to receive `{type, sessionId, requestId, text}` (flat, no `payload` wrapper).

5. **Replace single-shot `session.command-result` with streaming `stream` chunks.**
   - Instead of `for await ... accumulated += chunk ... sendToDaemon({ type: 'session.command-result' })`:
   ```javascript
   const requestId = msg.requestId;
   try {
     for await (const chunk of sdkSession.send(msg.text)) {
       sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk, done: false });
     }
     sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk: '', done: true });
   } catch (err) {
     sendToDaemon({ type: 'stream.error', sessionId: SESSION_ID, requestId, error: err.message });
   }
   ```
   - This is the most important change — it enables real-time streaming through the pipe.

---

### Jun — `FakeDaemon.ts` + `FakeExtensionClient.ts` (Day 2)

Jun's test doubles are already aligned with this ADR. Changes are minor:

1. **No message type renames needed.** Jun's types (`hello`, `session.registered`, `inject`, `stream`, `stream.error`, `ping` with `sessionId`, `pong` with `sessionId`) are the canonical schema.

2. **Verify `sessionName` default.** Ensure `FakeExtensionClient` constructor continues to require `sessionName`. No change needed if it already does (confirmed: constructor takes `(sessionId, sessionName)`).

3. **Add `session.event` to `InboundMessage` union** for forward compatibility:
   ```typescript
   export type SessionEventMessage = {
     type: 'session.event';
     sessionId: string;
     payload: unknown;
   };
   ```
   Add to `InboundMessage` union. `_handleInbound()` default case already handles unknown types by recording them — no dispatch change needed.

4. **Update TODO comments.** Remove the "awaiting Carter's protocol doc" TODOs from both files — this ADR is the source of truth.

---

### Relay Refactor — Phase 6 Days 3–4

The relay team (likely Carter + Jun) will need to integrate the pipe bridge into `relay.ts`. Here's what the wire protocol means for them:

1. **Sending a user message:** The relay calls `bridge.sendCommand(sessionId, text)` (or renamed to `bridge.inject(sessionId, text)`). The bridge generates a `requestId`, sends `inject` over the pipe, and returns the `requestId`.

2. **Receiving streaming response:** The relay subscribes to bridge events:
   ```typescript
   bridge.on('stream', (sessionId, requestId, chunk, done) => {
     // Edit the Telegram placeholder with accumulated text
     // When done === true, send the final formatted message
   });

   bridge.on('stream.error', (sessionId, requestId, error) => {
     // Edit placeholder with error message
   });
   ```

3. **Correlation:** `requestId` ties each `stream` chunk back to the Telegram message that needs editing. The relay maintains a `Map<requestId, { chatId, messageId, accumulated }>` to track in-flight responses.

4. **Throttling:** The existing 800 ms edit throttle in `relay.ts` applies unchanged — the relay accumulates chunks between edits, same as today.

5. **Message splitting:** After `done: true`, the relay runs the accumulated response through `splitForTelegram()` for the final formatted delivery, same as today.

6. **Error path:** `stream.error` replaces the `catch` block on the `for await` loop. The relay edits the placeholder with `❌ Error: ${error}`.

7. **The `session.event` type is NOT used** in the Day 3–4 relay refactor. It's reserved for future features (tool-call streaming, permission prompts via Telegram).

---

## Summary of Canonical Types

| Direction | Type | Fields | Purpose |
|-----------|------|--------|---------|
| ext → daemon | `hello` | `type, sessionId, sessionName` | Registration |
| ext → daemon | `pong` | `type, id, sessionId` | Heartbeat reply |
| ext → daemon | `stream` | `type, sessionId, requestId, chunk, done` | Response chunk |
| ext → daemon | `stream.error` | `type, sessionId, requestId, error` | Response error |
| ext → daemon | `session.event` | `type, sessionId, payload` | Reserved (future) |
| daemon → ext | `session.registered` | `type, sessionId` | Registration ack |
| daemon → ext | `ping` | `type, id, sessionId` | Heartbeat probe |
| daemon → ext | `inject` | `type, sessionId, requestId, text` | Send message to CLI |

---

## Consequences

✅ Streaming is preserved end-to-end: SDK chunk → `stream` message → daemon event → relay edit → Telegram placeholder update.  
✅ `requestId` correlation enables concurrent inject/response pairs on the same session (future: tool-call results while response is streaming).  
✅ Self-describing messages (every message has `sessionId`) simplify logging and debugging.  
✅ Forward-compatible: `session.event` reserved for future event types without protocol version bump.  
✅ Test doubles are already 95% aligned — minimal migration for Jun.

❌ Carter has the larger migration (~8 changes across two files). Trade-off accepted: fixing the protocol now is cheaper than fixing it after the relay refactor when three files depend on the wrong shapes.  
❌ `sessionName` requires the extension to read a new env var. If the CLI doesn't set `SESSION_NAME`, the fallback (`sessionId`) is functional but less readable in Telegram. Acceptable — we can add the env var to the CLI extension loader later.  
❌ More wire messages per response (chunk-by-chunk vs. one blob). Negligible cost on localhost pipe.

---

*Signed: Noble Six, 2026-05-19*



---

# Carter Day 2 — `sendCommand()` Return Type Decision

**Author:** Carter  
**Date:** 2026-05-20  
**Status:** FYI — no blocking action needed; noting for relay/Kat integration awareness

---

## Context

ADR-8 §4 specifies that `inject` messages carry a `requestId` generated by the daemon.
The `requestId` must be returned to the caller (relay layer) so it can correlate incoming
`stream` chunks back to the Telegram placeholder that needs editing.

## Decision

`ExtensionBridge.sendCommand()` signature changed:

**Before (Day 1):**
```typescript
sendCommand(sessionId: string, payload: unknown): boolean
```

**After (Day 2, ADR-8):**
```typescript
sendCommand(sessionId: string, text: string): string | false
```

- Returns the generated `requestId` (`crypto.randomUUID()`) on success.
- Returns `false` if the session is not registered or is unreachable.
- `requestId` is generated inside `sendCommand`; the caller does not need to supply it.

## Rationale

The relay will need to match incoming `'stream'` events (which carry `requestId`) to the
correct pending Telegram edit. Returning the `requestId` from `sendCommand` gives the relay
the correlation handle without requiring a separate lookup map in the bridge.

## Impact on other agents

- **Kat** (command surface / relay refactor, Days 3–4): call sites that used `sendCommand(sid, payload)` need updating to `sendCommand(sid, text)` and should capture the return value for correlation.
- **Jun**: FakeDaemon uses `sendTo()` directly (bypasses `sendCommand`), so test doubles are unaffected.

---

# Jun Day 2 — `session.event` Shape Decision

**Author:** Jun (Test Engineer)  
**Date:** 2026-05-20  
**Status:** INFORMATIONAL — no team action required

---

## Context

ADR-8 §6 defers `session.event` to a future-use type in the canonical wire protocol.
The shape given in ADR-8's canonical schema is:

```json
{
  "type": "session.event",
  "sessionId": "abc-123",
  "payload": { "kind": "tool_call", "name": "read_file", "args": "..." }
}
```

Day 2 task: add this type to the `InboundMessage` discriminated union in
`tests/helpers/FakeDaemon.ts` for forward compatibility.

---

## Decision

**Field name:** `payload` (not `data` or `body`).  
**Field type:** `unknown` (not `any`, not `Record<string, unknown>`).

### Alternatives considered

| Option | Shape | Verdict |
|---|---|---|
| A (chosen) | `payload: unknown` | Matches ADR-8 field name. `unknown` enforces narrowing at callsites. |
| B | `data?: unknown` | `data` diverges from ADR-8 example. Optional implies daemon may omit it; ADR-8 gives no such hint. |
| C | `payload: Record<string, unknown>` | Over-constrains. ADR-8 says this is a generic event channel; a non-object payload (e.g. string or number) should not be ruled out. |
| D | `payload: { kind: string; [k: string]: unknown }` | Pre-assumes a `kind` discriminator. ADR-8 doesn't lock the payload shape — that's the whole point of deferring. |

### Rationale for `unknown`

- Matches ADR-8's field name exactly.
- `unknown` is the canonical TypeScript type for "data whose shape is not yet defined." Any consumer that eventually needs to read `payload` must narrow it first — this is intentional and correct for a reserved/not-yet-implemented message type.
- If ADR-9 locks a specific `session.event` payload shape, changing `unknown` to a concrete type is a non-breaking refinement (narrowing from unknown).

---

## Impact

- `FakeDaemon.ts` exports `SessionEventMessage` and it is part of `InboundMessage`.
- `_handleInbound`'s `default: break` already handles it (no dispatch needed until ADR-9 specifies behavior).
- 296 tests pass, 4 skipped, 0 failed. tsc clean. lint clean.

No action required from Carter, Kat, or Noble Six unless ADR-9 specifies a different `payload` shape.

