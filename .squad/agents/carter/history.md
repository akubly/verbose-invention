# Carter — History (Summarized)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, named-pipe bridge
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Days 1–2 COMPLETE** (bridge plumbing + protocol migration). **Phase 6 Days 3–4 COMPLETE** (bridge integrated with relay adapter via Kat + Jun). Core bridge ready for production testing.

Test suite: 316 passed / 4 skipped / 0 failed ✅

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

See `history-archive.md` for earlier phases and spike methodology.

---

## Archive

Full Phases 1–5 and Phase 6 spike details in `history-archive.md`.
