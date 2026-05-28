# Carter — History (Summarized)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, named-pipe bridge
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Days 1–2 COMPLETE** (bridge plumbing + protocol migration). **Phase 6 Days 3–4 COMPLETE** (bridge integrated with relay adapter via Kat + Jun). Core bridge ready for production testing.

**Review Cycle 1 + B3 COMPLETE** (commits `22e7a44`, `e4bf8dc`): B1 listener leak, B2 stream disconnect, B3 pipe auth (ADR-10), I1/I2/I5/I6/I9, minor fixes.

**Review Cycle 2 COMPLETE** (commit `e839e1e`): N1 constant-time token compare (`timingSafeEqual`), N2 `cleanupPipeAuth()` called from `ExtensionBridge.stop()`.

Test suite: 358 passed / 4 skipped / 0 failed ✅

**2026-05-24 Dogfooding Kickoff:** Inbox decisions merged (Carter's 2 reviews consolidated into canonical decisions.md). ADR-10 finalized. Awaiting Noble Six dogfooding checklist for go-live assessment.

---

## Phases 1–5 Summary

Full Phase 1–5 documentation (MarkdownV2, message splitting, relay plumbing, session discovery spike) archived in `history-archive.md`.

**Key accomplishment:** Relay with 800ms throttle, MarkdownV2 fallback, split-chunk logic, idle eviction. 278 tests passing. Production-ready.

---

## Phase 6 Days 1–2 (2026-05-19–2026-05-20)

**Day 1: Bridge Implementation**
- Built `src/bridge/extensionBridge.ts` — named-pipe server on `\\.\pipe\reach-bridge`, JSON-Lines protocol, heartbeat (ping/pong every 30s, 5s pong window, 15s grace), fast-path disconnect via pipe close event.
- Built `extension.mjs` — CLI extension with `joinSession()`, exponential backoff reconnect (1s–300s ceiling), heartbeat, command injection stub.
- Learned: TypeScript composition pattern for typed event emitters (avoids `no-unsafe-declaration-merging` eslint; use private `_emitter + EventEmitter()` with typed overloads, not `class extends`).
- Learned: Implementation signature of event emitter overloads must use `(...args: any[]` (not `unknown[]`) to be compatible with specific listener signatures.

**Day 2: ADR-8 Protocol Migration**
- Migrated `extensionBridge.ts` and `extension.mjs` from Day 1 wire schema to ADR-8 canonical (`hello`/`session.registered`/`inject`/`stream` with `requestId`/`chunk`/`done`, heartbeat `sessionId` added).
- Changed `sendCommand()` signature: `(sessionId, payload) → boolean` → `(sessionId, text) → string | false` (returns `requestId` for relay correlation).
- Added 9 mechanical changes (ADR-8 §1–8): type names, message shapes, requestId fields, sessionId in heartbeat, streaming implementation.
- Result: 296 tests passing (baseline preserved). tsc clean. Lint clean.

---

## Phase 6 Days 3–4 (2026-05-22)

**Status:** Kat shipped relay-bridge adapter; Jun shipped 20 tests. Bridge fully integrated.

**What Kat built over Carter's extensionBridge:**
- `BridgeSession` (bridgeSession.ts) — async-iterator adapter (push-to-pull) implementing `CopilotSession`
- `BridgeSessionFactory` (bridgeSessionFactory.ts) — factory implementing `CopilotSessionFactory`
- `CompositeSessionFactory` (compositeSessionFactory.ts) — bridge-first, SDK-fallback composition
- Added `getSessionByName()` to extensionBridge.ts — maps relay's human-readable session names to bridge's internal `sessionId`
- Wired bridge + composite factory in main.ts

**Key for Carter if you touch the bridge again:**
- `extensionBridge.ts` now tracks `sessionName` in `InternalConnection` (stored from `hello` message)
- Bridge events consumed via `BridgeSession` adapter (not directly by relay) — relay.ts unchanged
- Known gap: Bridge sessions ignore `permissionCallback` (ADR-9 future — wire protocol lacks permission-request round-trip)
- All relay logic (800ms throttle, MarkdownV2 fallback, split-chunk, error handling) inherited by bridge sessions at zero code cost

---

## Design Patterns & Learnings

1. **Named-pipe multiplexing:** Single pipe, sessionId in each message, index by sessionId
2. **Async-iterator adapters:** Push (bridge events) → Pull (relay's async iterable) via queue + Promise
3. **Composition over config flags:** Composite factory (bridge-first, fallback to SDK) avoids hard-disable of either factory
4. **Type safety in protocol:** JSON-Lines with discriminated unions (`type` field) enables exhaustive type checking
5. **Streaming over single-shot:** `requestId` correlation needed for relay's per-chunk editing (800ms throttle)
6. **Typed event emitters:** Composition + overloads (not class inheritance) avoids eslint lint issues

See `history-archive.md` for earlier phases and Phase 6 spike details.

---

## 2026-05-24 — Skill Spike (issue #6)

Researched whether a Copilot CLI `skill.md` can intercept slash commands, hold per-session state, and call the named pipe. Verdict: **NO** — skill.md is a markdown instruction document only (no code surface). The surface that CAN do all three is `extension.mjs` via SDK `commands: CommandDefinition[]` in `joinSession()`. High confidence. Full analysis in `.squad/decisions/inbox/carter-skill-spike.md`.

---

## Phase 6 Day 5 (2026-05-22)

**Status:** ADR-9 (Permission Prompting Over Bridge) drafted. **GATING:** 4 open questions for Aaron before implementation begins.

**ADR-9 Summary:**
- **Problem:** `BridgeSession` silently discards `permissionCallback` — destructive tools run without user consent
- **Decision:** In-stream interleaving. 3 new message types: `permission.request`, `permission.response`, `permission.cancelled` on existing pipe (ADR-3/ADR-8)
- **Delivery scope:** Full wire schema, adapter integration (extensionBridge.ts + BridgeSession), security guidance, test scenarios (Jun's 29-scenario catalog complete)

**4 Decisions Locked for Aaron:**
1. Telegram UX shape (buttons? commands?)
2. Default `timeoutMs` (30s proposed)
3. `allow-always` scope (in-memory per-session vs. persisted)
4. Risk classification owner (extension or daemon)

**Impact on Carter's Bridge:** 
- New message types added to wire protocol union (inbound: `permission.request`, `permission.cancelled`; outbound: `permission.response`)
- New event types added to `BridgeEmitter` (`permission.request`, `permission.cancelled`)
- New helper: `bridge.sendPermissionResponse()` to send daemon→extension decisions
- No breaking changes to existing protocol; new types append to unions

**Blocking:** Production dogfooding blocked on ADR-9 resolution. This is the gating issue for Phase 6 completion.

---

## Phase 6 Dogfood Day 1 (2026-05-23)

**Status:** Investigating live dogfood bug: `bash ls` executed without ADR-9 permission prompt.

### SDK Investigation Findings

**Inspected:** `@github/copilot-sdk` v0.2.2 dist types (`types.d.ts`, `session.d.ts`, `session-events.d.ts`, `session.js`)

#### 1. `resolvedByHook` bypass (PRIMARY SUSPECT)

In `session.js:224-250`, `_handleBroadcastEvent`:
```javascript
} else if (event.type === "permission.requested") {
  const { requestId, permissionRequest, resolvedByHook } = event.data;
  if (resolvedByHook) {
    return; // BYPASSES onPermissionRequest entirely
  }
  if (this.permissionHandler) {
    void this._executePermissionAndRespond(requestId, permissionRequest);
  }
}
```
If Aaron's Copilot CLI has a pre-tool-use hook configured (in `~/.config/gh-copilot/settings.json` or similar) that auto-approves all or some tools, the CLI sets `resolvedByHook: true` in the event before it reaches the SDK. Our `onPermissionRequest` handler is never called, and the tool executes silently. This is the most likely cause.

**Key observation:** User-registered `on(eventType, handler)` handlers DO fire before `_handleBroadcastEvent` (see `_dispatchEvent`), so an `onEvent` handler in the session config will see `permission.requested` events even when `resolvedByHook: true`.

#### 2. Undocumented `PermissionRequest` kinds

`session-events.d.ts` reveals two `kind` values NOT in the exported `PermissionRequest` type (`types.d.ts`):
- `kind: 'hook'` — a pre-tool-use hook asking for confirmation on behalf of the gated tool (has `toolName` field = the gated tool)
- `kind: 'memory'` — store_memory tool (Copilot memory storage, non-destructive)

Our original classifier mapped both to `denied-by-rules` (unknown tool fallback). Fixed:
- `'hook'` → delegate to `toolName` field (the actual gated tool name)
- `'memory'` → added to `SAFE_TOOLS` (non-destructive, equivalent to read)

#### 3. Shell args shape mismatch

Real SDK `kind: 'shell'` sends `fullCommandText: string` (not `args`). Our `serializePermissionArgs` was calling `JSON.stringify(toolRequest.args ?? {})` = `'{}'` for real SDK calls. Fixed to prefer `fullCommandText` when present (falls back to `args` for backward compat with tests).

#### 4. `kind` mapping is correct for the bypass scenario

For `kind === 'shell'` on Windows: `'powershell'` (DESTRUCTIVE_TOOLS) → should prompt. So if `resolvedByHook` is NOT the cause and our handler IS being called, the classifier is correct and should prompt. Diagnostic logs will confirm.

### Changes Made

- **`src/copilot/permissions.ts`**: Added `'memory'` to `SAFE_TOOLS`
- **`src/copilot/impl.ts`**:
  - `getPermissionToolName`: handle `kind: 'hook'` by delegating to `req.toolName` (the gated tool)
  - `serializePermissionArgs`: now takes the full `ToolPermissionRequest`; uses `fullCommandText` for shell
  - `buildPermissionDiagnosticHandler`: `SessionEventHandler` passed as `onEvent` to session config; logs `permission.requested` events including `resolvedByHook`
  - `makePermissionHandler`: added diagnostic logging before EVERY branch (kind, toolName, decision)
  - `resumeSession` / `createSession` configs: added `onEvent: buildPermissionDiagnosticHandler(sessionName)`

### Next Step for Aaron

See findings written to `.squad/decisions/inbox/carter-permission-prompt-dogfood-bug.md`.

---

## 2026-05-24 — /afk Mode Protocol Opens (post-realignment)

Post-realignment opens analysis: identified 8 concrete protocol opens under corrected mirror/broadcast + machine-wide AFK semantics — including mode-state singleton, new `mirror.input` message type, `relay.command` for slash relay, machine-wide broadcast mechanics, Spawn/Resume message surface, and 2 TBDs (local prompt echo direction, spawn mechanism). Full analysis in `.squad/decisions/inbox/carter-afk-mode-protocol-opens.md`.

---

## 2026-05-24 — /afk–/back Protocol Gap Audit

Audited bridge and pipe protocol for /afk user story; identified 4 new message types needed (`afk.request`, `afk.activated`, `back.request`, `back.confirmed`), 3 daemon-side gaps (no session-to-topic map, no active-sink state machine, no topic-creation trigger), and 2 extension-side gaps (no /afk command handler, no output suppression). Confirmed switching (not broadcast) semantics. Full analysis in `.squad/decisions/inbox/carter-afk-protocol-gaps.md`.


**[2026-05-24] Scribe log entry:** Skill-spike verdict: NO (HIGH). SDK commands field is correct surface for /afk. Authored protocol gap analyses. Permission prompt diagnostics deployed. Await Aaron rerun.

---

## 2026-05-24T23:19:14-07:00 — Phase 7 Pipe Types + Extension Commands

- Protocol union owner: `src/bridge/extensionBridge.ts` (`InboundMessage` / `OutboundMessage`); test mirrors are `tests/helpers/FakeDaemon.ts` and `tests/helpers/FakeExtensionClient.ts`.
- Added ADR-11 pipe surface: `afk.request`, `back.request`, `afk.activated`, `back.confirmed`, `mode.changed`, `mirror.input`, `relay.command`, and amended `session.registered` with optional `mode` + `topicId`.
- New `BridgeEmitter` channels for Kat: `afk.request(sessionId)` and `back.request(sessionId)`. Dispatcher validates the frame `sessionId` against the registered pipe session before emitting.
- `extension.mjs` registers SDK slash commands `/afk` and `/back` via `joinSession({ commands })`; disconnected pipe path shows `⚠ Reach daemon not running`.
- `extension.mjs` handles `mirror.input` by logging `📱 Telegram: {text}` and feeding text through the existing SDK send/ADR-8 stream path with generated `mirror-${uuid}` requestIds.
- Full wire-schema rationale and Kat/Jun handoff notes are in `.squad/decisions/inbox/carter-phase7-pipe-types.md`.
- Validation: `npx tsc --noEmit`, `npx vitest run`, and `npm run lint` all passed after persona-review fixes.

## 2026-05-25T06:19:14Z — Phase 7 Orchestration Complete

**Session:** Phase 7 implementation kickoff (Carter-4 + Kat-3 + Jun-1)

**Outcome:** Protocol pipe types (ADR-11 §4) + extension.mjs slash command infrastructure complete. Full suite + lint green. Orchestration log: `.squad/orchestration-log/2026-05-25T06-19-14Z-carter-4.md`.

**Decisions merged to `.squad/decisions.md`:** `carter-phase7-pipe-types.md` — protocol locations, event channels, scope boundaries.

**Ready for:** Kat integration (daemon-side AFK state machine consumes BridgeEmitter events) + Jun testing (contract tests verify round-trip message flow).

---

## Learnings

### 2026-05-27T23:48:20-07:00 — A7: Inbound shape drift coverage

**Test file:** `tests/bridge/extension-protocol-drift.test.ts`

**New coverage:** 30 new tests (31 total in file — 1 pre-existing outbound test preserved).

Breakdown by area:
- **Union-coverage group (3 tests):** Parses `InboundMessage` union discriminants from protocol.ts and compares to all type values emitted by extension.mjs. Catches stray sends and missing union members.
- **hello (RegisterMessage) group (6 tests):** Pins `type='hello'`, required `sessionId`/`sessionName`/`authToken`, optional `cwd`, exact field-name set. Guards ADR-8 + ADR-10 + ADR-11 additions.
- **pong (PongMessage) group (4 tests):** Pins `type='pong'`, required `id`/`sessionId`, exact field-name set.
- **stream (StreamMessage) group (6 tests):** Pins `type='stream'`, required `sessionId`/`requestId`/`chunk`/`done: boolean`, exact field-name set. Covers both chunk (`done: false`) and final (`done: true`) variants — single interface.
- **stream.error (StreamErrorMessage) group (5 tests):** Pins `type='stream.error'`, required `sessionId`/`requestId`/`error`, exact field-name set.
- **afk.request (AfkRequestMessage) group (3 tests):** Pins `type='afk.request'`, required `sessionId`, exact field-name set (ADR-11 §4.1).
- **back.request (BackRequestMessage) group (3 tests):** Pins `type='back.request'`, required `sessionId`, exact field-name set (ADR-11 §4.3).

**Parser design decisions:**
- `parseExtensionSentTypes` uses three regex patterns to cover: `sendToDaemon({ type: 'literal'`, `JSON.stringify({ type: 'literal'` (hot-path stream chunks written directly to socket), and `sendModeRequest('afk.request'|'back.request')` (dynamic-type variable path). All three are needed for full coverage.
- `parseInterfaceFields` uses `/^\s+(\w+)(\?)?\s*:\s*(.+?)\s*;/gm` — JSDoc comment lines starting with `*` are automatically skipped since `*` is not `\w`. Confirmed safe for all six target interfaces.
- `_AnchorImports` type alias imports all six TypeScript interfaces for compile-time documentation; if an interface is renamed, the import will break tsc.

**Surprises:**
- `stream` mid-stream chunks are written directly via `pipeSocket.write(JSON.stringify({...}))` instead of `sendToDaemon()` (performance hot-path). Pattern 2 in `parseExtensionSentTypes` was needed specifically for this case.
- The 4 pre-existing failures in `tests/integration/main-composition.test.ts` are A8/N3 work — confirmed with `git stash` before/after comparison. Not caused by A7.
- No ADR drift found. All six inbound types in protocol.ts match their ADR-8/ADR-10/ADR-11 spec exactly. `authToken` (required, ADR-10) and `cwd` (optional, ADR-11) on `RegisterMessage` are correctly typed and documented additions to the ADR-8 base schema.
