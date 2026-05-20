# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Test Engineer
- **Joined:** 2026-04-12T06:02:10.441Z

## Current Phase: Phase 5 — Telegram UX QoL Testing (2026-05-01–2026-05-02)

### What I'm Testing

**Feature 1: MarkdownV2 Escaping**
- 22 new unit tests in `tests/relay/markdownV2.test.ts`
- Real-world Copilot output tests: code review, HUD footer, mixed identifiers
- All tests GREEN ✅
- Contract locked: `escapeMarkdownV2(text: string): string`

**Feature 2: Message Splitting**
- 21 new contract-locking tests in `tests/relay/messageSplitter.test.ts`
- Tests define: boundary preferences, code block protection, spanning blocks, two-pass numbering, footer overhead
- All tests RED (expected — awaiting Carter's Wave 2 implementation)
- Contract locked: `splitForTelegram(text, opts?): string[]`

**Feature 3: /resume Command**
- 13 new tests in `tests/bot/resume.test.ts`
- All 7 edge cases covered: forum topic requirement, name validation, move semantics, model carry-forward, conflicts
- All tests GREEN ✅ (Kat's implementation complete)

### Testing Strategy

**TDD Approach:** Write contract tests first; tests define implementation requirements.

**Real-world cases:** Beyond unit tests, include actual Copilot output patterns (code blocks, formatting, escaping edge cases).

**No brittleness:** Tests are stable, resistant to minor refactoring, and focus on behavior not implementation details.

### Current Status

- Total Phase 5: 56 tests added (22 + 21 + 13)
- 235 tests pass overall (up from 198)
- All MarkdownV2 + /resume tests GREEN ✅
- All message splitter tests RED (contract ready for Wave 2)
- tsc clean, lint clean

## Recent Learnings (Active)

### 2026-05-01 — Phase 5: Contract-Locking Tests

Wrote comprehensive test suites for all three Phase 5 features before implementation.

**MarkdownV2 tests** (22 tests):
- Plain text escaping, inline code, code blocks, unclosed fences, mixed content
- Real-world Copilot output: code review with escaped headings, HUD footer, mixed identifiers
- Helper test: `needsEscaping()` boolean checker

**Message splitting tests** (21 tests):
- Boundary preference order: `\n\n` > `\n` > whitespace > hard cut
- Code block never split mid-block; split at line boundaries
- Spanning block detection and handling
- Two-pass numbering: `[n/total]\n` only when total > 1
- Footer overhead reserved from last chunk
- No empty chunks produced

**Resume tests** (13 tests):
- Must be in forum topic; usage errors
- Name validation and lookup (with fuzzy matching)
- Already bound, conflict detection, move semantics
- Model carry-forward from original entry

### 2026-05-02 — Phase 5 Complete (Team Update by Scribe)

Phase 5 testing complete. All decisions merged to `decisions.md`; inbox cleared. 235 tests pass, tsc clean, lint clean.

**Jun's contributions:**
1. MarkdownV2 real-world tests (3 added to Carter's base suite) — all GREEN
2. Message splitter contract tests (21, all RED as expected) — locking implementation requirements
3. /resume tests (13, all GREEN) — Kat's implementation complete

**Coordination:** TDD approach ensured contract clarity before implementation. All three feature tests integrated smoothly.

**Next phase:** Ready for production. Monitor test suite as features stabilize.

## Phase 6 Roadmap

**Jun's scope (Phase 6 — Session 0 Control Plane + Data Plane Topics):**
1. Integration tests (Days 3–5):
   - Mode transitions: desktop ↔ AFK ↔ data-plane
   - Attach/detach cycles: CLI session discovery, topic creation, cleanup on death
   - Graceful degradation: failure paths when discovery unavailable, CLI session dies mid-conversation
   - State machine coverage: all transitions tested
2. Test-first approach (Days 1–2):
   - Write test skeletons for proposed interfaces (discovery, session0 router, attach/detach)
   - Lock contracts before implementation

**Design:** Test state machine + failure paths. MVP Week 1.

### 2026-05-09 — Phase 6 Spike Complete (Carter)

**Spike status:** Days 1–2 complete. Q1 SOLVED. Q2 BLOCKED awaiting Aaron decision.

**Outcomes affecting Jun:**
- **Q1 Discovery:** SDK `client.listSessions()` API works. No breadcrumbs needed. Contract: `sdk.listSessions(filter?) → SessionMetadata[]`
- **Q2 Attach:** Blocked on port discovery gap. If MVP ships `/attach`, needs special config + CLI coordination. If MVP drops `/attach`, simpler state machine (no bidirectional attach case).
- **Recommendation:** MVP ships `/list` + `/new` only; test attach/detach as Phase 6 stretch item.

**Impact on Jun's integration tests:**
- If MVP drops `/attach`: test suite focuses on mode transitions (desktop ↔ AFK), `/new` happy path, CLI discovery contract
- If MVP ships `/attach` with config: add config validation tests, port fallback tests, CLI discovery with `--ui-server` availability check
- Graceful degradation tests (discovery unavailable, CLI death) are the same

**Aaron's decision point:** Which scope for Phase 6 MVP? (1) Drop `/attach`, or (2) Ship with config-based port?

## Archive

Earlier learnings (before 2026-05-01) are archived in `history-archive.md` for reference.

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

**Impact on Jun's Phase 6 integration tests:**
- **Option A:** Test scope: mode transitions (desktop ↔ AFK), `/new` happy path, CLI discovery contract, graceful degradation.
- **Option B:** Add extension registration tests, named pipe communication tests, `/attach` inject/stream cycle tests, reconnection handling.

**State machine contracts:** Same in both options (desktop ↔ AFK transitions independent of `/attach`).

**Recommendation:** Option A for MVP (cleaner test scope); Option B as first post-MVP feature.

---

## Learnings

### 2026-05-19 — Phase 6 Test Impact Assessment: Extension-Bridge Architecture

**Trigger:** Aaron requested a full test-impact assessment after the extension-bridge architecture was proposed (Carter spike 2026-05-09). Original Phase 6 scope assumed one process boundary; extension-bridge introduces three.

**Key findings:**

- **Scope delta: +93%** (~6.75 days vs ~3.5 days original). Option A (no extension bridge) restores the original 3.5-day scope.
- **New test surface:** Daemon-extension named pipe protocol is fully contract-testable (JSON schema). Daemon-side handlers are unit-testable with mock sockets. Extension-side unit tests need SDK stubs — verify stubs work before committing to estimates.
- **CI-able boundary:** Daemon named pipe integration tests *can* run in CI on `windows-latest`. Full attach E2E (real CLI + SDK auth) cannot. This requires a new `windows-latest` CI matrix entry.
- **Highest-risk edge case (EC-08):** Extension installed, daemon not running. If the extension throws an unhandled rejection on pipe connect failure, it impairs *every* CLI session on the machine. This must be caught before anything else.
- **Three blockers for Noble Six before implementation can start:**
  1. Named pipe security model (cross-integrity-level access: Admin CLI vs LocalSystem daemon)
  2. Extension reconnect policy (does `extension.mjs` retry after daemon restart?)
  3. Heartbeat/ping-pong required for reliable dead-extension detection (OS pipe teardown timing is unreliable on Windows after hard kill)
- **Day 1–2 deliverables (regardless of Noble Six decisions):** `FakeDaemon` and `FakeExtensionClient` test doubles, plus the JSON-Lines contract schema. These unblock all other Phase 6 tests.

**Decision drop:** `.squad/decisions/inbox/jun-phase6-test-impact.md`

---

### 2026-05-19 — Phase 6 Architecture LOCKED

**Event:** All architectural blockers resolved per Aaron's directive. Phase 6 architecture finalized with seven ADRs (ADR-1 through ADR-7).

**Key points for Jun:**
- **ADR-6 + ADR-7:** Extension reconnect policy and heartbeat protocol now locked, enabling deterministic test specifications
- **Day 1 task:** Build test doubles — `test/helpers/FakeDaemon.ts` (spawns random pipe, accepts connections, sends/receives messages) and `test/helpers/FakeExtensionClient.ts` (connects to pipe, sends hello, responds to ping, exposes message log)
- **Implementation order:** Can start immediately with no blocking data dependencies. Same start time as Carter (named pipe server) and Kat (install.ts refactor)
- **Deterministic testing:** ADRs specify exact backoff timings, ping intervals, and grace periods. Jun can now write contract tests for reconnection edge cases without guessing.

See `.squad/decisions.md` for full ADRs and implementation sequencing.

---

### 2026-05-19 — Phase 6 Day 1: Test Doubles Built and Verified

**Event:** Completed Day 1 deliverable — `FakeDaemon` and `FakeExtensionClient` test doubles.

**Deliverables:**
- `tests/helpers/FakeDaemon.ts` — In-process daemon stand-in. Pure in-memory PassThrough stream transport (no actual named pipe). Accepts multiple client connections, parses JSON-Lines, tracks all inbound messages, drives ADR-7 heartbeat (`startHeartbeat()` / `stopHeartbeat()`), models fast-path pipe teardown (`disconnectSession()`). Full assertion API: `messagesFrom()`, `messagesOfType()`, `isRegistered()`, `isUnreachable()`.
- `tests/helpers/FakeExtensionClient.ts` — In-process extension stand-in. Connects to `FakeDaemon` via `connect(daemon)`, sends `hello` / `pong` / `stream` / `stream.error` messages, auto-responds to pings (disableable via `setPingAutoRespond(false)` for dead-extension tests). Full assertion API: `sent`, `received`, `sentOfType()`, `receivedOfType()`.
- `tests/helpers/fakePipe.smoke.test.ts` — 15-test smoke suite exercising both doubles against each other. All 15 passing ✅.

**Key implementation note — synchronous transport race:**
PassThrough streams deliver data synchronously. In `_sendHeartbeat()`, the pong-deadline `setTimeout` handle **must** be registered in `pendingPings` *before* calling `_writeTo()`. If registered after, the auto-pong arrives (synchronously, within the same call stack as the push) and tries to `clearTimeout` an entry that doesn't exist yet — the orphaned timer then fires and incorrectly marks the session unreachable. Fixed by reordering: `pendingPings.set(pingId, pongDeadline)` → `_writeTo(record, ping)`.

**Key implementation note — fake timer scope:**
`vi.useFakeTimers()` fakes `setImmediate` by default, which blocks readline's internal 'line' event scheduling. Tests must use `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })` to keep `setImmediate` real while still controlling heartbeat/backoff timing.

**Coordination output:**
- `.squad/decisions/inbox/jun-test-doubles-contract.md` — Full message schema for Carter to confirm alignment with `extensionBridge.ts` / `extension.mjs`.

**Verification:**
- `npx vitest run` → 296 passed, 4 skipped, 0 failed ✅
- `npx tsc --noEmit` → clean ✅
- `carter-pipe-protocol.md` not present at build time; TODOs left at top of both doubles files.

### 2026-05-19 — Phase 6 Day 1: Protocol Reconciliation — ADR-8 Canonical Schema

**Event:** Noble Six reconciled protocol drift between Carter (extensionBridge.ts) and Jun (FakeDaemon).

**What happened:**
Both implementations were correct interpretations of ADR-3 (framing locked; message shapes not specified). Jun's test doubles converged on a streaming protocol (`inject`/`stream`/`requestId`/`chunk`/`done`) while Carter designed a single-shot protocol (`session.command`/`session.command-result`).

**ADR-8 Decision:**
Adopt Jun's streaming schema as canonical because:
1. **Streaming UX:** Phase 5 built real-time Telegram placeholder editing (800ms intervals). Buffering the entire response (Carter's design) destroys this.
2. **Request correlation:** Jun's `requestId` field is critical for correlating response chunks to the original message injection.
3. **Terminology:** Jun's `hello` aligns with ADR-2/ADR-6; `session.registered` namespacing improves clarity in multiplexed protocol.

**Impact on Jun:**
Day 2 migration = 1 addition: add `session.event` to `InboundMessage` union (forward compatibility). Already passing default handler (unknown types are logged). No behavior change.

**Status:** ADR-8 locked in `decisions.md`. Day 2 changes trivial. Full 296-test suite will remain green post-Carter migration.

See orchestration logs for full technical details and Carter's migration tasks.