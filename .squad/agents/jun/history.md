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

## Phase 6 Day 6 (2026-05-22) — ADR-9 32-Scenario Test Suite (this task)

**Deliverables (all 4 files, all 32 tests passing):**
- `tests/bridge/permission-prompting.test.ts` — 11 tests (Categories 1, 3, 7)
- `tests/bridge/permission-abort.test.ts` — 6 tests (Category 2; C2-01 is no-timeout keystone)
- `tests/bridge/permission-edge.test.ts` — 8 tests (Categories 4, 5; classifier unit + no-timer regression)
- `tests/bridge/permission-bypass.test.ts` — 7 tests (Category 6; AllowAlwaysStore, bypass, scanner)

**Total suite:** 353 passed / 4 skipped / 0 failed ✅

**Key learning — sinon fake-timer `>` vs `>=` boundary:**
When a `setInterval` fires at exactly its scheduled tick `T`, sinon sets `Date.now() = T` inside the callback. If the warning condition is `now - createdAt > TEN_MINUTES_MS` (strict `>`), a prompt registered at `createdAt = 0` will NOT warn on the first interval tick (T = TEN_MINUTES_MS), because `TEN_MINUTES_MS > TEN_MINUTES_MS` is false. The scanner warns on the **second** tick (T = 2 × TEN_MINUTES_MS). Fix: advance `2 * TEN_MINUTES_MS + 1` ms (not `TEN_MINUTES_MS + 1`).

**Key learning — microtask ordering with fake timers:**
`await Promise.resolve(); await Promise.resolve()` before `vi.advanceTimersByTimeAsync(ms)` is the correct pattern to ensure async mocks (e.g., `vi.fn().mockResolvedValue(...)`) have resolved and populated shared state before the interval callback fires. The microtask queue drains in FIFO order, so two `await Promise.resolve()` calls are sufficient for one `await sendMessage()` hop with an already-resolved mock.

**K2 pattern confirmed:** Driving session abort via `fakeBridge.emitDisconnected(sessionId)` (not by injecting the private `_sessionAbortController`) is the correct approach. The `session.disconnected` listener calls `_sessionAbortController.abort()` internally; tests verify externally observable effects (callbacks resolving false, pending map clearing).

---

## Learnings

**Architecture:** Streaming UX requires request correlation via `requestId` (not single-shot response). ADR-8 canonical schema locks this shape.

**Testing patterns:** Async iterable adapters are testable via fake event emitters + listener tracking. Throttle contracts are verifiable via edit counts without precise timing (when ceiling tests already exist at unit level).

**Edge cases:** EC-08 (extension crash impairs all CLI sessions) requires fail-silent pattern in extension.mjs. TC-03 (foreign requestId filtering) is low-risk but worth documenting in ADR for reader awareness.

**Phase 6 Day 5 (2026-05-22) — ADR-9 Permission Test Scenario Catalog:**

Drafted 29 test scenarios across 5 categories (happy path, timeout/cancellation, correlation/ordering, adversarial/edge, regression hooks) anticipating the permission-prompting wire protocol before ADR-9 is locked. Key learning: control-plane messages (permission.request/response) are a *direction inversion* from the normal data-plane flow — the extension initiates, the daemon responds. This creates a new class of concurrency hazards (in-flight prompts vs. stream completion, pipe drops mid-prompt, multi-session cross-talk) that do not exist in the existing inject/stream path.

Identified 8 protocol ambiguities that Noble Six must resolve before implementation, including: wire message type (new top-level vs session.event discriminator), requestId ownership, timeout owner/deadline, and reconnect behavior for in-flight prompts. Flagged these explicitly so they do not silently become implementation divergences (the ADR-3 / Day 1 divergence lesson applied to ADR-9).

New skill extracted: `interleaved-control-plane-testing` — the pattern for testing bidirectional control-plane messages that interleave with active data streams.

**Phase 6 Day 5 (2026-05-22) — ADR-9 Catalog Revision (this task):**

Revised prior 29-scenario catalog to 32 scenarios. Key learning: when a timeout decision is reversed (Branch A: no timeout), it is not just a deletion — it requires a *design flip* in Category 2. Every "auto-deny after Xs" scenario is replaced by an AbortSignal-based scenario with a fundamentally different assertion shape: instead of asserting that a timer fires, you assert that an abort fires **within one event loop turn** of disconnect. The keystone test (C2-01) is the single most load-bearing scenario in the entire catalog — it is the behavioral proof of the no-timeout safety invariant.

New category patterns:
- **No-timer regression assertion (C5-02):** Spy on `globalThis.setTimeout` and assert zero calls from the prompt's call site. This pattern regression-guards against re-introduction of deleted code. Extracted to `no-timer-regression-assertion` skill.
- **Friday→Monday durability (C5-01):** `vi.advanceTimersByTime(72 * 60 * 60 * 1000)` + `vi.getTimerCount()` to verify zero leaked timers after 72 simulated hours. Validates that indefinite wait is truly clean at the JavaScript runtime level, not just at the application logic level.
- **Store isolation (C6-04):** Per-session store contract test — verifies that factory creates a new store instance per session. Critical for multi-session security (cross-session allow-always leakage would be a privilege escalation bug).

New skill extracted: `no-timer-regression-assertion` — the pattern of using `vi.spyOn(globalThis, 'setTimeout')` to assert that a function does NOT create a timer, regression-guarding against re-introduction of deleted timeout logic.

**Phase 6 Day 5 (2026-05-23) — ADR-9 K1–K6 Implementation Complete**

**Status:** Kat's K1–K6 implementation verified (321 tests green). Test file generation UNBLOCKED pending 3 assumption reconciliations.

**What's blocking Jun's vitest generation:**

Kat implemented K1–K6 per ADR-9 spec. Jun's revised 32-scenario catalog assumes 3 implementation details for whitebox factory and classifier tests. Before Jun writes vitest files, Kat must verify:

1. **K2:** `BridgeSession` constructor takes `AbortController` (not self-construct) — required for C2-01/C2-02/C2-03 abort simulation tests
2. **K4:** `BridgeSessionFactory` creates new `InMemoryAllowAlwaysStore()` per session — required for C6-04 store-isolation security test
3. **K5:** `extension.mjs` exports `isDestructive()` and `isKnownSafe()` as named functions — required for C4-05/C6-05 classifier unit tests

**Next:** Await Kat's reply in her history.md confirming all 3 points match implementation. Once verified, Jun writes vitest files for all 32 scenarios (Categories 1–7).

---

## Phase 6 Review Cycle 1 (2026-05-22) — I3 drift detection + I8 FakeDaemon schema

**Deliverables:**
- `tests/copilot/permissions-drift.test.ts` — 3 drift-detection assertions (I3)
- `tests/helpers/FakeDaemon.ts` — PermissionRequestMessage, PermissionCancelledMessage, PermissionResponseMessage added; TODO removed (I8)

**Commit:** 328f48a on branch `squad/review1-phase6-adr9-fixes`

**Verification:** tsc clean, lint clean, 340 passed / 4 skipped ✅

**Key learnings:**

**Drift detection pattern for dual-source constants:** When two files (one TypeScript, one plain JS) must maintain identical sets, the fastest enforcement is a regex-parse test — not a shared module. Parse the JS file as raw text, extract quoted string literals between the `new Set([...])` brackets, compare to the TypeScript export. The test lives in the TypeScript test suite and fails at `vitest run` time if the sets diverge. This pattern applies anywhere a `.mjs`/`.js` file must mirror a `.ts` constant.

**FakeDaemon completeness audit:** A fake that's missing union members from the real type is not just incomplete — it's actively misleading. Tests that call `sendTo(sessionId, { type: 'permission.response', ... })` would have required an `as OutboundMessage` cast to compile, hiding the gap. The rule: when new wire message types land in production, audit ALL test doubles in the same commit. The FakeDaemon's `OutboundMessage` and `InboundMessage` unions must mirror `extensionBridge.ts` exactly.

**Discovery — integration test hang:** `tests/integration/pairing-flow.test.ts` hangs on a real named-pipe connection in the CI environment. Pre-existing; not caused by any Phase 6 changes. Escalated via dispositions inbox.

---

Earlier learnings (Phases 1–5, Phase 6 Spike methodology) in `history-archive.md`.