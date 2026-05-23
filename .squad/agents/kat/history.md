### 2026-05-09 — Phase 6 Spike Complete (Carter)

**Spike status:** Days 1–2 complete. Q1 SOLVED. Q2 BLOCKED awaiting Aaron decision.

**Outcomes affecting Kat:**
- **Q1 Discovery:** SDK `client.listSessions()` works today (HIGH confidence). No breadcrumbs needed.
- **Q2 Attach:** Blocked on port discovery. True bidirectional attach requires CLI in `--ui-server` mode + port written to disk (gap found: no port file exists today).
- **Recommendation:** MVP ships `/list` + `/new` only; `/attach` deferred as Phase 6 stretch item (or ship with config-based workaround).

**Impact on Kat's implementation (session0.ts routing):**
- If MVP drops `/attach`: implement `/afk`, `/back`, `/new`, `/list` only (no `/attach` handler)
- If MVP ships `/attach` with config: `/attach` routes to relay with `cliUrl` from config (relay changes required, not bot)
- Mode state machine (desktop ↔ AFK) unchanged; `/attach` becomes optional endpoint

**Aaron's decision point:** Which scope for Phase 6 MVP? (1) Drop `/attach`, or (2) Ship with config-based port?

---

### 2026-05-09 — Phase 6 Spike Follow-Up (Extension API Viability)

**Spike status:** COMPLETE. Extension API confirmed viable for session bridging.

**Key findings from Carter:**
- **Extension API CONFIRMED:** `@github/copilot-sdk@0.2.2` exports `joinSession()`, `session.send()`, `session.on()`. Production-ready.
- **Port-discovery gap eliminated:** Extension runs as forked child with JSON-RPC/stdio to CLI. No `--ui-server` port file needed.
- **Attach bridge:** Bidirectional `/attach` to live desktop sessions possible via extension bridge (named pipe/loopback socket to daemon).
- **Setup:** Single install to user extensions dir; automatable in `reach install`.
- **Effort:** ~2 days on top of MVP.

**NEW DECISION for Aaron:**
- **Option A (Original MVP):** `/list` + `/new` only. 
- **Option B (Extended MVP):** `/list` + `/new` + `/attach` via extension bridge.

**Impact on Kat's Phase 6 implementation:**
- **Option A:** Skip `/attach` handler; focus on `/afk`, `/back`, `/new`, `/list`, mode state machine.
- **Option B:** `/attach` handler wires to extension-based relay (relay changes, not bot layer). Same mode state machine.

**Session 0 routing unchanged.** Mode state machine (desktop ↔ AFK) independent of `/attach` availability. Extension approach is cleaner architecture than config-based port workaround.

**Recommendation:** Option A for MVP (cleaner scope); Option B as first post-MVP feature.

---

### 2026-05-22 — ADR-9 ACCEPTED: K1–K6 Unblocked

**Status:** ADR-9 (Permission Prompting Over the Bridge) transitioned from PROPOSED → **ACCEPTED**. All 5 open questions settled.

**What this unblocks for Kat:**

| Task | Scope | Status |
|---|---|---|
| K1: Wire protocol extensions | ~80 LOC in `extensionBridge.ts` | **READY NOW** |
| K2: BridgeSession routing | ~70 LOC in `bridgeSession.ts` | **READY NOW** |
| K3: AbortSignal + timeout removal | ~15 LOC in `ports.ts` + `prompt.ts` | **READY NOW** |
| K4: AllowAlwaysStore interface | ~30 LOC in new file + factory | **READY NOW** |
| K5: Extension permission handling | ~60 LOC in `extension.mjs` | **READY NOW** |
| K6: Prompt text + observability | ~20 LOC | **READY NOW** |

**Total new code:** ~275 LOC across 5 files + new `allowAlwaysStore.ts`.

**Key decisions (all locked):**
- **Q1:** Inline keyboard buttons (supports concurrent prompts)
- **Q2:** Per-session in-memory AllowAlwaysStore (injectable interface; Phase 7+ upgrade to persisted)
- **Q3:** AbortSignal on `PermissionPrompter.prompt()` (mandatory for disconnect-abort safety)
- **Q4:** **NO TIMEOUT** (Branch A) — verified by Carter (SDK has no internal timeout)
- **Q5:** Extension classifies destructive tools (eliminates split-brain)

**Zero technical blockers.** Implementation can proceed immediately.

---


---

### 2026-05-23 — Phase 6 ADR-9 K1–K6 Reconciliation (Jun Flags 3 Implementation Assumptions)

**Status:** Implementation complete and verified. Jun's revised test catalog flagged 3 assumptions for whitebox test compatibility:

**ASSUMES IMPLEMENTATION (reconciliation required before Jun writes vitest files):**
1. **K2 — Constructor injection of AbortController**  
   `BridgeSession` must accept `AbortController` at construction (not self-construct). Jun's tests will inject and call `.abort()` directly to simulate session disconnect for C2-01–C2-03 abort tests.

2. **K4 — Per-session store instantiation**  
   `BridgeSessionFactory` must construct new `InMemoryAllowAlwaysStore()` per `BridgeSession`. Jun's C6-04 multi-session store-isolation test verifies no cross-session leakage (security contract).

3. **K5 — Named function exports**  
   `extension.mjs` must export `isDestructive(toolName: string): boolean` and `isKnownSafe(toolName: string): boolean` as standalone named functions. Jun's C4-05 and C6-05 tests call these directly for classifier unit tests.

**Action:** Verify implementation against these three points. Reply to Jun in her history.md once verified. Unblocks: Jun writes all 32 vitest scenario files.

---

### 2026-05-22 — Phase 6 Permission Prompting (K1–K6) Complete

**Status:** Complete. All K1–K6 tasks implemented. 321 tests pass / 4 skipped / 0 failed. tsc + lint clean.

**What shipped:**

- **K1 — `src/relay/ports.ts`:** `PermissionPrompter.prompt()` now accepts `signal?: AbortSignal`. Backward compatible — SDK path ignores it. Updated `PermissionPromptCallback` in `factory.ts` to match.

- **K2 — `src/bridge/bridgeSession.ts`:** `BridgeSession` gains optional `BridgeSessionPermOptions` constructor param. Wires `permission.request` / `permission.cancelled` / `session.disconnected` bridge events to the permission control-plane. Per-session `AbortController` aborts all in-flight prompts on disconnect. Per-permission `AbortController` supports `permission.cancelled` abort. `raceAbortSignals()` helper merges both signals without `AbortSignal.any()`. Listeners self-clean on `session.disconnected` to prevent listener accumulation.

- **K3 — `src/bot/prompt.ts`:** Removed `setTimeout`, `timeoutHandle`, `timeoutPromise`, `Promise.race`, `timeoutMs` param. Added `signal?: AbortSignal` wiring. Renamed `'timeout'` outcome → `'aborted'`. Updated prompt text: "Approve or deny — waiting for your decision." Added `createdAt: number` to `PendingPrompt`. Added passive 10-minute stale-prompt scanner (setInterval, `unref()`'d).

- **K4 — `src/bridge/allowAlwaysStore.ts`** (new file): `AllowAlwaysStore` interface + `InMemoryAllowAlwaysStore` class. Injected into `BridgeSessionFactory` constructor and `main.ts` composition root.

- **K5 — `src/bridge/extensionBridge.ts`:** Added `PermissionRequestMessage`, `PermissionCancelledMessage` (inbound), `PermissionResponseMessage` (outbound). Extended `BridgeEmitter` and `ExtensionBridge` with `permission.request` / `permission.cancelled` event overloads. Added `sendPermissionResponse(sessionId, permissionId, decision)` method. Added validation + dispatch in `handleLine()`.

- **K6 — `extension.mjs`:** Added `DESTRUCTIVE_TOOLS` / `SAFE_TOOLS` sets + `isDestructive()` / `isKnownSafe()` (mirrors `permissions.ts`). Registered `session.onPermissionRequest` hook — forwards only destructive tools as `permission.request`. Awaits `waitForPermissionResponse(permissionId)` indefinitely (no timer). `abortPendingPermissions()` denies all in-flight on pipe close. `currentRequestId` tracking for context.

**Test updates:** `prompt.test.ts` updated — removed `timeoutMs` param, replaced timeout test with 2 AbortSignal tests.

**For Jun:** Categories 1, 3, 4, 5 scenarios should pass as-is. Category 2 (formerly timeout) scenarios need updating to use `abortPendingPermissions()` / session disconnect patterns. The new `emitPermissionRequest()`, `emitPermissionCancelled()`, `emitDisconnected()` helpers on `FakeBridge` support new test scenarios directly.

## Learnings

- HUD footer with repo/branch/model metadata
- Two-tier permissions (auto-approve safe, prompt destructive)
- Session export to Markdown
- Conversational Session 0 (Phase 7)

## Learnings

- Registry needs both atomic writes and post-load duplicate tolerance for backward compatibility
- Single-purpose command semantics demand unique session names (no disambiguation prompts)
- Move() primitive critical for session transfer UX (vs two-step remove+register race)
- Extension-bridge gives a clean disconnect signal on CLI death (named pipe EOF/reset) — heartbeat not needed for normal exits, only for frozen/hung process detection
- `/kill` needs a `source: 'spawned' | 'bridged'` registry field to route to SIGTERM (owned) vs. pipe-based shutdown (bridged)
- Topic creation and relay bind must be sequenced: create topic only AFTER successful attach(), not before — avoids zombie topics on attach failure
- Extension registers on every CLI startup including desktop mode; daemon's live-session map updates silently in background — mode gate in session0.ts must suppress all Telegram-facing output while in desktop mode

### 2026-05-19 — Phase 6 Bot-Side Impact Assessment (Extension-Bridge)

Completed impact assessment for Carter's extension-bridge architecture. Key findings:
- `/list` simplifies (authoritative daemon live map replaces lock-file polling)
- `/attach` is now actually implementable in Phase 6 (was blocked before extension-bridge)
- `/kill` grows slightly: dual kill paths (owned PID vs. named pipe shutdown)
- 4 new failure modes defined (F1: extension not installed, F2: stale session, F3: duplicate name disambiguation, F4: bridge connect failure)
- Net effort: approximately equivalent to original Phase 6 scope, ~+0.5 day for error UX
- Blocking: Aaron's Option A vs. Option B decision — everything sequences from that
- Assessment dropped to: `.squad/decisions/inbox/kat-phase6-bot-impact.md`

---

### 2026-05-19 — Phase 6 Day 1: install.ts Refactored to User-Account Service (ADR-5)

**Task:** Refactor `src/service/install.ts` to install the Reach daemon as the logged-in user, not NetworkService/LocalSystem.

**Implementation:**

- Added `ServiceAccount` interface (`username`, `domain`, `password`).
- `createService()` now accepts optional `account?: ServiceAccount`. When provided, sets `logOnAs` in the node-windows config with `{ domain, account, password }` and `allowServiceLogon: true`. When omitted (uninstall path), no `logOnAs` is written.
- Added `resolveCurrentUser()`: uses `os.userInfo().username` + `process.env.USERDOMAIN`. Never calls `LookupAccountName`.
- Added `promptPassword()`: readline-based with `_writeToOutput` override to suppress echo.
- `install()` is now `async` — resolves user, prompts password, passes `ServiceAccount` to `createService()`.
- `main()` is now `async`, wraps top-level call in `.catch()`.
- README Windows Service section updated to reflect user-account logon and one-time password prompt.

**Trade-off:** `node-windows` requires a real Windows password for user accounts (SCM API constraint). Password-less path via Scheduled Task was rejected — different restart semantics and would drop node-windows. ADR-5 pre-accepted this cost.

**Tests:** All 22 install tests pass. Full suite: 296 passed, 4 skipped. tsc and lint clean.

**Decisions:** `kat-service-host.md` dropped to inbox. Carter (pipe server) notified that the named pipe will now be created in user-session context — no protocol changes needed.


**Event:** All architectural blockers resolved per Aaron's directive. Phase 6 architecture finalized with seven ADRs (ADR-1 through ADR-7).

**Key points for Kat:**
- **ADR-5:** Daemon runs as logged-in user (not LocalSystem) — fixes the `LookupAccountName failed: 1332` bug in install.ts
- **Day 1 task:** Refactor `src/service/install.ts` to prompt for user account + password, use `whoami /upn` primary or `wmic` fallback
- **Implementation order:** Can start immediately with no blocking data dependencies. Same start time as Carter (named pipe server) and Jun (test doubles)


See `.squad/decisions.md` for full ADRs and implementation sequencing.

---

### 2026-05-19 — Phase 6 Day 1: Team Sync — ADR-8 Protocol Reconciliation

**Event:** Phase 6 Day 1 parallel tasks completed. Noble Six reconciled protocol drift between Carter and Jun via ADR-8.

**What happened:**
Carter and Jun designed independently and converged on different message protocols (both valid per ADR-3). ADR-8 resolves this by adopting Jun's streaming schema as canonical.

**Impact on Kat:**
No changes to `install.ts`. The refactored install.ts (user-account service) is orthogonal to the pipe protocol work and already complete. Kat is now available for Days 2–4 relay integration support if needed.

**Status:** Kat's Day 1 deliverable is complete and verified. No regressions. Ready for Phase 6 continued.

See orchestration logs and `decisions.md` for full ADR-8 technical details.

---

### 2026-05-22 — Phase 6 Days 3–4: Bridge Adapter (BridgeSession / BridgeSessionFactory)

**Status:** Complete. All 296 tests green. tsc + lint clean.

**What was built:**

- **`src/bridge/bridgeSession.ts`** — `BridgeSession implements CopilotSession`. Adapts the bridge's
  push-event model (`stream` / `stream.error`) into `AsyncIterable<string>` using an async-queue
  pattern. The key insight: push listeners into a queue + `wake()`, drain queue in generator loop,
  re-check after setting `signal` to close the race window between empty-queue check and `await`.
  `try/finally` guarantees `bridge.off()` on normal completion, error, AND early iterator abandonment.

- **`src/bridge/bridgeSessionFactory.ts`** — `BridgeSessionFactory implements CopilotSessionFactory`.
  `resume()` returns `BridgeSession` if extension has registered the session by name, `null` otherwise.
  `create()` throws if not registered (bridge sessions are extension-created, not factory-created).
  `resetForRestart()` is a no-op per ADR-6.

- **`src/bridge/compositeSessionFactory.ts`** — Bridge-first, SDK-fallback composite factory.
  `resume()` tries bridge first, falls back to SDK. `create()` uses bridge if session is live,
  SDK otherwise. Enables graceful coexistence of CLI-attached and Reach-spawned sessions.

- **`src/bridge/extensionBridge.ts`** (minor edit) — Added `sessionName` to `InternalConnection`
  (stored from `hello` message) and `getSessionByName()` method. Required to map relay's
  human-readable `sessionName` to bridge's internal `sessionId`-keyed sessions map.

- **`src/main.ts`** (wiring) — Starts bridge before relay wiring; gracefully falls back if pipe
  is unavailable. Composite factory injected. `sdkFactory` kept as separate reference for shutdown.

**Composition decision:** Option A (composite factory) over Option B (env flag). See decisions inbox.

**Async-queue gotchas to remember:**
1. The race window: between `queue.length === 0` check and `signal = r`, new items can arrive.
   Fix: after `signal = r`, re-check `queue.length > 0` and immediately resolve if true.
2. Last-chunk semantics: ADR-8 `done: true` frames can carry a non-empty `chunk`. Handle both
   in the same listener call (push chunk item then done item).
3. Listener cast: `bridge.off()` takes `(...args: unknown[]) => void`. Typed listeners must be cast.
   Store typed aliases and cast only at `off()` callsites.
4. `sendFn` separation: Constructor takes `sendFn` separate from `bridge` for testability.
   The factory passes `bridge.sendCommand.bind(bridge)`; tests can pass a simple mock.

**Known gap:** Permission prompting over the bridge is unimplemented (TODO ADR-9?). Bridge sessions
ignore `permissionCallback` — the CLI extension handles permissions locally. Documented in decisions inbox.

**For Jun:** BridgeSession public API exactly matches K1 spec:
- Constructor: `(bridge: BridgeEmitter, sessionId: string, sendFn: (sid, text) => string | false)`
- `send(text: string): AsyncIterable<string>`
- Listener cleanup via `try/finally` with `bridge.off()` cast



**Status:** Complete. All bridges migrated to ADR-8 canonical schema. 296 tests green.

**What happened:**
- **Carter:** 8 mechanical migration changes (extensionBridge.ts + extension.mjs) to ADR-8 schema completed
- **Jun:** SessionEventMessage type added to InboundMessage union for forward compatibility
- **Decisions merged:** 2 inbox records (sendCommand API, session.event shape) → decisions.md
- **Archive:** Old decision entries (>7d) purged from decisions.md per archival threshold

**Impact on Kat:**
No action required Day 2. `sendCommand()` now returns `requestId` (or `false`) instead of `boolean`. This is internal to the bridge layer; Kat's relay integration (Days 3–4) will consume the `requestId` for correlating incoming `stream` chunks to pending Telegram message edits.

**Key outcome:** Protocol drift is fully resolved. All three code paths (bridge + test doubles + relay) now speak ADR-8 schema. Relay integration can proceed with confidence.

**Baseline preserved:** 296 passed / 4 skipped / 0 failed ✅

---

### 2026-05-22 — Phase 6 Day 5: ADR-9 (Permission Prompting) Drafted — Implementation Gates Pending

**Event:** Noble Six drafted ADR-9 and Jun drafted 29-scenario test catalog. Both deliverables in decisions.md.

**ADR-9 Summary:**
- **Problem:** `BridgeSession` silently discards `permissionCallback` — destructive tools execute without user consent
- **Decision:** In-stream interleaving on existing pipe (ADR-3). 3 new message types: `permission.request` (ext→daemon), `permission.response` (daemon→ext), `permission.cancelled` (ext→daemon)
- **Status:** PROPOSED — awaiting Aaron's decisions on 4 open questions

**4 Open Questions (Aaron must decide):**
1. Telegram UX shape (reply-keyboard vs. inline buttons vs. free-text commands)
2. Default `timeoutMs` (30s proposed for dogfooding)
3. `allow-always` scope (per-session/per-tool in-memory vs. persisted)
4. Risk classification ownership (extension or daemon)

**Impact on Kat:** Permission-prompting implementation is **GATED** on ADR-9 resolution. Cannot start until Aaron locks these 4 decisions. All implementation work (§10 in ADR-9) is spelled out for when gates open.

**Test scenarios ready:** Jun's 29-scenario catalog + test doubles contract waiting for protocol finalization.

**Blocking:** Production dogfooding cannot proceed without permission prompting. This is the gating issue for Phase 6 MVP completion.


