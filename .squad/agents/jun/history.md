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

**Verification:** 316 passed / 4 skipped / 0 failed ✅

---

## Learnings

**Architecture:** Streaming UX requires request correlation via `requestId` (not single-shot response). ADR-8 canonical schema locks this shape.

**Testing patterns:** Async iterable adapters are testable via fake event emitters + listener tracking. Throttle contracts are verifiable via edit counts without precise timing (when ceiling tests already exist at unit level).

**Edge cases:** EC-08 (extension crash impairs all CLI sessions) requires fail-silent pattern in extension.mjs. TC-03 (foreign requestId filtering) is low-risk but worth documenting in ADR for reader awareness.

## Archive

Earlier learnings (Phases 1–5, Phase 6 Spike methodology) in `history-archive.md`.