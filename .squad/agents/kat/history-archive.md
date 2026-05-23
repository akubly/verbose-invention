# Kat — History (Summarized 2026-05-02)

## Identity & Role

- **Agent:** Kat (Bot Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Bot wiring, UX, Telegram command surface, message formatting
- **Joined:** 2026-04-12

## Key Accomplishments

### Phase 1–4 (2026-04-12 → 2026-05-01)

- Implemented `/new <name>`, `/list`, `/remove` command stack
- Fixed registry crash-safety (atomic `.tmp` → rename pattern)
- Added schema versioning (version: 1)
- Implemented session registry with duplicate-name tracking
- Built message relay handler (catch-all topic → session)
- Fixed chatId fallback guard
- Implemented `/resume <name>` command
- Fixed unit test surface (registry fixtures, mocks)

### Phase 5 (2026-05-02) — Persona Review

- **F2 (Name Uniqueness):** Enforce at registration via `SessionRegistry.register()` guard. Pre-existing on-disk duplicates preserved with warning.
- **F3 (Atomic Move):** Implemented `move(fromTopicId, toTopicId, sessionName, chatId, model?)` primitive with single `persist()` call and rollback guarantee on failure.

## Current State

- **Files:** `src/bot/index.ts`, `src/bot/handlers.ts`, `src/sessions/registry.ts`
- **Test coverage:** 245 tests pass; registry module at full coverage
- **Active commands:** `/new`, `/list`, `/remove`, `/resume`, catch-all relay
- **Constraints:** Layering clean (no relay imports in bot); atomic operations verified

## Phase 6+ Roadmap

### PR #5 Cycle 4 (2026-05-03) — Production Bug Fixes

- **H-A (Relay cache rekey):** `Relay.activeSessions` was still keyed by the old topic ID after `/resume` moved the registry entry. Added `rekeySession(fromTopicId, toTopicId): void` to `Relay` that pops the cache entry at `fromTopicId`, inserts it at `toTopicId`, and cancels the stale idle timer (whose closure referenced the old key). `/resume` handler now calls `relay.rekeySession(oldTopicId, topicId)` immediately after a successful `registry.move()`. Preserves unflushed in-memory state; no factory call on next message.
- **H-B (Registry write-first):** `move()` mutated `this.entries` before `await persist()`, letting concurrent reads observe uncommitted state. Replaced the mutate-then-rollback pattern with write-first: build a snapshot `Map`, call `persistSnapshot(snapshot)` (new private method queued via `writeQueue`), only then mutate `this.entries`. On failure, `this.entries` is never touched — no rollback needed. Extracted `doPersistEntries(entries)` shared by both `doPersist()` and `persistSnapshot()`.
- **Tests:** +7 new tests: `relay.test.ts` (3 — rekeySession happy path, no-op, old topic evicted), `resume.test.ts` (2 — rekeySession called on success, not called on failure), `registry.test.ts` (2 — write-first no mutation on failure, entries untouched during persist). Existing rollback test updated to spy on `doPersistEntries` and reflect write-first semantics. 267 → 274 passing; tsc and lint clean.



- **F-B (`findAllByName` + /resume duplicate guard):** Added `findAllByName(name): SessionEntry[]` to `ISessionRegistry` and `SessionRegistry`. `/resume` now calls `findAllByName`; if >1 match (legacy on-disk duplicates), refuses with a list showing all matching `topic #N (chatId C)` entries and instructs user to `/rename` or `/remove`. `findByName` kept for callers (like `/new`) that want first-match. 
- **F-C (`move()` atomic destination check):** Added destination-unbound guard at the top of `move()` — before any in-memory mutation — throwing `Destination topic N is already bound to "name"` if bound. Eliminates the TOCTOU window between `/resume`'s UX pre-check and the actual mutation. `/resume` catch block now detects `already bound to` in the error message and emits a clean ⚠️ (not the generic "Failed to resume") telling the user to `/remove` first.
- **Tests:** 10 new tests added across `registry.test.ts` (move destination-bound, findAllByName) and `resume.test.ts` (legacy duplicate refusal, clean error surfacing). All 245 + new tests pass; tsc and lint clean.


- **F2 (Name Uniqueness):** Enforce at registration via `SessionRegistry.register()` guard. Pre-existing on-disk duplicates preserved with warning.
- **F3 (Atomic Move):** Implemented `move(fromTopicId, toTopicId, sessionName, chatId, model?)` primitive with single `persist()` call and rollback guarantee on failure.

### PR #5 Cycle 5 (2026-05-03) — Registry Full-Transaction Serialization

- **I-A (mutationQueue):** The H-B write-first fix still had an await yield between `persistSnapshot()` and the `this.entries.delete/set` mutations. A concurrent `register()` or `remove()` could mutate `this.entries` during that yield; the move would then apply stale state on top, silently clobbering the concurrent change. Fixed by generalising `writeQueue` into a `mutationQueue` (`Promise<unknown>`) and adding `enqueueMutation<T>(op: () => Promise<T>)` that serialises the entire read→compute→persist→swap transaction. `register()`, `remove()`, and `move()` all go through `enqueueMutation`. Final in-memory update is `this.entries = newEntries` (atomic reference swap) — readers always see a fully-committed state. Removed now-dead `persist()`, `persistSnapshot()`, and `doPersist()` helpers; `doPersistEntries()` is the sole disk-write path.
- **I-C (JSDoc):** Updated `move()` JSDoc on `ISessionRegistry` to describe the new contract: serialised via mutation queue, builds snapshot, persists, atomic-swaps `this.entries`, no rollback path, throws on missing source / bound dest / persist failure.
- **Tests:** +3 new tests in `registry.test.ts`: (a) move() vs concurrent register() — execution log asserts serialisation order; (b) move() vs concurrent remove() — same; (c) atomic swap — spy captures state at persist time to prove the old map is still live before the swap, list() confirms complete new state after. 274 → 278 passing; tsc and lint clean.



- **Files:** `src/bot/index.ts`, `src/bot/handlers.ts`, `src/sessions/registry.ts`
- **Test coverage:** 245 tests pass; registry module at full coverage
- **Active commands:** `/new`, `/list`, `/remove`, `/resume`, catch-all relay
- **Constraints:** Layering clean (no relay imports in bot); atomic operations verified

## Phase 6 Roadmap

**Kat's scope (Phase 6 — Session 0 Control Plane + Data Plane Topics):**
1. Bot routing refactor (Days 3–5):
   - Split routing: General topic → `session0.ts`; forum topics → data-plane relay
   - Enforce mode gates: desktop mode rejects everything except `/afk`
   - Topic lifecycle: create on `/attach`, auto-archive on `/back` or CLI session death
   - Implement commands: `/afk`, `/back`, `/attach <session>`, `/kill` wired through mode gates
2. Registry semantics shift: **attach to existing CLI session**, not create Reach-owned SDK session
   - Drop name-uniqueness enforcement (CLI names authoritative)
   - Track lifecycle state (`attached` / `detached`)
   - Entry shape: `topicId → cliSessionId`

**Design:** Session 0 in General topic (permanent, command-only). Data-plane topics for attached CLI processes. Mode state machine (desktop ↔ AFK). MVP Week 1.

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
- **ADR-9 reconciliation (2026-05-22):** K2 was implementation-correct (internal AbortController, event-driven abort via session.disconnected — no injection needed; catalog overstated). K4 was a real bug: one shared AllowAlwaysStore across all sessions violated per-session isolation; fixed by creating fresh InMemoryAllowAlwaysStore per _makeSession call. K5 was a real gap: isDestructive/isKnownSafe existed but lacked `export` keyword; adding export unblocks Jun's classifier unit tests. Pattern to remember: when writing per-session state, always instantiate in the per-session factory method, not at composition root. Also: extension.mjs top-level side effects require vi.mock setup before importing named exports in vitest — surfaced as 4th issue for Jun.

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

