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

# Archive Snapshot — Kat History (2026-05-30T04:53:17Z)

**Reason:** File size 22221 bytes exceeded 15360 byte summarization threshold. Full history archived here.

---

## Learnings — 2026-05-28T23:25:16-07:00 — PR #7 Copilot Review Cycle 4: compensation timer leak + 3 nits

**Timer leak — `compensatePartialActivation` Promise.race:**
`compensatePartialActivation` used `Promise.race([closePromise, timeout])` where `timeout` was a bare `setTimeout`. When `closeForumTopic` won the race, the `setTimeout` was never cleared, leaving N pending timers attached to the event loop — one per binding in the fleet. The fix: capture `timeoutHandle` in the outer scope, call `.finally(() => clearTimeout(timeoutHandle))` on the race result. The timeout still fires correctly when `closeForumTopic` loses the race; it's just always cleaned up afterward.

**Invariant added:** "In `compensatePartialActivation`, always store the `setTimeout` handle and clear it in a `.finally()`. A bare `Promise.race` with a timeout promise leaks the timer when the non-timeout side wins."

**A6-6 tests tightened:**
Updated `vi.getTimerCount()` assertions from `FLEET_SIZE` to `0`. The old assertion accidentally documented the leak as "working correctly". The new assertion proves the production fix: all N timers are cancelled after compensation completes.

**env.ts fatal message (nit):**
Updated the deny-all guard message from `'allowedUserIds is empty'` to name both `TELEGRAM_ALLOWED_USER_IDS` (env var) and `telegramAllowedUserIds` (config.json) so the error is immediately actionable for operators.

**env.test.ts comment (nit):**
Updated stale comment `'N2 (backlog) test below'` → `'shipped N2 guard test below'` to reflect that the guard shipped in Phase 8.

---

## Learnings — 2026-05-28T23:25:16-07:00 — PR #7 Copilot Review Cycle 3: 4096-char cap + handleError isActive guard

**Thread A — Telegram 4096-char limit:**
`state.text` is an unbounded accumulator. If a long stream exceeds 4096 chars, every `sendMessage`/`editMessageText` call would return a 400 error and the stream would get permanently stuck. Empty `state.text` causes `sendMessage` to fail with a 400 on empty-body.

**Fix — `displayText()` helper + constants:**
- `TELEGRAM_MAX_TEXT = 4096` documents the API limit.
- `TELEGRAM_MAX_DISPLAY = 4000` is the safe display cap (headroom for the truncation prefix).
- `displayText(text)`: empty → `'…'`; within cap → passthrough; over cap → `TRUNCATION_PREFIX + text.slice(-bodyLen)` (last-N policy — streaming output's most recent content is what the user cares about).
- Applied to BOTH `sendMessage` (placeholder creation) and `editMessageText` in `handleChunk`. The full text is still accumulated in `state.text` unchanged; only the displayed slice is capped.

**Invariant added:** "displayText() must be used for every Telegram text argument in handleChunk — never pass `state.text` raw. The full buffer is kept in state; only the display slice is capped."

---

**Thread B — handleError race with deactivation:**
`handleChunk` guards with `isActive()` at entry, but `handleError` previously had no such guard. An error frame racing against `/back` could arrive after deactivation and emit a spurious `❌ Error` message in the now-closed topic.

**Fix:**
- After `this.streamStates.delete(key)` (unconditional — cycle-1 invariant), add `if (!this.deps.isActive()) return;`.
- State cleanup fires regardless; the Telegram send is skipped when AFK is off.

**Invariant added:** "In handleError, state cleanup (streamStates.delete) must always run unconditionally. The isActive() guard gates only the Telegram-side error emission — never the state cleanup."

---


**Thread 5 — handleChunk placeholder retry on transient sendMessage failure:**
If `sendMessage()` throws on the first chunk (rate limit, transient API error), the original code left `streamStates` with a fully-created `StreamState` entry but `messageId` still undefined. All subsequent chunks hit `else` (state already existed) and skipped the placeholder branch entirely, leaving the stream permanently stuck with no Telegram updates.

**Fix — two-part, both required:**
1. **Eager state init + retry guard:** Create `StreamState` unconditionally before any network call. Check `state.messageId === undefined` (not `!state`) to decide whether to create the placeholder. This means any chunk that finds `messageId` absent will retry the `sendMessage`, not just the very first chunk.
2. **Buffer before network:** Append `chunk` to `state.text` before calling `sendMessage`. If the send throws, `state.text` already contains the accumulated buffer. The next chunk retries `sendMessage` with the full buffer — no text is lost across retry attempts.

**Inner try/catch pattern:** The `sendMessage` call is wrapped in its own `try/catch` inside the outer `try/finally`. On failure it logs a warning and `return`s. The outer `finally` still fires — `done=true` cleans up as normal (stream terminating anyway); `done=false` leaves state intact for the next chunk.

**Invariant added:** "For handleChunk, chunk text must be appended to the buffer before any network call, and placeholder creation must be retried whenever `state.messageId === undefined`."

---

**Thread 1 & 2 — sessionRequestIds empty-Set leak (enqueueChunk / enqueueError):**
Deleting a requestId from a session's Set but never checking whether the Set is now empty leaves a stale `Set()` behind for every session that has ever streamed. Fix: extract `removeRequestId(sessionId, requestId)` that deletes the Set and its key together when size reaches 0. Both call sites now use the same helper — they stay in sync automatically.

**Thread 3 — handleChunk early-return skips done=true cleanup:**
Returning early when `getTopicId` is undefined mid-stream prevents the `finally { if (done) streamStates.delete(key) }` from running, leaking the state entry. Fix: resolve topicId as `streamStates.get(key)?.topicId ?? getTopicId(sessionId)` before the guard — existing state's topicId satisfies the check even after the binding is removed.

**Thread 4 — handleError early-return skips state deletion:**
Same shape as Thread 3: the early-return on undefined topicId prevented state cleanup for a terminating stream. Fix: delete state first (stream is done regardless), then derive topicId from `state?.topicId ?? getTopicId(sessionId)`. Telegram error send fires when a topicId is available; either way the state is gone.

**General pattern learned:** For any "stream terminating" path (done=true chunk, error), always delete state in a finally or unconditionally before topic-ID resolution — cleanup must not be gated on a live binding.

---

### 2026-05-24 — /afk Mode: 9 Telegram-Side UX & Bot API Opens Filed

Surfaced 9 pre-implementation opens for /afk machine-wide mode: topic burst rate-limiting, name disambiguation, General summary message, reopenForumTopic confirmed + unread-marker caveat, resume picker shape, spawn-from-Telegram repo source, slash-command relay intercept risk, concurrent permission prompt cross-topic notification, registry schema additions. Filed to inbox as kat-afk-mode-ux-opens.md.

---

### 2026-05-24 — /afk & /back Telegram-Side Capability Audit

Audited handlers.ts, prompt.ts, registry.ts, relay.ts for CLI-initiated AFK flow. Filed 6 gaps: no createForumTopic, no CLI→daemon control channel, no cwd/status registry fields, no AFK/back banners, no closeForumTopic on /back. 5 UX questions filed to inbox.

---

### 2026-05-24 — Dogfooding Kickoff: ADR-9 Reconciliation Finalized

K2, K4, K5 reconciliation notes merged into canonical decisions.md. K4 per-session AllowAlwaysStore bug fixed (code changed). Jun's 32 vitest scenarios now unblocked for Phase 7 test writing.

---

---

### 2026-05-19 — Phase 6 Day 1: install.ts Refactored (Summary)

Refactored `src/service/install.ts` for user-account service per ADR-5. Full details archived in `history-archive.md`. **Summary:** User-account service working, 22 tests pass, unblocked Phase 6 parallel work.

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

### 2026-05-22 — Phase 6 Days 3–4: Bridge Adapter (BridgeSession / BridgeSessionFactory) (Summary)

Complete. All 296 tests green. tsc + lint clean. Full Phase 6 Days 3-4 details archived in `history-archive.md`.

**Summary:** `BridgeSession`, `BridgeSessionFactory`, `CompositeSessionFactory` built per K1 spec. Key patterns: async-queue push-to-pull adapter, composition over config flags, typed event emitters via overloads.



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

### 2026-05-23 — Live Dogfood Bug Fix: Eager Prompt Registry Installation

**Bug:** `promptUserForPermission` crashed on first call with grammY error: "registering listeners on your bot from within other listeners". Reproduced when Aaron sent `bash echo "test" >> reach-test.txt` from Telegram — ADR-9 permissionCallback fired correctly, but the `bot.on('callback_query:data', ...)` call inside `ensurePromptRegistry()` was rejected because polling was already active.

**Root cause:** `ensurePromptRegistry(bot)` was called LAZILY from inside `promptUserForPermission()`, which runs inside an active grammY message handler. The `handlerInstalled.has(bot)` guard only helps on the second call — on the first call, the listener hasn't been registered yet, and grammY forbids `bot.on()` registration after polling starts.

**Fix:**
- Exported `ensurePromptRegistry` from `src/bot/prompt.ts` (was previously unexported).
- Called `ensurePromptRegistry(bot)` EAGERLY inside `registerHandlers()` in `src/bot/handlers.ts`, alongside the other `bot.command()` / `bot.on()` calls, gated on `permissionPolicy === 'interactiveDestructive'`.
- The dispose/recreate cycle behavior is preserved: `handlerInstalled` WeakSet ensures the listener is installed at most once per bot lifetime; `disposePromptRegistry` only clears the interval and registry map, not the listener.

**Tests added (handlers.test.ts):**
- Asserts `callback_query:data` listener is installed during `registerHandlers` (not lazily)
- Asserts it is NOT installed for non-interactive policies
- Asserts `bot.on` count stays at exactly 1 after the callback handler fires

**Result:** 413 tests pass, 4 skipped, 0 failed. `tsc` clean.



**Status:** Jun's 32-scenario vitest suite FULLY SHIPPED against reconciled implementation. 353 tests pass, 4 skipped, 0 failures. All K1–K6 assumptions verified:
- **K2:** BridgeSession abort controller wiring confirmed
- **K4:** Per-session AllowAlwaysStore isolation (real bug fixed — was shared)
- **K5:** extension.mjs named exports added (isDestructive, isKnownSafe)
- **K6:** Test harness vi.mock side effects documented

**Closes:** Loop on reconciliation. Implementation + test coverage both green. Ready for live dogfooding (Day 5+ per now.md).

---

### 2026-05-22 — Cloud Review Cycle 1: T2/T5 addressed (commit `689a547`)

- **T2** (`src/bot/prompt.ts:183`): Captured abort handler in named variable; `complete()` now calls `signal.removeEventListener` on every settlement path — listener leak closed.
- **T5** (`README.md:146`): Replaced hardcoded `\\.\pipe\reach-bridge` with ADR-10 description: randomized pipe name + `%LOCALAPPDATA%\reach\bridge-auth.json` discovery.
- **T8** (`README.md:145`): Removed incorrect "stops when you log off" claim. Windows Services run in Session 0, independent of interactive sessions — corrected to reflect that the daemon persists across logoff until machine shutdown or uninstall.
- **T10** (`src/bot/prompt.ts:67`): Added `scanHandle` to `PromptRegistry`; exported `disposePromptRegistry(bot)` to clear the interval and evict from WeakMap. Restructured `ensurePromptRegistry` to build map then interval then registry object. Two new tests verify one-interval-per-bot and dispose-clears-all behaviour.

**[2026-05-24] Scribe log entry:** Telegram-side UX opens merged into decisions. Registry schema additions defined (mode, afkSince, cwd, lastTopicId). Pre-implementation review complete.

---

### 2026-05-24T23:19:14-07:00 — Phase 7 AFK Mode State + Telegram Topics

Implemented daemon-owned AFK mode in `src/bot/afkMode.ts`: memory-only `{ active, since }`, session/topic maps, serialized topic create/reopen/close with 250ms gaps and 429 retry, General summary pin/edit, back banners, late-join registration augmentation, Telegram→CLI `mirror.input`, and stream routing to AFK topics.

Updated `SessionEntry` with required `cwd` plus `mode`, `afkSince`, and `lastTopicId`; registry registration defaults `cwd` to `process.cwd()`, legacy loads backfill it, and upsert persists AFK reflections. Added registry tests for cwd defaults/explicit values and AFK field round-trip.

Persona review follow-up: remote Telegram input is now gated to paired/allowed user IDs, blocked under `approveAll`, slash commands are ignored on the mirror path, stream cleanup is hardened, and topic queue/retry logic is clearer.

Validation: `npx tsc --noEmit`, `npm run lint`, targeted AFK contract tests, targeted registry tests, and full `npx vitest run --reporter=dot` all pass.

## 2026-05-25T06:19:14Z — Phase 7 Orchestration Complete

**Session:** Phase 7 implementation kickoff (Carter-4 + Kat-3 + Jun-1)

**Outcome:** Daemon-side AFK mode state machine (memory + schema updates) complete. Typecheck/lint/vitest green. Orchestration log: `.squad/orchestration-log/2026-05-25T06-19-14Z-kat-3.md`.

**Decisions merged to `.squad/decisions.md`:** `kat-phase7-mode-state.md` — session/topic maps, 250ms topic burst gap + 429 retry, registration augmentation, mirror.input routing, SessionEntry schema.

**Ready for:** Jun testing (contract tests bind to live AfkModeController) + Carter/Jun validation.

---

## Learnings — 2026-05-27T23:48:20-07:00 — Phase 8 N2: Deny-all guard landed

**Files changed:**
- `src/config/env.ts` — added the deny-all guard (6 lines) immediately after `allowedUserIdSet` is finalized in the config-layer `else if` branch (and after both branches, so it covers any future third path). The guard matches the surrounding style: `console.error` + `process.exit(1)`, same pattern as the env-var empty-string fatal above it.
- `tests/config/env.test.ts` — replaced the `N2 (backlog)` documentation test with an assertive test (`N2: exits with code 1 when config telegramAllowedUserIds is an empty array (deny-all guard)`). Updated header comment to reflect the item is no longer backlog.

**Placement subtlety:** The guard must sit AFTER both branches (`if TELEGRAM_ALLOWED_USER_IDS` and `else if config.telegramAllowedUserIds`) so it catches either path producing an empty set. The current code structure makes this straightforward — no edge cases required relocation.

**Boundary note:** Jun owns the env-var test variant for N2 (`TELEGRAM_ALLOWED_USER_IDS=,` corner case) and the N3 end-to-end integration test through `main()`. This entry covers only the production guard + direct unit test for the config-JSON path.

---

## Learnings — 2026-05-28T10:00:30-07:00 — Phase 8 F4: afkMode.ts soft refactor

**Trigger:** `afkMode.ts` hit 733 LOC, crossing the F4 watch threshold.
**Disposition:** Soft refactor (Aaron's choice) — no compensation extraction; honest subsystem split only.

**New file: `src/bot/afkStreamRouter.ts` (133 LOC)**

Extracted the complete stream routing subsystem out of `AfkModeController` into `AfkStreamRouter`:
- `StreamState` interface (private to module)
- `STREAM_EDIT_THROTTLE_MS` constant
- Three private maps: `streamStates`, `streamChains`, `sessionRequestIds`
- Four methods: `enqueueChunk` (was `enqueueStream`), `enqueueError` (was `enqueueStreamError`), `handleChunk` (was `handleStream`), `handleError` (was `handleStreamError`)
- Two lifecycle methods: `cleanupSession(sessionId)` (replaces inline 9-line O(1) cleanup in `handleDisconnect`) and `reset()` (replaces three `.clear()` calls in `deactivate` + activation rollback)

**Dependency injection pattern:** `AfkStreamRouter` takes a `deps` object with `getTopicId`, `isActive`, `bot`, and `chatId`. No imports back into `afkMode.ts` — dependency direction is clean (router → afkMode for `TopicBinding` is avoided by using a `getTopicId` callback instead of passing the full binding).

**Final LOC:**
- `src/bot/afkMode.ts`: 649 LOC (was 733; −84)
- `src/bot/afkStreamRouter.ts`: 133 LOC (new)

**Validation:** `npx tsc --noEmit` clean, `npx vitest run` 515 passed / 4 skipped / 0 failed, `npm run lint` 0 warnings.

**Constraint respected:** `compensatePartialActivation` stays inline in `afkMode.ts` — single caller, single failure-rollback path, no second compensation path yet.

**Architectural note filed to inbox** (see `kat-afkmode-refactor-insights.md`): the `allowMirrorInput` method + `mirrorRates`/`globalMirrorRate` fields form a second extractable subsystem ("mirror rate limiter") if the file grows again. Not acted on.

---

## Phase 8 Dogfood Plan (2026-05-29T21:53:17-07:00)

Noble Six synthesized comprehensive dogfood plan for Phase 8 validation. Plan includes 6 AFK mode scenarios validating:
- Auto-binding of new CLI sessions to active AFK fleet
- Fleet join/exit + relay re-targeting
- Mid-stream AFK deactivation (/back command)
- Topic creation burst serialization + 429 retry

**Staging:** Dogfood plan merged to decisions.md. Awaiting Aaron's execution (~45–90 min, success bar ≥13/16 scenarios).

**Note for Kat:** AFK mode controller ready. Plan validates F4 refactor stability and AFK/stream-router coupling under load.


