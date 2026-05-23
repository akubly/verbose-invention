# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions.
- **Role:** Test Engineer
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Days 3–4 complete:** Shipped 20 bridge adapter tests (BridgeSession, factory, relay-integration). Test suite: 316 passed / 4 skipped / 0 failed ✅.

---

## Phase 5 (2026-05-01–2026-05-02) — Summary

Wrote contract-locking test suites for three features:
- **MarkdownV2 escaping:** 22 tests (escapeMarkdownV2 contract)
- **Message splitting:** 21 tests (splitForTelegram contract with boundary preferences, code block protection, two-pass numbering)
- **/resume command:** 13 tests (forum topic requirement, name validation, move semantics, model carry-forward)

Total: 56 new tests. All MarkdownV2 + /resume GREEN ✅. Message splitter tests RED (waiting for implementation).

**Key learning:** TDD approach (write tests before implementation) locked contracts with clarity and reduced implementation ambiguity.

See `history-archive.md` for full Phase 1–5 test infrastructure details.

---

## Phase 6 Days 1–2 (2026-05-19–2026-05-20) — Summary

**Day 1:** Built `FakeDaemon.ts` and `FakeExtensionClient.ts` test doubles to support bridge testing. Passed smoke tests (296 green → all maintained).

**Day 2:** Added `SessionEventMessage` to `FakeDaemon` for forward compatibility with ADR-8 canonical schema. Baseline maintained.

**Key learning:** Synchronous transport in PassThrough streams requires careful timer registration order to avoid race conditions. Fake-timer scope must exclude `setImmediate` to preserve readline.

---

## Phase 6 Days 3–4 (2026-05-22) — Bridge Adapter Testing

**Deliverables:**
- `tests/helpers/FakeBridge.ts` — BridgeEmitter double with on/off tracking for cleanup assertions
- `tests/bridge/bridgeSession.test.ts` — 10 unit tests (J1)
- `tests/bridge/relay-with-bridge.test.ts` — 4 relay-integration tests (J2, scoped from 1 complex throttle test to 4 content+bound tests)
- `tests/bridge/bridgeSessionFactory.test.ts` — 6 factory tests (J3)

**Key learning:** `vi.useFakeTimers()` without `now` option freezes `Date.now()` at the real epoch (large number), not 0. Relay throttle fires on first chunk, blocks on subsequent chunks, fires again on completion → exactly 2 edits. Tests assuming `Date.now() = 0` were incorrect.

**Contract gap noted:** `BridgeSession` filters by `requestId` only (not `sessionId`). Low risk in practice; documented for ADR awareness.

---

## Phase 6 Day 5 (2026-05-22) — ADR-9 Scenario Catalog Revision Required

**Status:** ADR-9 ACCEPTED. All 5 open questions settled. Scenario catalog needs revision.

**Revisions required (Category 2 — Timeout/Cancellation):**

The 5 scenarios in Category 2 all assume a `timeoutMs`-based auto-deny after N seconds. ADR-9 Q4 settled to **Branch A: NO TIMEOUT**. Permission prompts wait indefinitely for explicit human decision (approve/deny) or session disconnect (AbortSignal).

**Scenario revisions (5 affected):**
1. Replace "user never replies → auto-deny after timeoutMs" with "user never replies → waits indefinitely; disconnect fires → auto-deny via AbortSignal"
2. "Session ends mid-prompt" scenario now tests **AbortSignal path**, not timer expiry
3. All Category 2 assertions shift from timing-based to abort-based

**New scenarios to add (3 total):**
1. **Friday → Monday (weekend wait):** No response for 72 simulated hours. Heartbeat maintains session (ADR-7 verified). User taps Approve after weekend. `permissionCallback` resolves. Tool executes. Session state clean throughout.
2. **Late callback tap:** User taps Approve after prompt message has scrolled away. Returns to message hours/days later, taps. Telegram's `answerCallbackQuery` window is from tap (not send). Verify this works indefinitely.
3. **Concurrent prompts with abort:** Two prompts in flight. Session disconnects. Both AbortSignals fire simultaneously within one event loop turn. Both prompts clean up. No leaks.

**Categories unaffected:** 1 (happy path), 3 (correlation/ordering), 4 (adversarial/edge), 5 (regression hooks), 6 (protocol) — all valid as written.

**Task:** Revise `jun-adr9-permission-test-scenarios.md` with above changes. Finalizes at 29 scenarios (3 Category 2 scenarios replaced, 3 new scenarios added in categories as indicated).

---

**Verification:** 316 passed / 4 skipped / 0 failed ✅

---

## Learnings

**Architecture:** Streaming UX requires request correlation via `requestId` (not single-shot response). ADR-8 canonical schema locks this shape.

**Testing patterns:** Async iterable adapters are testable via fake event emitters + listener tracking. Throttle contracts are verifiable via edit counts without precise timing (when ceiling tests already exist at unit level).

**Edge cases:** EC-08 (extension crash impairs all CLI sessions) requires fail-silent pattern in extension.mjs. TC-03 (foreign requestId filtering) is low-risk but worth documenting in ADR for reader awareness.

**Phase 6 Day 5 (2026-05-22) — ADR-9 Permission Test Scenario Catalog:**

Drafted 29 test scenarios across 5 categories (happy path, timeout/cancellation, correlation/ordering, adversarial/edge, regression hooks) anticipating the permission-prompting wire protocol before ADR-9 is locked. Key learning: control-plane messages (permission.request/response) are a *direction inversion* from the normal data-plane flow — the extension initiates, the daemon responds. This creates a new class of concurrency hazards (in-flight prompts vs. stream completion, pipe drops mid-prompt, multi-session cross-talk) that do not exist in the existing inject/stream path.

Identified 8 protocol ambiguities that Noble Six must resolve before implementation, including: wire message type (new top-level vs session.event discriminator), requestId ownership, timeout owner/deadline, and reconnect behavior for in-flight prompts. Flagged these explicitly so they do not silently become implementation divergences (the ADR-3 / Day 1 divergence lesson applied to ADR-9).

New skill extracted: `interleaved-control-plane-testing` — the pattern for testing bidirectional control-plane messages that interleave with active data streams.

## Archive

Earlier learnings (Phases 1–5, Phase 6 Spike methodology) in `history-archive.md`.