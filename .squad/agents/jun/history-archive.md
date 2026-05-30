# Jun — History Archive

**Archived 2026-05-30** from history.md (19,867 bytes)

---

# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions.
- **Role:** Test Engineer
- **Joined:** 2026-04-12

## Current Status

**Phase 8.5 COMPLETE.** Shipped 33 new tests for install story (copyExtension 14, uninstall 6, index orchestrator 13). Full suite: 570 passed / 4 skipped / 0 failed ✅. tsc clean, lint zero warnings.

**Phase 8 COMPLETE.** Test infrastructure for Phase 8 finalized. Bridge adapter tests (20), relay integration tests (32) merged into canonical decisions. Test suite: 537 baseline passing (now 570 with Phase 8.5).

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

## Phase 8 P1 Sprint (2026-05-27T23:48:20-07:00) — A8 + N2-env-var + N3

**Deliverables:**
- `tests/integration/main-composition.test.ts` — 7-test A8 + N3 integration harness for `main()`:
  - A8a (3 tests): pairing-mode early-return — verifies `runPairingMode` is called, bot/bridge/registry never constructed
  - A8b (2 tests): normal-mode wiring — verifies bridge + all deps wired, graceful fallback when bridge unavailable
  - N3 (2 tests): config-file `allowedUserIdSet` end-to-end — verifies `AfkModeController` receives the set from config, and omits it when undefined
- `tests/config/env.test.ts` — 1 new test (N2 env-var variant):
  - `TELEGRAM_ALLOWED_USER_IDS=,` (comma-only → all tokens empty after split → fatal) — distinct from Kat's N2 guard test for `telegramAllowedUserIds: []`

**Harness pattern used:** `vi.hoisted()` for shared mock instances → `vi.mock()` factories reference hoisted values → imports after mocks → `beforeEach` re-establishes ALL implementations (including inline `vi.fn()` mocks). `vi.restoreAllMocks()` in `afterEach` for console spy cleanup; all re-setup handled in `beforeEach`.

**Key learning:** `vi.restoreAllMocks()` sets `implementation = void 0` on EVERY tracked `vi.fn()`, including pure mock functions created in `vi.mock()` factories. This silently breaks subsequent tests if any inline `vi.fn()` (e.g., `ExtensionBridge` constructor mock) is not re-established in `beforeEach`. Symptoms appear as "Cannot read properties of undefined" — the real cause is the inline constructor mock returning `{}` (no-implementation path), then the bridge's `start()` method being absent. Pattern fix: always pair `vi.restoreAllMocks()` with a full re-establishment sweep in `beforeEach`, OR switch to `vi.clearAllMocks()` only (no restore).

**A8 closure status:** CLOSED. Composition-root branches verified. Phase 8 regression risk for wiring changes is now covered.

**Verification:** `npx tsc --noEmit` GREEN. `npx vitest run` — 515 passed / 4 skipped / 0 failed (39 files). `npm run lint` — 0 warnings.

## Phase 8.5 Task 3 (2026-05-29T23:27:00-07:00) — copyExtension.ts Tests

**Deliverables:**
- `tests/install/copyExtension.test.ts` — 9 tests (TC1–TC9) for `copyExtension()`
- `src/install/copyExtension.ts` — Carter's implementation was already present; stub not needed
- `.squad/decisions/inbox/jun-task3-copyextension-tests.md` — infrastructure decisions

**Coverage:**
- TC1 happy path (copy + log), TC2 first install (mkdir), TC3 upgrade (idempotent overwrite)
- TC4 Copilot CLI not installed, TC5 APPDATA unset, TC6 source missing
- TC7 spaces + unicode in user profile path
- TC8 mkdir EPERM → exit(1), TC9 copyFileSync EPERM → exit(1)

**Infrastructure:**
- `vi.mock('fs', async (importOriginal) => { ...actual, existsSync, mkdirSync, copyFileSync })`
- Same pattern as `tests/service/install.test.ts`; no new devDependencies
- `process.exit` spy throws; re-established in `beforeEach` after `vi.clearAllMocks()`
- Source path = `path.join(process.cwd(), 'extension.mjs')` because Carter's `getProjectRoot()`
  resolves `path.resolve(__dirname, '..', '..')` which equals `process.cwd()` under vitest ESM

**Verification:** `npx tsc --noEmit` GREEN. `npx vitest run tests/install/copyExtension.test.ts` — 9 passed. Full suite — 42 files, 546 passed / 4 skipped / 0 failed ✅.

**Key learning:** When the source module uses `import * as fs from 'fs'` (bare specifier), the
vi.mock specifier must be `'fs'`, NOT `'node:fs'`. Mixing specifiers causes the mock to not
intercept the production code's imports.

## Phase 8.5 Task 2 (2026-05-29T23:44:00-07:00) — Junction / Uninstall / Orchestrator Tests

**Deliverables:**
- `tests/install/copyExtension.test.ts` — extended to TC14 (TC10–TC14 = junction mode: symlinkSync called, log contains "linked/dev", rmSync before re-junction, idempotent absent case, production regression)
- `tests/install/uninstall.test.ts` — 6 tests (UN1–UN6): service uninstall, ext dir remove, data preserve, wipe flag, idempotent absent, both absent
- `tests/install/index.test.ts` — 13 tests (IX1–IX13): happy path, copyExtension+service called, prompts bot token, empty token exits, .env creation, key preservation, allowed IDs prompt, skip+confirm y, skip+decline n, chat ID warn-only, non-TTY exit, non-TTY all-set proceeds, secret hygiene
- `src/install/uninstall.ts` — stub created (Carter must implement body, interface preserved)
- `.squad/decisions/inbox/jun-task2-tests.md` — infrastructure decisions

**Key learnings:**

1. **Readline mock via answer queue** — `vi.hoisted()` + `rlAnswerQueue.shift()` pattern lets each test push expected answers; `mockCreateInterface` call tracking confirms TTY gate assertions. This is robust to prompt-text changes.

2. **Carter's junction support was already live** — TC10–TC14 were expected RED but landed GREEN because Carter had already implemented the `NODE_ENV=development` branch before tests ran. Cross-team anticipatory testing still has value: it confirmed Carter's implementation matched the contract exactly.

3. **Sparse service mock causes import errors** — mock all expected named exports from a module even if only one is used; sparse mocks cause "not a function" at runtime when code uses additional named bindings.

4. **`process.stdin.isTTY` needs `Object.defineProperty`** — it's a plain property, not a getter, so `vi.spyOn` won't work. Use `{ configurable: true }` and restore in `afterAll`.

5. **`vi.clearAllMocks()` not `vi.restoreAllMocks()`** — restoreAllMocks wipes factory-closure `vi.fn()` implementations. clearAllMocks only resets call records; re-establish the handful of spy implementations manually each `beforeEach`.

**Verification:** `npx tsc --noEmit` GREEN. `npx vitest run tests/install/` — 33/33 GREEN. Full suite maintained.

---

## Phase 9 Item 2 (2026-05-30T11:46:29-07:00) — Slash Command Pass-Through Tests

**Context:** Anticipatory tests for Phase 9 Item 2 guard change (`isBotCommand` replacing blanket `/` guard in afkMode.ts and handlers.ts).

**Discovery:** Carter had already landed all Phase 9 Item 2 changes by the time tests ran. Contract diverged from design doc on one point (see below). All tests landed GREEN.

**Deliverables:**
- `tests/bot/isBotCommand.test.ts` — 41 tests (40 + 1 todo): pure unit contract for `isBotCommand()` and `BOT_COMMANDS`
- `tests/relay/afkMode.slashGuard.test.ts` — 15 tests: AfkModeController.handleTelegramMessage slash guard behavior
- `tests/bot/handlers.slashGuard.test.ts` — 25 tests: registerHandlers message:text slash guard behavior
- `.squad/decisions/inbox/jun-phase9-item2-tests.md` — import path + case sensitivity + existing-test conflict decisions

**Contract divergence discovered:**
Design doc showed regex `/^\/([a-z_]+)/` (case-sensitive). Carter implemented `/^\/([a-zA-Z_]+)/` + `.toLowerCase()` (case-insensitive). My initial tests asserted `/New → false`; Carter's implementation returns `true`. Corrected immediately.

**Key learnings:**

1. **Always read the actual implementation first.** For TDD-style tests, I checked the design doc spec but not the actual Carter file. When Carter's file existed, checking it first would have saved one correction round. Order: decisions/inbox file → actual source file → design doc.

2. **Anticipatory tests are self-validating when the impl lands during your run.** All 3 test files went straight to GREEN — no waiting. The test-writing discipline was the same; the feedback cycle just happened to be immediate rather than deferred.

3. **`AfkModeController.forTesting()` + minimal bridge mock is sufficient for guard-level unit tests.** Don't reach for the full FakeDaemon/FakeExtensionClient harness for testing a single if-statement change. The forTesting() factory with a seeded active state and a simple vi.fn() bridge is 20 lines vs 80.

4. **When writing slash guard tests for handlers.ts, assert on `ctx.reply` being called with `'…'` (placeholder).** This is the observable proof that relay.relay() was reached — the relay sends the placeholder immediately on entry. This avoids needing to spy on the relay object internally.

**Files produced:**
- `tests/bot/isBotCommand.test.ts`
- `tests/relay/afkMode.slashGuard.test.ts`
- `tests/bot/handlers.slashGuard.test.ts`
- `.squad/decisions/inbox/jun-phase9-item2-tests.md`



## Phase 9 Item 3 (2026-05-30T12:16:00-07:00) — Multi-CWD Registry Tests

**Context:** Anticipatory tests for Phase 9 Item 3 — Kat's T5 knownCwds helpers (already shipped)
and Carter's T6 `/cwd` command + T7 `/new --cwd` flag (expected RED, landed GREEN because
Carter shipped during the run).

**Deliverables:**
- `tests/config/knownCwds.test.ts` — 60 tests: pure unit contract for all 8 knownCwds helpers
  (validateAlias, validatePath, listKnownCwds, getKnownCwdByAlias, getKnownCwdByPath,
  addKnownCwd, removeKnownCwd, touchKnownCwd). GREEN immediately.
- `tests/bot/cwdCommand.test.ts` — 12 tests: Carter's `/cwd list|add|remove`, general-topic-only
  guard, bare /cwd defaults to list, active-session removal no-op. GREEN (Carter landed).
- `tests/bot/newCwdFlag.test.ts` — 11 tests: `/new --cwd` path branch, alias branch, no-value
  guard, regression (no --cwd unchanged), flag order independence, configPath-absent guard. GREEN.
- `.squad/decisions/inbox/jun-phase9-item3-tests.md` — 7 decisions (mock arch, configPath shape,
  fake timers scope, Unix path omission note, same-path-two-aliases confirmation).

**Contract divergence discovered:**
Carter's `/new --cwd` path detection is Windows-only (`/^[a-zA-Z]:\\/` or `\\\\` prefix).
Kat's spec requires Unix path detection (`startsWith('/')`). Low-impact for Phase 9 (Windows
target), but filed as follow-up: Carter should add `|| cwdArg.startsWith('/')`.

**Key learnings:**

1. **For command-handler isolation tests, `commandHandlers.get('cwd')` + test-double `ctx` is
   enough.** Extracting command handlers via a collector Map avoids grammY middleware complexity
   while testing all branches. The pattern established in Phase 9 Item 2 handlers tests scales
   directly to new command groups.

2. **Kat's `removeKnownCwd` returns the SAME REFERENCE on miss (not a new object).** This is
   observable with `toBe(config)` (reference equality). A `toEqual(config)` assertion would pass
   for both behaviors. When testing immutability/no-op guarantees, always prefer `toBe` for
   same-ref no-ops and confirm with a diff check that original length is unchanged.

3. **`vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')` works for cross-platform
   tests** because `process.platform` is a getter. Wrap in `try/finally` to restore. This lets
   a single test file cover Windows-specific and Linux-specific code paths on any host OS.

4. **When anticipatory tests land GREEN immediately, validate the impl matches the spec, don't
   just celebrate.** Carter's Unix path omission was found by reading the implementation after
   tests passed, not by a failing test. Spec gaps need human review; tests can only assert what
   was modeled.

### 2026-05-28T10:00:30-07:00 — A6-6 Fleet Compensation Verdict

**Task:** Resolve A6-6 architect watch (compensatePartialActivation parallel close
burst at N>15 under 429 pressure).

**Approach:** Created `tests/integration/afk-mode-fleet-compensation.test.ts` with
two fleet-scale tests exercising the public AfkMode surface only. Activation is
forced to fail at `postGeneralSummary` (called after all N topics are created),
so compensation runs over the full fleet.

**Mocking pattern:**
- `sendMessage` mock: throw when `options?.parse_mode === 'MarkdownV2'` (unique
  to the general summary call). Per-topic messages use `message_thread_id`
  instead and are not affected.
- `closeForumTopic` 429 mock: pre-calculate target topic IDs from the mock's
  deterministic `nextTopicId` counter (starts at 9001, increments per call). Use
  `Object.assign(new Error(), { error_code: 429, parameters: { retry_after: 1 } })`
  to match the `retryAfterMs()` detection shape.
- `delay: async () => undefined` (no-op) so `withRateLimitRetry` retries complete
  as microtasks without real clock advancement.
- `vi.useFakeTimers` prevents the `COMPENSATION_TIMEOUT_MS` race timer from
  firing; `vi.getTimerCount() === FLEET_SIZE` after compensation confirms all
  closes completed before the 7 s cap.

**Key flush insight:** With `vi.useFakeTimers` and a no-op `delay`, the entire
activation + compensation chain (including all N topic creates, sends, and closes)
completes in the microtask drain that happens BEFORE the `setImmediate` in
`handleAfkRequest`. A single `drainAsync()` (or even just the `await
driver.handleAfkRequest(...)` call itself) is sufficient.

**Verdict:** ✅ CLOSED — safe at N=20+. `COMPENSATION_TIMEOUT_MS = 7 s` caps
per-close wall time (so `Promise.all` wall clock = MAX not SUM), `MAX_RETRIES = 4`
prevents infinite thrash. All 20 topics close cleanly with or without 429 pressure.

**Files produced:**
- `tests/integration/afk-mode-fleet-compensation.test.ts` — TC-A6-6-1, TC-A6-6-2
- `.squad/decisions/inbox/jun-a66-verdict.md` — verdict + evidence
- `.squad/skills/fleet-simulation/SKILL.md` — reusable fleet-simulation pattern
- `.squad/decisions/inbox/phase-8-backlog.md` — A6-6 updated to RESOLVED

---

## Phase 9 Sprint — 2026-05-30

**Sprint shipped.** All 3 Aaron dogfood feedback items addressed:
1. Orientation message + /status command (Item 1 tests unchanged, protocol updated)
2. Slash pass-through via isBotCommand allowlist (Item 2, 80 new tests; all green)
3. /cwd registry + /new --cwd flag (Item 3, 83 new tests; all green)

**Suite:** 720 passed / 4 skipped / 1 todo. +150 net tests (80 Item 2 + 83 Item 3 - existing updates).

**Known Phase 10 follow-up:** Cross-platform path detection in /new --cwd (Unix `/` startsWith check deferred; noted in D5).


