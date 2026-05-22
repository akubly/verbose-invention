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


## Phase 6+ Roadmap (Future)

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


