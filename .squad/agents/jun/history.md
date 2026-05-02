# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Tester
- **Joined:** 2026-04-12T06:02:10.441Z

## Project Background

Reach is Aaron's personal mobile bridge for Copilot CLI. I'm Jun — I own the test strategy and test coverage. Stack: Vitest (run with `npm test`). The project uses dependency injection throughout (interfaces, not concrete implementations) which makes unit testing straightforward.

## Test Infrastructure (Day 1)

Test mocks scaffolded in `tests/mocks/`:
- `sdk.ts` — mock `CopilotClient` and `CopilotSession`
- `telegram.ts` — mock Telegram context/API

Test directories: `tests/bot/`, `tests/relay/`, `tests/sessions/`

## What Needs Tests (Priority Order)

1. **`SessionRegistry`** — load, register, resolve, list, remove; ENOENT on first load; JSON persistence round-trip
2. **`Relay`** — happy path relay, no-session-found error, SDK create/resume errors, streaming throttle timing, idle eviction
3. **`IdleMonitor`** — timer fires after idle period, reset cancels previous timer, cancelAll
4. **`registerHandlers`** — `/new` success/failure/duplicate, `/list` empty/populated, `/remove` found/not-found, non-command relay dispatch

## Testing Principles

- Unit tests only for the first sprint — no integration tests yet (no real Telegram, no real SDK)
- All tests use mock implementations — never the real SDK or real grammY bot
- Test file location: `tests/<module>/<file>.test.ts` mirroring `src/`
- The `CopilotClient` stub in `src/copilot/factory.ts` exists for dev; tests should use their own mocks (finer control)

## Key Constraint

**Tests must not import `@github/copilot-sdk` directly.** The interface boundary (`src/types.ts`) is what tests mock against — the real SDK binding is Noble Six's concern.

- `makeMockBot()` with handler capture is a reusable pattern for any future handler tests.

### 2026-04-12 — Noble Six SDK Binding Complete

Noble Six delivered the real SDK binding. My test suite can now target integration tests against the real adapter:

- **CopilotClientImpl** in `src/copilot/impl.ts` implements `CopilotSessionFactory` with proper event-to-AsyncIterable streaming
- **main.ts** is the DI root — entry point with platform detection, env config, graceful shutdown
- TypeScript compiles clean
- All 56 tests passing (no test changes needed)

My test infrastructure remains stable — tests still depend only on interface boundaries (`CopilotSessionFactory`, `ISessionRegistry`, etc.), never on `@github/copilot-sdk` directly. Next phase: integration tests can exercise real relay + real adapter against mock Telegram API.

<!-- Append learnings below -->

**Test count:** 26 → 56 (30 new tests across 2 files).

**IdleMonitor tests** (`tests/idleMonitor.test.ts` — 13 tests):
- Uses `vi.useFakeTimers()` + `vi.advanceTimersByTime()` — the module reads `IDLE_TIMEOUT_MS` at load time (default 300_000ms), so fake timers work without env var manipulation.
- Covers: timer fires after timeout, does not fire early, reset cancels previous, reset restarts full window, independent topics, cancel single/all, no-op cancel on unknown topic, cleanup after fire, cancel after fire is harmless.
- Edge case found: resetting one topic does not disturb another — validated with staggered timer starts.

**Bot handler tests** (`tests/bot/handlers.test.ts` — 17 tests):
- **Mock strategy:** capture handlers by mocking `bot.command()` and `bot.on()`, then invoke captured handler functions directly with mock contexts. No real grammY Bot needed.
- Mock context shape: `{ message, match, chat, reply, api: { editMessageText } }` — minimal surface matching what handlers actually touch.
- Relay handler tests use the real `Relay` class (created internally by `registerHandlers`) with stub registry + mock factory. This gives realistic coverage without mocking internal relay logic.
- Edge cases: `ctx.match` as undefined (not just empty string), whitespace-padded session names, register throwing, remove returning false.

**Patterns:**
- `makeStubRegistry()` pattern is now duplicated in relay.test.ts and handlers.test.ts — candidate for extraction into `tests/mocks/registry.ts` if a third test file needs it.
- `makeMockBot()` with handler capture is a reusable pattern for any future handler tests.

## Learnings

### 2026-04-13 — Phase 2 "Go Live" Test Coverage

Added 25 new tests (56 → 81 total), bringing handlers from 17 to 20 tests and adding a new test file for service installation.

**Test additions:**
1. **`/help` command tests** (2 tests in `tests/bot/handlers.test.ts`):
   - Verifies help message contains all four commands (/new, /list, /remove, /help)
   - Confirms /help works without a forum topic (general chat use case)
   - Pattern: same mock bot structure as existing handler tests

2. **Service installer tests** (6 tests in `tests/service/install.test.ts`):
   - TDD-style tests written *before* Noble Six's implementation of `src/service/install.ts`
   - Mocks `node-windows` Service class at module level with vi.mock()
   - Verifies install/uninstall commands create Service instances and call correct methods
   - Pattern: `vi.spyOn(process, 'exit').mockImplementation()` + `expect(() => fn()).toThrow()`

3. **TELEGRAM_CHAT_ID enforcement**: Skipped after investigation. The feature spans two locations:
   - main.ts env var validation (hard to test — process.exit without refactoring)
   - bot.ts middleware (testable but requires reaching into grammY internals — brittle)
   - Decision: both are simple guard clauses (<5 lines each) with clear behavior; integration tests would provide better ROI than unit tests that mock framework internals

**node-windows API surface:**
- Constructor: `new Service({ name, script, description })`
- Methods: `install()`, `uninstall()` (event-emitter based, but tests just verify calls)
- Module exports Service as `require('node-windows').Service`
- Tests use class mock rather than object mock (cleaner constructor verification)

**Test strategy insight:**
When writing TDD tests for a feature being implemented in parallel:
1. Read actual dependency APIs (node-windows source) rather than guessing
2. Mock at module level before any imports
3. Provide a reference implementation in the test that defines the contract
4. Once the real implementation lands, swap the reference impl for a dynamic import

Test count: 56 → 81 tests across 6 files (registry 17, relay 13, idleMonitor 13, handlers 20, impl 12, install 6). All passing.

### 2025-07-18 — `failAfter` semantics in `makeMockSession`

The `failAfter` parameter in `tests/mocks/sdk.ts` is an index check (`i === failAfter`), meaning the error fires *before* yielding the chunk at that index. `failAfter=0` throws before any chunks are yielded — that's a "fails at start" scenario, not mid-stream. To test genuine mid-stream failure, use `failAfter >= 1` with enough chunks so at least one is yielded before the throw. Fixed the "edits placeholder with error message when stream fails mid-response" test to use `makeMockSession(['Partial', ' answer'], 1)` so chunk 0 is yielded successfully before chunk 1 triggers the error.

### 2025-07-18 — Review fixes F2 and F9

**F2 — Service tests now test real code:**
- Refactored `src/service/install.ts`: exported `install`, `uninstall`, `createService` functions and added a `process.argv[1]` guard around `main()` so importing the module no longer triggers side effects.
- Rewrote `tests/service/install.test.ts` to import the real functions from `src/service/install.ts` instead of defining a local mock `runInstaller`. Mocks `node-windows` (with `vi.mock` providing a mock `Service` class that captures constructor config and supports `on()`/`install()`/`uninstall()`/`start()`), `fs` (for `existsSync`), and `process.exit` (with `vi.spyOn`).
- Test cases cover: install when script exists, install when script missing (exit 1), .env missing warning, `alreadyinstalled` event exits 0, uninstall creates service and calls `svc.uninstall()`, `createService()` returns correct config.
- Pattern note: the `process.argv[1]` guard (`endsWith('install.js') || endsWith('install.ts')`) is more reliable than `import.meta.url` comparison on Windows.

**F9 — /help in registration test:**
- Added `expect(commandHandlers.has('help')).toBe(true)` to the registration test in `tests/bot/handlers.test.ts` and updated the test description to include `/help`.

All 81 tests pass. TypeScript compiles clean.

### 2026-04-14 — Service Installer Tests: TDD Rewrite (Independent Author)

Persona review flagged service installer test strategy. As independent author, refactored install tests to import real code instead of mocks:

1. **install.ts exports refactored** — Extracted `install()`, `uninstall()`, `createService()` functions and added `process.argv[1]` guard around `main()` so importing the module no longer triggers side effects.

2. **tests/service/install.test.ts rewritten** — Imports real functions from `src/service/install.ts` instead of defining local mocks. Still mocks `node-windows` and `fs`, but now validates actual function behavior. Test cases cover: install when script exists, install when script missing (exit 1), .env missing warning, `alreadyinstalled` event exits 0, uninstall creates service and calls methods, `createService()` returns correct config.

3. **Handler tests enhanced** — Added 2 new tests for `/help` command registration and message content in `tests/bot/handlers.test.ts`.

4. **/help added to registration test** — Added `expect(commandHandlers.has('help')).toBe(true)` to verify the `/help` command is properly registered alongside `/new`, `/list`, `/remove`.

**Verification:** All 81 tests pass (6 install-specific, 2 /help, 73 others). TypeScript compiles clean.

### PR Review Fixes — Comments #4, #6, #8

**Comment #6 — Spy leak prevention:**
Moved `vi.spyOn(process, 'exit')`, `vi.spyOn(console, 'log/error/warn')` from module scope into `beforeAll` inside the describe block. Added `vi.restoreAllMocks()` in `afterAll` so spies are cleaned up when the test file finishes, preventing leaks if Vitest shares workers across files.

**Comment #8 — `main()` CLI entrypoint coverage (4 new tests):**
Exported `main()` from `src/service/install.ts` (added `export` keyword). Added a `main()` describe block with `process.argv` save/restore in local `beforeEach`/`afterEach`. Tests:
- No command (`['node', 'install.js']`) → exits 1, prints Usage
- Unknown command (`['node', 'install.js', 'restart']`) → exits 1, prints Usage
- `install` command → calls `svc.install()` via `install()`
- `uninstall` command → calls `svc.uninstall()` via `uninstall()`

**Comment #4 — History accuracy:**
Removed false claim that original 6 tests covered usage errors (no command / unknown command). Corrected `expect(fn).rejects.toThrow()` pattern to `expect(() => fn()).toThrow()` (synchronous, not async).

### 2026-04-14 — Phase 3: TDD Tests for Per-Session Model Override

Wrote 13 TDD tests defining the contract for per-session model override feature (other agents implementing in parallel). 

**Test additions:**
1. **Registry tests** (4 new tests in `tests/sessions/registry.test.ts`):
   - `register() with model persists model in entry` — validates model field is stored
   - `register() without model does not include model field` — backward compatibility
   - `load() reads back model from persisted data` — persistence round-trip
   - `load() handles legacy entries without model field` — legacy data compatibility
   - All 4 tests **PASSED** ✓ (registry already has model support)

2. **Relay tests** (3 new tests in `tests/relay/relay.test.ts`):
   - `relay passes entry.model to factory.create()` — model passed to create
   - `relay passes entry.model to factory.resume()` — model passed to resume
   - `relay passes undefined model when entry has no model` — backward compatibility
   - All 3 tests **PASSED** ✓ (relay already passes model parameter)

3. **Handler tests** (6 new tests in `tests/bot/handlers.test.ts`):
   - `/new name --model claude-opus-4.5 registers with model` — flag parsing
   - `/new name registers without model (backward compat)` — default behavior
   - `/new name --model (no value) shows error` — validation
   - `/new name --model with spaces in model name` — model name handling
   - `/list shows model when set` — display model in list output
   - `/help includes --model flag documentation` — help text update
   - All 6 tests **FAILED** ⏳ (waiting for handler implementation)

**Test count:** 107 total (101 passed, 6 waiting for implementation). All failures are expected TDD failures.

**TDD observations:**
- Registry and relay already had model support from other agents' work — tests passed immediately
- Handler tests define the UX contract: flag parsing (`--model <model>`), error messages, help text
- Mock factory pattern updated to accept model parameter (comment-only change for now)
- SessionEntry interface already had `model?: string` field from parallel work

### 2025-04-22 — Phase 3 Wave 2: Crash Recovery, HUD Footer, Permissions, Pairing Config, /pair

Wrote tests defining the contracts for four features being implemented in parallel by Noble Six (SDK impl.ts), Carter (relay.ts), and Kat (handlers.ts).

**Test additions:**

1. **Config tests** (NEW FILE: `tests/config/config.test.ts` — 7 tests):
   - `loadConfig returns empty object for missing file`
   - `loadConfig returns empty object for corrupt JSON`
   - `loadConfig loads valid config from file`
   - `saveConfig writes and loadConfig reads back` — round-trip persistence
   - `saveConfig creates parent directories` — directory creation
   - `saveConfig performs atomic write (tmp + rename)` — atomic safety
   - `getConfigPath() returns a platform-aware path` — path construction
   - All 7 tests **PASSED** ✓ (Noble Six already implemented pairing config)

2. **Relay tests** (added to `tests/relay/relay.test.ts`):
   - Updated ALL existing `new Relay(registry, factory)` calls to `new Relay(registry, factory, 'test-model')` (16 occurrences)
   - **HUD footer** (2 new tests):
     - `final message includes HUD footer with session model` — per-session model display
     - `final message includes HUD footer with global model when no per-session model` — fallback display
     - Both tests **PASSED** ✓ (Carter already implemented HUD footer)
   - **SDK crash recovery** (2 new tests):
     - `relay calls factory.resetForRestart() on non-timeout SDK error` — crash recovery trigger
     - `relay does NOT call resetForRestart() on stream timeout error` — timeout exemption
     - Both tests **FAILED** ⏳ (waiting for Carter's implementation in relay.ts)

3. **Handler tests** (added to `tests/bot/handlers.test.ts`):
   - Updated ALL existing `registerHandlers({ bot, registry, factory })` calls to include `globalModel: 'test-model'` (26 occurrences)
   - `/help text includes /pair command` — new command documentation
   - Test **PASSED** ✓ (Kat already added /pair to help text)

4. **Impl tests** (added to `tests/copilot/impl.test.ts`):
   - Added two `.skip` test groups with comments explaining what WOULD be tested if the SDK mock wasn't too coarse:
     - `SDK crash recovery (integration-level behavior)` — backoff, resetForRestart
     - `Permission policy (integration-level behavior)` — makePermissionHandler, approveAll/denyAll
   - These tests document the behavior but cannot be unit tested without importing the real SDK

**Test results:**
- **Total:** 130 tests (126 passed, 2 failed ⏳, 2 skipped with documentation)
- **Config:** 7/7 passed (Noble Six implemented)
- **HUD footer:** 2/2 passed (Carter implemented)
- **SDK crash recovery:** 0/2 passed (waiting for Carter)
- **Handler /pair:** 1/1 passed (Kat implemented)
- **Impl documentation:** 2 skipped tests with detailed comments

**Breaking change mitigation:**
- **Critical:** Updated ALL existing test calls that broke due to constructor/parameter changes:
  - `Relay` constructor now requires third parameter: `globalModel: string`
  - `HandlerOptions` now requires field: `globalModel: string`
- Used PowerShell regex to bulk-update all instances before adding new tests
- This prevented 42 tests from breaking due to the API changes

**Test strategy:**
- When writing TDD tests for parallel implementations:
  1. Read existing test files first to understand patterns
  2. Update existing tests for breaking changes FIRST (critical step)
  3. Write new tests using the same patterns
  4. Run tests to verify baseline is preserved before adding new tests
- Constructor/interface changes require careful attention to existing test calls
- `.skip` tests with detailed comments are acceptable when unit testing is impossible (real SDK dependency)

**Test count:** 107 → 130 tests across 7 files (all directories).

### 2025-04-30 — Integration Test Suite: Cross-Boundary Flow Testing

Wrote 3 integration test files covering critical cross-boundary flows that span multiple modules. These are "component integration" tests — they test DI wiring and cross-module behavior with mocked external boundaries (no real Telegram API, no real SDK).

**Test additions:**

1. **Chat ID enforcement** (`tests/integration/chat-id-enforcement.test.ts` — 6 tests):
   - Tests `createBot()` middleware + handler interaction
   - `allows messages from allowed chat ID` — middleware passes, relay triggered
   - `silently drops messages from disallowed chat IDs` — middleware blocks, no relay
   - `allows /help command from allowed chat ID` — command processed
   - `drops /help command from disallowed chat ID` — command blocked
   - `middleware is applied unconditionally` — multiple disallowed IDs blocked
   - Pattern: Create Bot with botInfo + manual middleware, simulate grammY Updates
   - **Edge case discovered:** grammY Bot requires explicit botInfo or bot.init() call before handleUpdate()

2. **Pairing flow** (`tests/integration/pairing-flow.test.ts` — 12 tests):
   - Tests config round-trip, pairing code validation, /pair handler behavior
   - Config tests: save→load round-trip, atomic write (tmp+rename), parent dir creation, ENOENT/corrupt JSON handling
   - Pairing code tests: 6-digit range validation (100000-999999), integer type, randomness
   - /pair handler tests: correct/wrong code validation, supergroup requirement, chat ID saving, missing chat ID handling
   - End-to-end test: generate code → validate → save config → verify persistence
   - Pattern: Direct Bot instantiation with botInfo, manual /pair handler registration, grammY Update simulation
   - **Key insight:** Pairing logic in main.ts is tightly coupled; tested component parts instead

3. **SDK crash recovery** (`tests/integration/sdk-crash-recovery.test.ts` — 9 tests):
   - Tests relay→factory→backoff recovery round-trip
   - Crash detection: `resetForRestart()` called on SDK errors, NOT on timeout errors
   - Cache clearing: all sessions evicted after SDK crash, single session on timeout
   - Recovery workflow: crash → reset → new session created successfully
   - Multi-crash handling: multiple sequential crashes with resetForRestart calls
   - Cache eviction test: dispose() clears cache, next message re-fetches
   - Pattern: Mock factory with crashing/working sessions, verify full recovery cycle
   - **Design decision:** Removed direct CopilotClientImpl backoff tests (SDK property is getter-only); tested through factory interface instead

**Test results:**
- **Total:** 130 → 148 tests (144 passed, 4 skipped)
- **Integration tests:** 27 new tests across 3 files
- All integration tests pass ✓
- TypeScript compiles clean ✓

**Testing patterns discovered:**

1. **grammY testing:**
   - Must provide botInfo in Bot constructor OR call bot.init() before handleUpdate()
   - Mock API client with `client: { callApi: vi.fn().mockResolvedValue(...) }` to prevent real network calls
   - Create realistic Update objects matching Telegram's API shape
   - Middleware can be tested in isolation (ctx→next pattern) OR through full bot.handleUpdate()

2. **Integration test scope:**
   - Test DI wiring and cross-module behavior, not unit-level logic
   - Mock at external boundaries (Telegram API, SDK), use real internal modules
   - Test "happy path + critical failures" — not every edge case (that's unit tests)
   - Use existing mock patterns (makeMockFactory, makeStubRegistry) for consistency

3. **Test file organization:**
   - `tests/integration/` directory for cross-boundary tests
   - Follow naming: `<feature>-flow.test.ts` or `<component>-enforcement.test.ts`
   - Include high-level describe blocks with "Integration:" prefix

**Key learnings:**
- Integration tests caught grammY initialization requirement that unit tests missed
- Testing component parts (config, code validation, handler logic) is valid when main workflow is tightly coupled
- Mock spies on internal properties (like CopilotClientImpl.sdk getter) don't work — test through public interface
- Fake timers work seamlessly across integration test boundaries

**Files created:**
- `tests/integration/chat-id-enforcement.test.ts`
- `tests/integration/pairing-flow.test.ts`
- `tests/integration/sdk-crash-recovery.test.ts`

**Test count:** 130 → 148 tests across 10 files (7 unit test files + 3 integration test files).

### 2026-04-30 — interactiveDestructive Permission Tests

Added two new test files for the interactiveDestructive permission system: `tests/copilot/permissions.test.ts` and `tests/bot/prompt.test.ts`.

**What the tests lock down:**
1. **Tool classification** (`tests/copilot/permissions.test.ts` — 12 checks):
   - Confirms `isDestructive()` returns `true` for coarse-grained write/exec tools (`edit`, `create`, `powershell`, `bash`, `git_commit`, `gh_pr_create`, `gh_issue_create`)
   - Confirms read-only tools (`view`, `grep`, `glob`) and unknown tools default to non-destructive
   - Verifies `DESTRUCTIVE_TOOLS` is a `Set` and contains the baseline destructive tool names

2. **Telegram permission prompt** (`tests/bot/prompt.test.ts` — 6 tests):
   - User approval resolves `true`; denial resolves `false`
   - Timeout resolves `false` and edits the prompt message to show timeout/denial
   - Long args are truncated in the outbound Telegram prompt text
   - Prompt is posted to the requested `message_thread_id`
   - Inline keyboard callback payloads use `perm:approve:{id}` / `perm:deny:{id}` and share the same request id

**Mock pattern:**
- Minimal fake bot with `bot.api.sendMessage`, `bot.api.editMessageText`, and `bot.on('callback_query:data', ...)`
- Callback simulation by invoking the captured handler with a fake `callbackQuery` context
- `vi.useFakeTimers()` for deterministic timeout coverage

**Implementation detail discovered:**
- `promptUserForPermission()` signature is positional: `(bot, chatId, topicId, toolName, args, timeoutMs?)`
- The prompt module registers one callback-query middleware per bot using a `WeakMap` registry keyed by request ID
- Args truncation currently uses `maxLength = 200` with `...` suffix (`slice(0, 197) + '...'`)

**Verification:**
- `npx vitest run tests/copilot/permissions.test.ts` ✓
- `npx vitest run tests/bot/prompt.test.ts` ✓
- `npm test` ✓ (`162 passed | 4 skipped`)

### 2026-05-01 — Phase 4 Wave 2: interactiveDestructive Permission Tests Complete

Completed test implementation for interactiveDestructive permission system across both classification and prompt UX layers.

**Coverage delivered:**

1. **Destructive tool classifier** (`tests/copilot/permissions.test.ts`):
   - Tests `isDestructive()` correctly identifies coarse-grained set: `edit`, `create`, `powershell`, `bash`, `git_commit`, `gh_pr_create`, `gh_issue_create`
   - Confirms read-only tools and unknown tools default to safe
   - Verifies classifier is stable and deterministic

2. **Permission prompt UX** (`tests/bot/prompt.test.ts`):
   - UUID-based routing: correct approval/denial routing to right prompt
   - 60-second timeout with state cleanup
   - Argument truncation (200 char max)
   - Message edits for approve/deny/timeout outcomes
   - Concurrent request isolation

3. **Integration test patterns:**
   - Component-part testing for config, code validation, handler logic
   - Factory interface testing (not getter-only private properties)
   - Proper grammY Bot initialization with botInfo

**Test metrics:**
- Total: 162 passed, 4 skipped (166 total across 12 files)
- New: 18 tests (permissions.test.ts + prompt.test.ts)
- Baseline: 144 passed + 4 skipped maintained

**Key discovery:** SDK permission requests often omit `toolName`, providing only generic `kind` field (`'shell'`, `'write'`). Added compatibility mapping in impl.ts to normalize these before classification, so coarse-grained policy works across known SDK permission kinds even when toolName is missing.

