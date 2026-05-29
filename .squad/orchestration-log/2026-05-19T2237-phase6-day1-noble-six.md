# Orchestration Log: Noble Six — Phase 6 Day 1

**Date:** 2026-05-19T22:37:10-07:00  
**Agent:** Noble Six (general-purpose, claude-opus-4.6, sync)  
**Phase:** Phase 6 Day 1 implementation kickoff (Protocol reconciliation)

---

## Deliverable

### ADR-8: Canonical Pipe Wire Protocol

**Status:** ACCEPTED

**Context:**
Carter and Jun executed Phase 6 Day 1 in parallel as designed. Both delivered code:
- Carter: `src/bridge/extensionBridge.ts` + `extension.mjs` (real pipe server)
- Jun: `tests/helpers/FakeDaemon.ts` + `FakeExtensionClient.ts` (test doubles)

Both compile, all 296 tests pass. But the two implementations diverge on 6 of 8 protocol concerns:

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

Root cause: ADR-3 locked transport (JSON-Lines, single pipe, 64 KB frames, sessionId multiplexing) but left message shapes unspecified. Both agents designed reasonable schemas independently.

---

## Decision: Adopt Jun's Streaming Schema as Canonical

**Verdicts (8 per-concern resolutions):**

1. **Registration: `hello` (Jun's)** ✅
   - Established terminology in ADR-2 ("sends a `hello` message") and ADR-6 ("re-sends `hello` on reconnect")
   - Trade-off: `register` is more descriptive; accepting small readability cost for terminology consistency

2. **Registration ack: `session.registered` (Jun's)** ✅
   - Namespaced (`session.*`) groups session-lifecycle messages
   - Simplifies logging, dispatch tables, documentation
   - Trade-off: One more `.` in type string; negligible wire cost

3. **Registration fields: `sessionId` + `sessionName` (Jun's)** ✅
   - `sessionName` is human-readable label (e.g., "reach-myapp")
   - Relay needs this to show session labels in Telegram messages
   - Without it, daemon would need `listSessions()` lookup on every registration
   - Trade-off: Extension must read `SESSION_NAME` env var (or default to `sessionId`); one-line change

4. **Command to CLI: `inject` with `{requestId, text}` (Jun's)** ✅
   - `inject` is verb (correct — this is imperative command from daemon to extension)
   - Carter's `session.command` wraps text in unnecessary `payload` envelope
   - `requestId` is critical: ties response chunks back to command that triggered them
   - Trade-off: `inject` is less obviously a "session" message; `sessionId` field provides namespace

5. **Response back: `stream` + `stream.error` (Jun's)** ✅✅ **DECISIVE**
   - Carter's single-shot `session.command-result` forces extension to buffer entire response
   - This destroys streaming UX that Phase 5 built (relay edits Telegram placeholder at 800ms intervals)
   - Jun's streaming protocol:
     - `stream` with `{requestId, chunk, done}` — each SDK chunk forwarded immediately
     - `stream.error` with `{requestId, error}` — error case is separate message type
     - `done: true` signals completion without separate end message
   - Maps exactly to relay's existing `for await (const chunk of session.send(text))`
   - Trade-off: More messages on wire per response (chunks are small, localhost pipe); alternative (buffering) defeats UX

6. **Event push: `session.event` (Carter's, deferred)** ✅ **RETAINED but DEFERRED**
   - Carter defined generic event-forwarding channel for future use
   - Jun replaced with `stream`/`stream.error` (both partially right)
   - Decision: Retain `session.event` as **reserved** for future (tool calls, permission prompts, lifecycle)
   - NOT used in Day 2 migration or Day 3–4 relay refactor
   - Trade-off: Carrying dead type adds one unused branch; cheaper than protocol version bump later

7. **Ping: add `sessionId` (Jun's)** ✅
   - Jun includes `sessionId` on ping; Carter's doesn't (1:1 per connection)
   - Jun's version is redundant on wire but makes every message self-describing
   - Costs 20–40 bytes per ping; enables logging/replay without socket context
   - Trade-off: Slightly larger ping frame; negligible

8. **Pong: add `sessionId` (Jun's)** ✅
   - Same rationale as ping — self-describing messages

---

## Canonical Message Schema

### Transport
- **Pipe path:** `\\.\pipe\reach-bridge`
- **Framing:** UTF-8 JSON, newline-delimited (JSON-Lines)
- **Max line:** 64 KB
- **Routing:** Every message includes `sessionId` field

### Extension → Daemon (Inbound)
- **`hello`** — registration (first on every connect/reconnect)
  - `{ type, sessionId, sessionName }`
  - `sessionName` = `SESSION_NAME` env var (or fallback to `sessionId`)
  
- **`pong`** — heartbeat reply
  - `{ type, id, sessionId }`
  - `id` must echo corresponding `ping`
  
- **`stream`** — CLI response chunk
  - `{ type, sessionId, requestId, chunk, done }`
  - One per SDK chunk; `done: true` on final
  
- **`stream.error`** — CLI error
  - `{ type, sessionId, requestId, error }`
  - Terminal: no more `stream` for this `requestId`
  
- **`session.event`** — reserved (future use)
  - `{ type, sessionId, payload }`

### Daemon → Extension (Outbound)
- **`session.registered`** — registration ack
  - `{ type, sessionId }`
  
- **`ping`** — heartbeat probe
  - `{ type, id, sessionId }`
  - `id` = `crypto.randomUUID()` (production) or `ping-N` (test doubles)
  
- **`inject`** — relay sends message to CLI
  - `{ type, sessionId, requestId, text }`
  - `requestId` = unique per inject (daemon-generated via `crypto.randomUUID()`)
  - Extension must NOT batch — each chunk → immediate `stream` message

---

## Migration Tasks

### Carter — Day 2 (~8 changes)
**extensionBridge.ts:**
1. Rename `register` → `hello` in types and dispatch
2. Add `sessionName` field to `HelloMessage`; store on connection
3. Rename `registered` → `session.registered` in outbound ack
4. Add `sessionId` to `PingMessage`
5. Replace `session.command` → `inject` with `requestId` generation
6. Replace `session.command-result` listener with `stream` + `stream.error` handling
7. Update `PongMessage` to expect `sessionId`
8. Retain `session.event` in type union (no behavior change)

**extension.mjs:**
1. Rename `register` → `hello` in outbound registration; add `sessionName`
2. Rename `registered` → `session.registered` in dispatch
3. Add `sessionId` to outbound `pong`
4. Rename `session.command` → `inject` in dispatch
5. Replace single-shot response with streaming `stream` chunks per SDK chunk
   - `for await (const chunk of sdkSession.send(msg.text))` → emit `stream` immediately
   - Final `stream` with `done: true` and empty chunk
   - `catch` → emit `stream.error`

### Jun — Day 2 (1 minor addition)
1. Add `session.event` to `InboundMessage` union (forward compatibility)
2. Default case already handles unknown types — no dispatch change needed
3. Update TODO comments (this ADR is source of truth)

### Relay Refactor — Days 3–4
Integration points:
- `bridge.sendCommand(sessionId, text)` → returns `requestId`
- `bridge.on('stream', ...)` → `(sessionId, requestId, chunk, done)`
- `bridge.on('stream.error', ...)` → `(sessionId, requestId, error)`
- Relay maintains `Map<requestId, {chatId, messageId, accumulated}>`
- 800ms edit throttle applies unchanged
- `stream.error` replaces `catch` block

---

## Consequences

✅ Streaming preserved end-to-end: SDK chunk → `stream` → daemon event → relay edit → Telegram update  
✅ `requestId` correlation enables concurrent inject/response pairs  
✅ Self-describing messages simplify logging and debugging  
✅ Forward-compatible: `session.event` reserved for future without protocol bump  
✅ Test doubles already 95% aligned — minimal Jun migration  

❌ Carter has larger migration (~8 changes) — trade-off accepted: fixing now cheaper than after relay refactor  
❌ `sessionName` requires new env var — fallback to `sessionId` functional  
❌ More wire messages per response — negligible on localhost pipe

---

**Status:** ADR-8 locked and documented. Day 2 migration tasks assigned.

**Signed:** Noble Six, 2026-05-19T22:37:10-07:00
