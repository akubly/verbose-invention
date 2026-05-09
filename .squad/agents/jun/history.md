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

