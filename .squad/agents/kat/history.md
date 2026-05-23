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




### 2026-05-22 — Review-Cycle 1: I10 toolName Sanitization

**Finding:** I10 (Security persona) — `toolName` from the extension was interpolated unsanitized into the Telegram permission prompt. RTL overrides, null bytes, and homoglyphs could spoof the user about which tool was being approved.

**Decision:** Option (b) — sanitize + warn. Replace disallowed chars with `_`, truncate to 128 chars, emit `console.warn` for observability. Rejected option (a) (hard-deny) to avoid blocking legitimate SDK tools with unusual naming.

**Where:** `BridgeSession._handlePermissionRequest` — daemon-side, before the allow-always store lookup and permissionCallback call. `sanitizeToolName()` added to `bridgeSession.ts`.

**Allowlist regex:** `/^[a-z_][a-z0-9_.:-]{0,127}$/i` — covers all known SDK tool name formats.

**Tests:** 7 new cases in `tests/bridge/permission-toolname-sanitize.test.ts`. Full suite: 363 passed, 4 skipped. tsc + lint clean. Commit: `2c6b63f`.

**Learnings:**
- For display sanitization, prefer the replace-and-warn pattern over hard-reject when the allowlist might be imperfect — keeps the system operational while making anomalies observable.
- Place input validation as close to the untrusted source as possible (the bridge handler), not at the rendering layer, so all downstream code always sees clean data.

---

### 2026-05-23 — ADR-9 Reconciliation Complete + Jun's Test Suite Green

**Status:** Jun's 32-scenario vitest suite FULLY SHIPPED against reconciled implementation. 353 tests pass, 4 skipped, 0 failures. All K1–K6 assumptions verified:
- **K2:** BridgeSession abort controller wiring confirmed
- **K4:** Per-session AllowAlwaysStore isolation (real bug fixed — was shared)
- **K5:** extension.mjs named exports added (isDestructive, isKnownSafe)
- **K6:** Test harness vi.mock side effects documented

**Closes:** Loop on reconciliation. Implementation + test coverage both green. Ready for live dogfooding (Day 5+ per now.md).
