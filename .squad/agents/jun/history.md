# Jun — History (Summarized 2026-05-30 → Phase 9 complete)

---

**CROSS-AGENT NOTE (2026-06-06):** Noble Six's ADR-DRAFT for comms-channel abstraction (Teams support) is now in decisions.md under "Proposed / Pending Approval." Phase 1 task breakdown (P1-7 and P1-8) routes work to Jun for contract tests and regression suite. Awaiting Aaron's approval gate before Phase 1 implementation.

---

## Phase 1-7 + 1-8 (2026-06-06) — ChannelPort Behavioral Conformance Kit + Regression

### What shipped

**4 new files, 88 new tests, 937 total (up from 849):**

- `tests/channel/conformance/FakeChannel.ts` — Configurable in-memory ChannelPort with all capability flags independently toggleable. Supports injectInboundText/injectCommand for inbound simulation. Text-prompt fallback path wired to AbortSignal.
- `tests/channel/conformance/runner.ts` — `runChannelPortConformance(makePort, opts)` parameterized suite + `runCapabilityFallbackMatrix()` standalone matrix. Any future adapter plugs in via `makePort`.
- `tests/channel/conformance/fakeChannel.conformance.test.ts` — Conformance kit self-validation (FakeChannel as the DUT) + full fallback matrix: 44 tests.
- `tests/channel/conformance/telegram.conformance.test.ts` — Generic kit run against TelegramChannel with mocked grammY (no network) + anti-lie capability assertions + Kat's 3 gotchas pinned: 44 tests.

### Capability-fallback matrix — all PASSED (no findings)

| Capability | OFF behavior asserted | ON behavior asserted |
|---|---|---|
| supportsMessageEdit | editMessage returns false, no record | editMessage returns true, edit recorded |
| supportsStreaming | single placeholder→final edit, no intermediates | (covered by relay.test.ts) |
| supportsInteractivePrompts | text-fallback waits for inbound / resolves '' on abort | immediate resolution with option value |
| supportsThreadCreation | createThread throws (contract enforced) | returns ChannelContext with new threadId |

### Kat's gotchas pinned

1. **Empty threadId ⇒ omit message_thread_id** — asserted via `sendMessageMock.mock.calls[0][2]?.message_thread_id === undefined` for `threadId=''`.
2. **isBotCommand filter lives in onMessage handler** — asserted that TelegramChannel itself passes /list through to the registered handler; the filter is a caller responsibility.
3. **Synthetic ctx for /status and /cwd** — asserted that `ctx.reply()` on a synthetic ctx routes to `channel.sendMessage(channelCtx, text)`; General Topic produces `message=undefined`.

### Learnings

1. **Conformance kits should be parameterized, not duplicated** — `runChannelPortConformance` takes a `makePort` factory; all adapter-specific behavior lives in a separate `describe` block. This is the correct pattern for N-transport coverage.
2. **FakeChannel is the primary capability-matrix driver** — real adapters are tested for declared-matches-actual; the combinatorial matrix (each flag ON/OFF) belongs to FakeChannel. Avoids needing N real transports to prove fallback behavior.
3. **skipLifecycle flag needed for real adapters** — TelegramChannel.start() calls bot.start() (long-running poll); lifecycle semantics are tested in a separate dedicated block, not via the generic kit.
4. **Kat's synthetic ctx pattern is sound** — `makeSyntheticCtx` in handlers.ts correctly produces a grammY Context-like object whose `reply()` delegates to `channel.sendMessage`. The conformance test pins this at the behavior level.
5. **No contract violations found** — TelegramChannel's declared capabilities all match actual behavior. The abstraction is honest.

---

## Identity & Role

- **Agent:** Jun (Test Engineer, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Test infrastructure, integration test harnesses, contract validation, anticipatory TDD
- **Joined:** 2026-04-12

## Current Status

**Phase 9 COMPLETE.** Shipped 163 new tests total:
- Item 2 tests (80): isBotCommand (66+1 todo), afkMode.slashGuard (15), handlers.slashGuard (25)
- Item 3 tests (83): knownCwds helpers (60), /cwd commands (12), /new --cwd flag (11)

Suite: 720 passed / 4 skipped / 1 todo. +150 net tests (Phase 8.5 → Phase 9). All green.

**Phase 9 Persona Review (2026-05-30):** F-8 helpers extraction completed (makeStubRegistry, makeMockBot consolidated). Anticipatory RED regression tests added (7 tests). Cycle 1 fix wave: 725→771 tests. Cycle 2 fix wave (C2-I2 stub migration): 771→783 tests. Branch user/aaron/phase9, all green, ready for merge.

**Phase 8.5 COMPLETE.** Install story tests shipped (copyExtension 14, uninstall 6, index 13 = 33 new). Suite 570 passed / 4 skipped.

**Phase 8 COMPLETE.** Integration harness + config env tests (A8, N2, N3 validation). Phase 7 ADR-11 contract tests (T1–T8). Test infrastructure stabilized.
**Phase 8.5 COMPLETE.** Shipped 33 new tests for install story (copyExtension 14, uninstall 6, index orchestrator 13). Full suite: 570 passed / 4 skipped / 0 failed ✅. tsc clean, lint zero warnings.

Suite: 720 passed / 4 skipped / 1 todo. +150 net tests (Phase 8.5 → Phase 9). All green.

**Phase 8.5 COMPLETE.** Install story tests shipped (copyExtension 14, uninstall 6, index 13 = 33 new). Suite 570 passed / 4 skipped.

**Phase 8 COMPLETE.** Integration harness + config env tests (A8, N2, N3 validation). Phase 7 ADR-11 contract tests (T1–T8). Test infrastructure stabilized.

---

## Recent Phases Summary

### Phase 9 (2026-05-30) — Anticipatory Tests + Item 3 Suite

**Item 2 — Slash Pass-Through (80 tests):**
- `isBotCommand.test.ts` — Guard contract (case-insensitive, @botname handling, extraction regex)
- `afkMode.slashGuard.test.ts` — Pass-through validation
- `handlers.slashGuard.test.ts` — Relay target changes

**Item 3 — CWD Registry (83 tests):**
- `knownCwds.test.ts` — 8 helpers (validate, list, lookup, add, remove, touch, path-compare)
- `cwdCommand.test.ts` — /cwd group commands (list, add, remove, topic enforcement)
- `newCwdFlag.test.ts` — Position-independent flag parser, path vs alias disambiguation

**Pattern:** Mock architecture (vi.hoisted + vi.mock), fake timers for deterministic timestamps.

**Key learning:** Anticipatory tests written before implementation matched Carter's code exactly on first run — no import path adjustments needed. Indicates strong design convergence.

### Phase 8.5 (2026-05-29) — Install Story Tests

- `copyExtension.test.ts` — 14 tests (APPDATA validation, reach/ mkdir, copy, junction mode)
- `uninstall.test.ts` — 6 tests (removal, --wipe flag)
- `index.test.ts` — 13 tests (orchestrator + wizard wiring)
- `extension-protocol-drift.test.ts` — 4 regression tests (Issue #8 SDK fix)

### Phase 8 (2026-05-27–2026-05-28)

- `main-composition.test.ts` — 7 tests (A8 pairing-mode, N3 config guard)
- A6-6 fleet compensation validation (Kat, Jun collab)

### Phase 7 (2026-05-25) — ADR-11 Contract Tests

- `afk-mode.contract.test.ts` — T1–T8 integration suite (30/31 green)
- `FakeDaemon` + `FakeExtensionClient` extensions for ADR-11 protocol

---

## Architectural Patterns

- **Mock setup:** vi.hoisted() → vi.mock() → imports after mocks
- **Test double cleanup:** restoreAllMocks() pairs with full re-establishment in beforeEach (not clearAllMocks alone)
- **Fake timers:** vi.useFakeTimers({ now: ISO-8601 }) for deterministic timestamps
- **vi.fn() rules:** Always reset inline mocks in beforeEach if using restoreAllMocks() afterEach

---

## Phase 9 Sprint — 2026-05-30

**Sprint shipped.** All 3 Aaron dogfood feedback items addressed:
1. Orientation message + /status command (Kat, afkMode + handlers)
2. Slash pass-through via isBotCommand allowlist (Carter Items 2)
3. /cwd registry + /new --cwd flag (Carter Items 3 + Kat config schema)

**Suite:** 720 passed / 4 skipped / 1 todo. +150 net tests.

**Known Phase 10 follow-up:** Cross-platform path detection in /new --cwd (Unix `/` startsWith check deferred).

**Known Phase 10 follow-up:** Cross-platform path detection in /new --cwd (Unix `/` startsWith check deferred).

## Phase 9 Review Wave (2026-05-30) — Test-Quality Blockers + Anticipatory Regression Tests

**Sprint:** Phase 9 review blockers (B2, I7) + helpers extraction (F-8) + anticipatory tests for B1/B3/I3+I4/I10/I11.

### B2 — Fixed vacuous `/new` assertion

`handlers.slashGuard.test.ts` had a vacuously true assertion: the ctx passed to the handler and the ctx used in `expect()` were two different objects created by separate `makeMockCtx()` calls. Fixed by capturing ctx before the handler call. **Key lesson:** always capture the exact ctx reference and assert on THAT reference.

### I7 — extension-back-banner.test.ts rewrite (source-analysis)

Option (a) — direct import — failed: handlers are not exported, and extension.mjs has top-level side effects (reads env vars, imports SDK). Chose source-analysis (same pattern as extension-protocol-drift.test.ts): parse extension.mjs with `readFileSync`, extract function bodies via brace-balancing, assert structural properties (unconditional call in handleBackConfirmed, guarded call in handleModeChanged).

### F-8 — Helpers extraction

Extracted `makeMockBot` + `makeMockCtx` → `tests/helpers/botMocks.ts` and `makeStubRegistry` → `tests/helpers/registryMocks.ts`. Key finding: `afkMode.slashGuard.test.ts` had a DIFFERENT `makeMockBot` (AfkModeController API shape, not grammY) — kept that one local; only `makeStubRegistry` was extracted from that file.

### Anticipatory tests — what was pre-landed vs genuinely anticipatory

- **I10 (validatePath warning):** Kat already shipped this in `src/config/knownCwds.ts`. Tests went GREEN immediately — confirms design convergence.
- **B1 (isBotCommand digit fix):** 3 tests RED (expected). Current regex `/[a-z_]+/` extracts "new" from "/new123" → true (bug). Tests: `/new123`→false, `/list1`→false, `/status42`→false (all fail until Carter fixes regex). Note: "status" IS in BOT_COMMANDS currently (surprise!).
- **B3 (prod-over-dev junction):** TC15 RED (expected). `lstatSync` mock infrastructure added to copyExtension.test.ts.
- **I11 (redactSecrets):** 3 tests RED. Module exists at `src/bot/redactSecrets.ts` but implementation is partial — ENV-style assignments and high-entropy strings not yet redacted.
- **I3+I4 (flag parser):** Collection error (module not found). `src/bot/newFlagParser.ts` doesn't exist yet.

### Final suite state (Phase 9 review wave)

- tsc: GREEN (exit 0)
- vitest: 7 failed (all anticipated RED) / 746 passed / 4 skipped / 1 todo
- Failing: B1 (3) + I11 partial (3) + B3 TC15 (1). Collection error: newFlagParser.test.ts.

### Learnings

1. **Source-analysis tests require brace-balancing parsers** — a simple regex won't reliably extract function bodies. The brace-counter approach from extension-protocol-drift.test.ts is the established pattern for this project.
2. **Always verify "RED" expectations by checking what the current impl returns** — I10 tests went GREEN because Kat had already shipped. Don't assume all anticipatory tests will be red.
3. **`process.platform` is configurable via `vi.spyOn` getter mock** — works reliably to test platform-specific code paths without actually running on that OS.
4. **Check BOT_COMMANDS membership before writing anticipatory tests** — "status" was unexpectedly in BOT_COMMANDS, which changed which B1 tests would be red.
5. **afkMode's `makeMockBot` is NOT the grammY bot mock** — its shape is `{api: {editMessageText, sendMessage}}` for AfkModeController. The two mocks are not interchangeable.



## Cycle 2 Cleanup — handlers.test.ts migration (2026-05-30)

**Task:** Replace local `makeStubRegistry` in `tests/bot/handlers.test.ts` with the shared helper from `tests/helpers/registryMocks.ts`.

**Investigation findings:**
- Local stub was missing `upsert` (masked by `as unknown as ISessionRegistry` cast)
- Local stub's `findByName` was a functional linear-search; no test in the file asserted on `findByName` behavior → straight migration, no need to extend shared helper with `findByName` override
- **Craft reviewer's GOTCHA was not triggered** — no name-collision tests exist

**Behavioral gap discovered during validation:**
- Local `remove: vi.fn(async (topicId) => map.delete(topicId))` returned `true` on success
- Shared `remove: vi.fn()` returned `undefined` (falsy) → "removes the session and confirms" test failed
- Fix: updated shared helper to `remove: vi.fn().mockResolvedValue(true)` as default. Tests that need falsy (e.g. "no session linked") already call `.mockResolvedValue(false)` explicitly. No other consumers were affected.

**Cast situation:** `as unknown as ISessionRegistry` lives inside the shared helper's implementation — consumers always receive `ISessionRegistry` from the function signature. No consumer-visible casts were introduced.
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

## Learnings

**Learnings:**
1. **Check all vi.fn() return values, not just types** — a no-op `vi.fn()` returning `undefined` is behaviorally different from a stub that returns `true` even when the TS interface says `Promise<boolean>`. Type check passes; runtime test fails.
2. **Successful-default principle for stubs** — mutating stubs (`remove`, `register`, etc.) should default to "success" semantics (`mockResolvedValue(true)`) so that "happy path" tests require no extra setup. Override to failure only when the test specifically exercises the failure branch.
3. **Review all test assertions before assuming straight migration** — even when no test directly calls `expect(registry.findByName)`, a mock's side-effects (return value) can still flow through the SUT and affect other assertions.

## Full Archive

Phases 1–6, Phase 7 detailed learnings, Phase 8 P1 analysis → `history-archive.md`.

