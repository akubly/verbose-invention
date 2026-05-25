# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions.
- **Role:** Test Engineer
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Days 3–4 complete:** Shipped 20 bridge adapter tests (BridgeSession, factory, relay-integration). Test suite: 316 passed / 4 skipped / 0 failed ✅.

**2026-05-24 Dogfooding Kickoff:** I3 drift-detection tests + I8 FakeDaemon reconciliation merged into canonical decisions. Jun's 32 vitest scenarios unblocked per Kat reconciliation.

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

**Day 2:** Added `SessionEventMessage` to `FakeDaemon` for forward compatibility with ADR-8 canonical schema. Baseline maintained. Full details archived in `history-archive.md`.

**Key learning:** Synchronous transport in PassThrough streams requires careful timer registration order to avoid race conditions. Fake-timer scope must exclude `setImmediate` to preserve readline.

---

## Phase 6 Days 3–4 (2026-05-22) — Bridge Adapter Testing (Summary)

**Deliverables:**
- `tests/helpers/FakeBridge.ts` — BridgeEmitter double with on/off tracking for cleanup assertions
- `tests/bridge/bridgeSession.test.ts` — 10 unit tests (J1)
- `tests/bridge/relay-with-bridge.test.ts` — 4 relay-integration tests (J2, scoped from 1 complex throttle test to 4 content+bound tests)
- `tests/bridge/bridgeSessionFactory.test.ts` — 6 factory tests (J3)

**Key learning:** `vi.useFakeTimers()` without `now` option freezes `Date.now()` at the real epoch (large number), not 0. Relay throttle fires on first chunk, blocks on subsequent chunks, fires again on completion → exactly 2 edits. Tests assuming `Date.now() = 0` were incorrect. Full details archived in `history-archive.md`.

---

## Phase 6 Day 5 (2026-05-22) — ADR-9 Scenario Catalog & Implementation Reconciliation (Summary)

Drafted and revised ADR-9 test scenarios (29 → 32 scenarios). Key learning: timeout decision reversal requires design flip in Category 2 tests. New patterns: no-timer regression assertion, Friday-Monday durability test, per-session store isolation test. **Reconciliation:** Kat's K1–K6 implementation complete; 3 assumptions verified (AbortController injection, per-session store, named exports). Test generation unblocked. Full details archived in `history-archive.md`.

---

Earlier learnings (Phases 1–5, Phase 6 Spike methodology) in `history-archive.md`.
**[2026-05-24] Scribe log entry:** Test coverage audit merged into decisions. 8 high-value test scenarios identified for /afk→topic→/back flow. Blockers from protocol decisions cleared.

## Phase 7 (2026-05-24T23:19:14-07:00) — ADR-11 AFK Contract Tests

**Deliverables:** Wrote `tests/integration/afk-mode.contract.test.ts` with T1–T8 coverage, extended `FakeDaemon` and `FakeExtensionClient` for ADR-11 protocol messages, and added `tests/helpers/afkContract.ts` for Telegram API spies, relay-target assertions, and SessionEntry fixtures.

**Protocol corrections locked into tests:** T4 is now a negative test because ADR-11 §2 makes `/back` CLI-only and not honored from Telegram. T6 now asserts immediate daemon-unreachable error with no retry/backoff timers per ADR-11 §10.

**Verification:** `npx tsc --noEmit` GREEN. `npm run lint` GREEN. `npx vitest run tests/helpers/fakePipe.smoke.test.ts --reporter=dot` GREEN (18 passed). `npx vitest run tests/integration/ --reporter=dot` produced 30 passed / 1 failed: T4 red because Telegram `/back` is currently mirrored to CLI by the AFK controller path, while ADR-11 §2 expects it to be ignored with no relay re-target.

**Key learning:** Contract tests for parallel implementation work need an adapter seam over the production controller so tests can bind to live code without making production API names part of ADR. Failure-mode assertions are sharper when they distinguish protocol gaps (T1/T8) from harness/load failures.

## 2026-05-25T06:19:14Z — Phase 7 Orchestration Complete

**Session:** Phase 7 implementation kickoff (Carter-4 + Kat-3 + Jun-1)

**Outcome:** 8 test cases (T1–T8) written + extended FakeDaemon/FakeExtensionClient for ADR-11. Typecheck/lint clean; 30/31 integration green. Orchestration log: `.squad/orchestration-log/2026-05-25T06-19-14Z-jun-1.md`.

**Decisions merged to `.squad/decisions.md`:** `jun-phase7-test-cases.md` — T4 negative test (Telegram /back ignore), T6 no-retry (daemon unreachable), protocol clarifications.

**Convergence signal:** T4 red is expected; Telegram /back filter should land in Kat's daemon integration. All fixtures ready for full suite + integration tests once filter lands.

