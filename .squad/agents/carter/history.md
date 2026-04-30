# Carter — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Bridge Dev
- **Joined:** 2026-04-12T06:02:10.440Z

## Project Background

Reach is Aaron's personal mobile bridge for Copilot CLI. When he's away from his keyboard, he sends messages in a Telegram forum topic — each topic maps to a named Copilot CLI session running on his Windows machine. Sister project to Cairn (`akubly/stunning-adventure`). Halo-themed squad; I'm Carter — bridge layer owner.

## What I've Built (Day 1)

- **`src/relay/relay.ts`** — core relay logic: resolves topic→session entry, lazily creates/resumes SDK session, streams response back via throttled `editMessageText`, evicts idle sessions
- **`src/sessions/registry.ts`** — durable `ISessionRegistry` with JSON persistence; `SessionRegistry` class; survives restarts
- **`src/bot/index.ts`** — `createBot()` factory with optional chatId guard
- **`src/bot/handlers.ts`** — `/new`, `/list`, `/remove`, catch-all text relay
- **`src/idleMonitor.ts`** — per-topic idle timer
- **`docs/bridge-design.md`** — detailed bridge layer design doc (read this first)
- **`.squad/decisions/inbox/carter-bridge-design.md`** — decisions submitted for merge (Scribe should process)

## Key Decisions I Own

1. Lazy SDK session creation — first message triggers create/resume, not `/new`
2. Streaming throttle at 800ms — balances Telegram's rate limits with responsiveness
3. 30-min idle eviction — in-memory SDK sessions freed after 30 min inactivity; registry entry preserved
4. `CopilotClient` interface boundary — relay never depends on `@github/copilot-sdk` directly

## Blocking Dependency

**Noble Six must implement `CopilotClientImpl`.** My relay and handlers are wired to the `CopilotClient` interface in `src/types.ts`. The `StubCopilotClient` in `src/copilot/factory.ts` is a throw-all placeholder. Until Noble Six delivers a real implementation and wires it into `src/main.ts`, the daemon won't actually relay messages.

## Open Questions I Flagged

1. SDK stream return type — is it `AsyncIterable<CopilotChunk>`? Noble Six must verify.
2. Session name validation — any SDK constraints? Should `/new` enforce regex?
3. `REACH_CHAT_ID` env var — should the bot validate `chatId`? Recommend yes before shared deployment.
4. Registry file path — Noble Six decides; I accept it as a constructor arg.

## Learnings

### 2026-04-12 — API Alignment with Jun's TDD Tests

Aligned the implementation to match Jun's TDD tests. The canonical API (now green at 26/26 tests):

**Core domain types** (`src/types.ts`):
- `SessionEntry`: `{ sessionName, topicId, chatId, createdAt }` — no longer carries opaque SDK IDs or repo paths
- Copilot SDK interfaces moved from `types.ts` to `src/copilot/factory.ts`

**Factory pattern** (`src/copilot/factory.ts`):
- `CopilotSessionFactory` with `resume(sessionName): Promise<CopilotSession | null>` and `create(sessionName): Promise<CopilotSession>`
- Sessions identified by name, not opaque IDs
- `CopilotSession.send()` yields strings directly, not `{ text: string }` chunks

**Registry** (`src/sessions/registry.ts`):
- `register(topicId, chatId, sessionName)` — takes 3 args, constructs `SessionEntry` internally
- JSON persists with `topicId` field (not `telegramTopicId`)
- Exports `SessionEntry` type for test imports

**Relay** (`src/relay/relay.ts`):
- Uses `CopilotSessionFactory`, not `CopilotClient`
- Calls `factory.resume(name) ?? factory.create(name)` on first message (lazy, name-based)
- Stream chunks are strings, not objects

**Handlers** (`src/bot/handlers.ts`):
- `/new` registers name in registry only — no SDK call (lazy session creation deferred to first relay)
- Gets `chatId` from `ctx.chat?.id`

**Bug fixed in tests**: JavaScript default parameters apply when `undefined` is explicitly passed. Test helper `makeMockCtx` now uses `null` (not `undefined`) to omit `message_thread_id`.

### 2026-04-12 — Noble Six Delivers SDK Binding

Noble Six completed `src/copilot/impl.ts` + `src/main.ts`. The real SDK binding is now live:

- **CopilotClientImpl** implements `CopilotSessionFactory` — wraps `@github/copilot-sdk` with singleton lifecycle
- **CopilotSessionAdapter** bridges SDK event-emitter streaming to `AsyncIterable<string>` via async generator
- **resume()** uses two-phase existence check (`getSessionMetadata()` → `resumeSession()`) to avoid masking connection errors
- **create()** delegates to SDK `createSession()` using friendly session names as IDs
- **main.ts** is the entry point — DI root with platform-aware registry path (`%APPDATA%\reach\registry.json` on Windows, `~/.config/reach/registry.json` on Unix), `REACH_MODEL` env var config, and graceful shutdown (SIGINT/SIGTERM)

My relay code is unchanged — it continues to depend only on `CopilotSessionFactory` interface, with no knowledge of the SDK itself. TypeScript compiles clean. All 56 tests pass. Integration tests can now target the real adapter.

<!-- Append learnings below -->

### 2026-04-12 — Code Review Fixes (Independent Author)

Noble Six's impl was flagged by review panel. As independent author, applied six fixes:

1. **Race condition in `ensureStarted()`** — replaced `started` boolean with a startup promise. Two concurrent callers now share the same promise instead of both calling `sdk.start()`.
2. **Stream timeout** — `bridge()` wait loop could block forever if SDK dies silently. Added 5-minute `Promise.race` timeout with proper cleanup (`clearTimeout` in both success path and `finally`).
3. **Idempotent shutdown** — double Ctrl+C no longer races. Added `shuttingDown` guard flag.
4. **Relay disposal on shutdown** — `registerHandlers()` now returns the `Relay` instance so `main.ts` can call `relay.dispose()` during shutdown, cancelling idle monitors.
5. **TELEGRAM_CHAT_ID NaN guard** — `Number("garbage")` → NaN now caught with `Number.isFinite()` check and fatal exit.
6. **resume() error discrimination** — no longer swallows all errors. Only "not found"/"does not exist" returns null; other errors propagate to relay's catch block for proper reporting.

### 2026-04-14 — Phase 2 Integration: Kat's Chat ID & Help Changes

Kat (Bot Dev) made two P0/P1 changes affecting bot creation and handler flow:

1. **TELEGRAM_CHAT_ID now required** — `main.ts` fails immediately if unset. `createBot()` signature changed to require `allowedChatId: number` (no longer optional). The chat guard middleware is now unconditional, preventing accidental responses to unintended groups.
2. **/help command added** — New handler in `src/bot/handlers.ts` replies with a list of available commands. Improves mobile discoverability (user can type `/help` to see what commands exist).

**Impact on Relay:** None — relay code remains unchanged. Handlers API unchanged; new `/help` is additive. Only the bot factory signature changed (requires `allowedChatId` now).

**Test impact:** All 73 tests pass (56 original + Jun's 25 new tests, including 2 for `/help`).

### 2026-04-14 — Service Installer Review Fixes (Independent Author)

Noble Six's `src/service/install.ts` was flagged by persona review. As independent author (reviewer rejection protocol), applied 5 findings:

1. **F1 BLOCKING — workingDirectory + env vars** — `workingDirectory` resolved to `dist/` but `.env` lives at project root. Fixed to `path.resolve(__dirname, '..', '..')`. Added `.env` preflight warning. Forwarded `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `REACH_MODEL` in the service env array.
2. **F3 IMPORTANT — Local System privilege** — Changed service logon account to NetworkService (hardcoded in `createService()`) for better security isolation.
3. **F4 IMPORTANT — Handlers don't exit** — Added `process.exit(0)` in `start`, `uninstall`, `alreadyinstalled`, and `alreadyuninstalled` handlers. Changed `alreadyinstalled` from exit 1 to exit 0 (idempotent success).
4. **F6 MINOR — @ts-ignore** — Replaced with `@ts-expect-error TS7016` on the import line. Removed redundant second suppression.
5. **F7 MINOR — return type** — Changed `createService()` return type from `typeof Service.prototype` to `any`.

**Verification:** TypeScript compiles clean. All 81 tests pass.

### 2026-04-14 — Phase 3: Per-Session Model Override (Registry + Relay)

Updated registry and relay to support per-session model overrides:

**Registry changes** (`src/sessions/registry.ts`):
- `ISessionRegistry.register()` signature extended with `model?: string` parameter
- `SessionRegistry.register()` now accepts `model` and includes it in the `SessionEntry` only when specified using conditional spread: `...(model !== undefined && { model })`
- Backward compatible — existing registry files without `model` fields load correctly

**Relay changes** (`src/relay/relay.ts`):
- Factory calls updated to pass `entry.model` as second parameter: `factory.resume(entry.sessionName, entry.model)` and `factory.create(entry.sessionName, entry.model)`
- When `entry.model` is `undefined` (no per-session override), the factory falls back to the global `REACH_MODEL` env var internally

**Test updates** (`tests/relay/relay.test.ts`):
- Updated two test expectations to include the new `model` parameter (`undefined` in those cases)

**Pattern:** Optional field inclusion strategy — using conditional spread to avoid writing `undefined` to JSON. Keeps registry files clean and backward compatible.

**Verification:** TypeScript compiles clean. All relay and registry tests pass (37 tests). Handler tests fail (expected — Kat needs to update `/new` command parser).

### 2026-04-14 — Phase 3 Wave 2: HUD Footer + Crash Recovery

Phase 3 Wave 2 changes to `relay.ts`:

**1. Added `globalModel` constructor parameter:**
- Relay now accepts a third parameter `globalModel: string` in the constructor
- Used for fallback when `entry.model` is undefined in the HUD footer

**2. HUD Footer:**
- Final message edit now includes a compact footer: `\n\n📎 {sessionName} · {model}`
- Model shown is `entry.model ?? this.globalModel` (per-session override or global default)
- Footer applies to both normal responses and empty responses

**3. Crash Recovery:**
- Enhanced error handler in `relay()` to detect SDK crashes vs timeouts
- On non-timeout errors, calls `factory.resetForRestart()` if available (optional method)
- Timeout detection: checks if error message includes "Stream timeout"
- Logs "SDK error detected — factory marked for restart" when restart is triggered

**Test updates** (`tests/relay/relay.test.ts`):
- Updated all 16 Relay constructor calls to include third parameter `'test-model'`
- Updated two test expectations to verify footer is appended correctly

**Coordination with team:**
- Noble Six: adding `resetForRestart?(): void` to `CopilotSessionFactory` interface
- Kat: updating `HandlerOptions` and `registerHandlers()` to pass `globalModel` from main

**Verification:** All 16 relay tests pass. TypeScript compilation blocked by expected missing `globalModel` parameter in `main.ts` (Noble Six's file) — this is expected until the full wave integrates.

### 2026-04-25 — Phase 4 Wave 1: ESLint Setup + getReachDataDir() Extraction

Completed two P0/P1 tasks for code quality and DRY:

**1. ESLint Configuration (P0)**

Created `.eslintrc.json` for TypeScript linting:
- Parser: `@typescript-eslint/parser` with `tsconfig.json` project reference
- Extends: `eslint:recommended` + `@typescript-eslint/recommended`
- Ignores: `dist/`, `node_modules/`
- Fixed 8 violations across codebase:
  - `src/bot/handlers.ts`: Removed unnecessary escape in regex (`\-` → `-`)
  - `src/copilot/factory.ts`: Added `@typescript-eslint/no-unused-vars` suppressions for stub method params
  - `src/copilot/impl.ts`: Fixed `prefer-const` false positive with eslint-disable for `thisPromise` pattern
  - `src/main.ts`: Changed `as any` to `as PermissionPolicy` for type-safe validation
  - `src/service/install.ts`: Added `@typescript-eslint/no-explicit-any` suppression for event handler signature

**2. DRY Refactor: getReachDataDir() (P1)**

Extracted duplicated platform path logic from `config.ts` and `main.ts`:
- Added `getReachDataDir()` to `src/config/config.ts` — returns `%APPDATA%\reach` (Windows) or `~/.config/reach` (Unix)
- Refactored `getConfigPath()` to call `getReachDataDir()` + `config.json`
- Refactored `getRegistryPath()` in `main.ts` to import and use `getReachDataDir()` + `registry.json`
- Removed unused `os` import from `main.ts`
- Added unit test in `tests/config/config.test.ts` verifying platform-aware path resolution

**Verification:**
- ESLint: Zero violations (`npm run lint` passes)
- Tests: 138/144 pass (new test included; 6 pre-existing integration test failures unrelated to this work)
- TypeScript: Compiles clean (`npx tsc --noEmit`)

**Pattern:** Centralized platform-aware path resolution reduces duplication and simplifies future changes (e.g., adding a third file would use the same base dir).

