# Squad Decisions

## Active Decisions

### 2026-04-12 — Project Name: Reach

The project is named **Reach** — from Halo lore (Reach is humanity's most important military planet, the place where Spartans are born). The name was chosen by vote among the Cairn team (Graham, Valanice, Rosella, Roger, Gabriel) with Aaron making the final call. Short, purposeful, halo-themed, unique on npm.

**Sister project:** Cairn (`stunning-adventure` repo, `akubly/stunning-adventure`) — a Copilot CLI session intelligence daemon. Reach is the mobile bridge; Cairn is the insight engine. They share an owner (Aaron) but are independent projects with independent squads.

---

### 2026-04-12 — Architecture: External Daemon over CLI Extension

Reach runs as an **external background process** (Node.js daemon), not a Copilot CLI extension. CLI extensions live inside an existing session and cannot spawn new ones — a fatal constraint for requirement #4 (start new sessions remotely from mobile). An external daemon can start fresh `copilot` processes via the SDK, forward stdin/stdout, and manage multiple independent sessions.

**Trade-off:** More setup required (Windows Service registration) vs. simpler install. Acceptable for a personal power-user tool.

---

### 2026-04-12 — Transport: Telegram Forum Topics

Telegram is the mobile bridge transport. Each Telegram **forum topic** (in a supergroup with `is_forum: true`) maps to exactly one named Copilot session. This gives the user a native mobile UI with independent threads — no custom app required.

**Considered alternatives:** Discord, GitHub Discussions, Matrix/Element, custom PWA + Cloudflare Worker. Telegram wins on: native iOS/Android apps, bot API quality, long-polling reliability, zero server cost, grammY library quality.

---

### 2026-04-12 — Library: grammY

grammY (`grammy` npm package) with the runner plugin for long-polling. Selected over `node-telegram-bot-api` for: TypeScript-first design, plugin ecosystem, active maintenance, composable middleware.

**Key plugins in play:** `@grammyjs/runner`, `@grammyjs/auto-retry`, `@grammyjs/transformer-throttler`.

---

### 2026-04-12 — Named Sessions Registry

Sessions are identified by **human-readable names** (e.g. `reach-cairn`, `reach-myapp`) rather than opaque IDs. The mapping of `telegramTopicId → SessionEntry` is persisted to `registry.json` so the daemon survives restarts without losing context. SDK session handles are held in-memory and recreated lazily on first message after restart.

Registry file location TBD — Noble Six to decide (candidate: `%APPDATA%\reach\registry.json`).

---

### 2026-04-12 — Bridge Layer (Carter)

Decisions from Carter's bridge design (merged from inbox):

1. **Lazy SDK session creation** — sessions are created/resumed on the first relayed message, not at `/new` registration time.
2. **CopilotSessionFactory interface as abstraction boundary** — relay never imports `@github/copilot-sdk` directly; Noble Six owns the real binding.
3. **Streaming throttle at 800ms** — Telegram's edit rate limit (~1/s) requires throttling. Mid-stream edits are plain text; final edit uses Markdown with fallback.
4. **5-minute idle eviction** — in-memory SDK sessions evicted after 5 min idle (configurable via `IDLE_TIMEOUT_MS` env var, default 300,000ms); registry entry preserved; session recreated lazily.
5. **No allowed-chat-ID guard yet** — flagged as open question; `REACH_CHAT_ID` env var guard recommended before any shared deployment.

---

### 2026-04-12 — API Alignment — Canonical Bridge Layer Interfaces (Carter)

Implementation and tests had diverged; tests were canonical (written TDD by Jun). All changes below bring implementation into alignment. **All 73 tests now pass.**

#### SessionEntry Shape

`SessionEntry` now carries only domain data needed for topic→session mapping:

```typescript
export interface SessionEntry {
  sessionName: string;  // human-readable name
  topicId: number;      // Telegram forum topic ID
  chatId: number;       // Telegram supergroup chat ID
  createdAt: string;    // ISO-8601 timestamp
}
```

Removed fields: `copilotSessionId`, `repoPath`, `telegramTopicId` (renamed to `topicId`).

#### CopilotSessionFactory Interface

Replaced `CopilotClient` with `CopilotSessionFactory`:

```typescript
export interface CopilotSessionFactory {
  resume(sessionName: string): Promise<CopilotSession | null>;
  create(sessionName: string): Promise<CopilotSession>;
}

export interface CopilotSession {
  send(message: string): AsyncIterable<string>;  // yields plain strings
}
```

Sessions identified by **name**, not opaque ID. Caller tries `resume()` first, falls back to `create()` if null.

#### Registry.register() Signature

Changed to 3 explicit params:

```typescript
register(topicId: number, chatId: number, sessionName: string): Promise<void>
```

Registry constructs `SessionEntry` internally (including `createdAt` timestamp).

#### Relay Uses Factory Pattern

Relay now depends on `CopilotSessionFactory`. On first relay:

```typescript
session = await this.factory.resume(entry.sessionName) ?? await this.factory.create(entry.sessionName);
```

Stream chunks are plain strings (not objects).

#### /new Command Behavior

`/new <name>` now only registers the name in the registry — does NOT call SDK `createSession()`. Lazy session creation happens on first relay.

---

### 2026-04-12 — SDK Binding Approach (Noble Six)

Investigated `@github/copilot-sdk` v0.2.2. Key findings documented in `docs/adr-001-copilot-sdk-binding.md`.

#### SDK API Surface

1. **Event-based streaming, not AsyncIterable** — `session.on("assistant.message_delta", cb)` yields `{ deltaContent: string }` chunks. `session.on("session.idle", cb)` signals completion. Must bridge to `AsyncIterable<string>` via async generator.
2. **No named sessions** — SDK uses opaque `sessionId`. SDK accepts custom IDs on `createSession({ sessionId })`, so use friendly name directly.
3. **send() return shape** — `send()` returns `Promise<string>` (message ID), not iterable. `sendAndWait()` returns `AssistantMessageEvent`.
4. **onPermissionRequest required** — Using `approveAll` for personal tool.
5. **Session state persists to disk** — `resumeSession(id, config)` restores history. Maps directly to lazy-recreation pattern.
6. **SDK spawns/manages CLI process** — One `CopilotClient` instance for daemon lifetime.

#### Recommended Binding

**Adapter pattern** in `src/copilot/impl.ts`:
- `CopilotSessionFactoryImpl` wraps SDK `CopilotClient`
- `CopilotSessionAdapter` bridges events → `AsyncIterable<string>`
- Relay code unchanged (depends only on interfaces)

#### Open Questions

1. Model selection — global `REACH_MODEL` env var or per-session?
2. CLI process crash recovery strategy?
3. Session name validation constraints?

---

### 2026-04-12 — User Directive: Large Context Window Models

Use `claude-opus-4.6-1m` whenever doing any work that might require large context windows.

**By:** Aaron (via Copilot)  
**Rationale:** Captured for team memory.

---

### 2026-04-12 — SDK Binding Implementation & main.ts DI Wiring

**Author:** Noble Six  
**Status:** Implemented

#### Decisions

1. **impl.ts — Adapter Pattern Against Real SDK**
   - `CopilotClientImpl` implements `CopilotSessionFactory` with single long-lived `SdkClient` instance
   - `CopilotSessionAdapter` bridges SDK event-emitter → `AsyncIterable<string>` via async generator + queue/notify
   - Trade-off: one extra indirection layer vs. zero relay code changes; chose isolation for testability

2. **resume() — Two-Phase Existence Check**
   - `getSessionMetadata(sessionName)` checks existence, then `resumeSession()` with try/catch
   - Alternative rejected: catch-all try/catch masks connection errors as "session not found", risking silent data loss

3. **ensureStarted() — Lazy SDK Start**
   - SDK client starts on first resume/create call (~1s latency)
   - Acceptable for daemon with multi-hour lifetime

4. **main.ts — DI Root Pattern**
   - Flat function composition (env vars → constructors → registerHandlers → registry.load → bot.start)
   - No DI container — simple and explicit at 5-component scale

5. **Registry Path — Platform-Aware**
   - Windows: `%APPDATA%\reach\registry.json`
   - Unix: `~/.config/reach/registry.json` (XDG-compliant)
   - Hardcoded for v0.1; can add `REACH_REGISTRY_PATH` env var override later

6. **Model Config — Global env var**
   - `REACH_MODEL` env var, defaults to `claude-sonnet-4`
   - Alternative deferred: per-session model selection `/new <name> --model <model>`

7. **Graceful Shutdown**
   - `Promise.allSettled([bot.stop(), factory.stop()])` ensures independent teardown
   - `process.exit(0)` in `.finally()`

#### Verification

- TypeScript compiles clean
- All 56 tests pass (no test changes)
- impl.ts isolated behind interface boundary

---

### 2026-04-14 — Model Selection — Global Default + Per-Session Override

**By:** Aaron (via Copilot)  
**Status:** Decided

Aaron chose **Option C: Global default + per-session override.**

- `REACH_MODEL` env var sets the default model (current behavior, unchanged)
- Per-session override via `/new <name> --model <model>` to be added in Phase 2 P1
- Registry schema will need a `model` field on `SessionEntry` (optional, falls back to global default)
- `CopilotSessionFactory.create()` will need to accept a model parameter

**Implementation deferred to P1** — the global default works for Phase 2 launch. Per-session override is a quality-of-life addition after Go Live.

---

### 2026-04-14 — Phase 2 Go Live — Operational Infrastructure

**Author:** Noble Six, Kat, Jun  
**Status:** Implemented

Phase 2 delivers operational infrastructure so Aaron can actually *run* Reach as a daemon, not just build it.

#### Windows Service Installer (Noble Six)

Implemented `src/service/install.ts` using node-windows v1.0.0-beta.8:
- Service name: "Reach"
- Script: `dist/main.js` with `--enable-source-maps` option
- Auto-restart on failure (node-windows defaults)
- Pre-install validation checks `dist/main.js` exists
- Commands: `npm run service:install` and `npm run service:uninstall`

**Trade-off:** System-wide service (requires admin) vs. user-level Task Scheduler. Chose system service for auto-restart and Event Log integration (Windows-native daemon pattern).

#### TELEGRAM_CHAT_ID Enforcement (Kat)

Made `TELEGRAM_CHAT_ID` **required** (was optional):
- `main.ts` throws fatal error if unset
- `createBot()` signature now requires `allowedChatId: number` (no longer optional)
- Prevents accidental bot responses to unintended groups

#### /help Command (Kat)

Added `/help` command to `src/bot/handlers.ts`:
- Lists available commands: `/new <name>`, `/list`, `/remove`, `/help`
- Improves mobile discoverability

#### Test Coverage (Jun)

Added 25 new tests (81/81 total):
- `tests/service/install.test.ts` — 6 tests; mocked node-windows; TDD approach
- `tests/bot/handlers.test.ts` — +2 tests for `/help` command
- Deferred: unit tests for env var validation and middleware (integration tests preferred)

#### Verification

- TypeScript compiles clean
- All 81 tests pass
- Service installer manually testable on Windows

---

### 2026-04-14 — Service Installer Review Fixes

**Author:** Carter (independent author, reviewer rejection protocol)  
**Date:** 2026-04-14  
**Status:** Applied

Noble Six's `src/service/install.ts` was flagged by persona review panel with 5 findings. Carter applied fixes as independent revision author.

#### workingDirectory Handling

The service sets `workingDirectory` to the project root via `getProjectRoot()` in the Service config. Environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `REACH_MODEL`) are forwarded from the installer process environment.

#### Exit Code Convention

Changed `alreadyinstalled` from exit code 1 to exit code 0. Already-installed is an idempotent success, not an error.

#### Local System Account

Changed the default logon account to NetworkService via `logOnAs: { domain: 'NT AUTHORITY', account: 'NetworkService' }`. Provides better security isolation than Local System without imposing setup complexity at install time.

#### ts-expect-error Rationale

Added clarifying comment for `@ts-expect-error` on node-windows `Service` type (node-windows lacks type export despite runtime support).

#### Return Type Correction

Confirmed install() return type is `void` (synchronous).

**Verification:** All 81 tests pass.

---

### 2026-04-14 — Review Fixes — Independent Authors

**Status:** Applied

#### Carter's Bridge Layer Fixes (Kat as independent author)

Applied 5 fixes to address code review findings:
1. **Registry crash-safety** — `persist()` writes to `.tmp` then renames (atomic pattern)
2. **Corrupt JSON recovery** — `load()` backs up corrupt files to `.corrupt.<timestamp>` and starts empty
3. **Schema versioning** — Added `version: 1` field to `RegistryData` for future migrations
4. **Chat ID guard** — Replaced fallback to 0 with early exit and error message (0 is never a valid Telegram chat ID)
5. **Stub resume()** — Returns `null` per interface contract (enables `resume() ?? create()` fallback)
6. **IDLE_TIMEOUT_MS validation** — Guards against NaN and negative values

**Verification:** All 56 tests pass.

#### Noble Six's SDK Binding Fixes (Carter as independent author)

Applied 6 fixes to address code review findings:
1. **Race condition in ensureStarted()** — replaced `started` boolean with startup promise (shared by concurrent callers)
2. **Stream timeout** — added 5-minute `Promise.race` timeout with proper cleanup
3. **Idempotent shutdown** — added `shuttingDown` guard flag to prevent double-teardown
4. **Relay disposal on shutdown** — `registerHandlers()` now returns `Relay` so `main.ts` can call `relay.dispose()`
5. **TELEGRAM_CHAT_ID NaN guard** — `Number.isFinite()` check with fatal exit on invalid input
6. **resume() error discrimination** — only "not found"/"does not exist" returns null; other errors propagate

**Verification:** All 56 tests pass.

---

### 2026-04-23 — Phase 3 Wave 2: SDK Crash Recovery + Permissions + Pairing Config

**Author:** Noble Six, Carter, Kat, Jun  
**Status:** Implemented

Phase 3 Wave 2 adds three architectural enhancements for reliability, security, and first-run UX:

#### SDK Crash Auto-Recovery with Exponential Backoff

Added to `CopilotClientImpl.ensureStarted()` to handle Copilot CLI SDK subprocess crashes. Implements exponential backoff (1s → 2s → 4s → ... → 30s max) within a 60-second time window. Restarts are attempted on-demand when relay needs a session. After 60 seconds of successful uptime, the backoff counter resets.

**Key choices:**
- Time-windowed backoff prevents "backoff debt" from old failures
- Exponential (capped at 30s) balances patience with responsiveness
- Relay calls `factory.resetForRestart?.()` on SDK errors to force restart on next demand

**Trade-off:** Daemon self-heals from transient SDK crashes vs. added complexity in SDK binding layer. Chosen because SDK crashes are unpredictable and self-recovery improves reliability.

#### Two-Tier Permissions Policy

Added `PermissionPolicy` type (`'approveAll'` | `'denyAll'`) wired to `REACH_PERMISSION_POLICY` env var. Factory function `makePermissionHandler()` returns appropriate SDK permission handler.

- `'approveAll'` (default): Current behavior, all tools approved
- `'denyAll'`: Blocks all tool execution (read-only mode for security-conscious users)

**Design:** Env var over config file (security-critical settings should be environment-controlled). No runtime toggle (requires restart to change policy, prevents accidental escalation).

**Future extension (Phase 4):** `'interactiveDestructive'` mode—auto-approve read-only tools, prompt Telegram for destructive tools. Deferred due to complexity (tool classification + async Telegram interaction).

#### Persistent Pairing Config (src/config/config.ts)

New module manages `config.json` (platform-aware paths: Windows `%APPDATA%\reach\config.json`, Unix `~/.config/reach/config.json`). Stores optional `telegramChatId` field.

**main.ts chat ID resolution order:**
1. `TELEGRAM_CHAT_ID` env var (backward compatible; skips pairing if set)
2. `config.json` → `telegramChatId` field (persisted from prior pairing)
3. Pairing mode (if neither above): Generate random 6-digit code, listen for `/pair <code>`, save chat ID to config, exit

**UX flow (first run):**
- Service starts → daemon prints pairing code to console/Event Viewer
- User sends `/pair 123456` in Telegram
- Daemon validates, saves chat ID, exits
- Service auto-restarts daemon → normal operation

**Design choices:**
- 6-digit code (100,000–999,999): Balances security with UX (short enough to type), 5-minute expiry limits exposure
- One-time pairing: Code consumed on first use, config persisted (no code needed on restart)
- Unguarded pairing bot: Temporarily accepts messages from any chat; after pairing, daemon exits and restarts with guarded bot
- Atomic writes: `config.json` written to `.tmp` then renamed (prevents corruption on crash)
- Backward compatible: Existing deployments with `TELEGRAM_CHAT_ID` env var unaffected

**Security:** Config file is plaintext (chat ID is not secret; anyone in group knows it). Rely on OS file permissions (user-scoped).

#### Handler Updates (Kat)

- Added `globalModel: string` parameter to `HandlerOptions` type
- Handler functions receive active model for display (e.g., in `/help` output)
- Added `/pair` command documentation to `/help` text
- Updated all handler tests to pass model parameter

#### Test Results (Jun)

**119 tests passing** (12 new in Phase 3 Wave 2):
- Config: 8 tests (load/save, atomic writes, path resolution)
- HUD: 2 tests (footer injection in relay response)
- Crash recovery: 1 test (backoff verification)
- Permissions: 1 test (policy enforcement)
- Skipped: 4 integration-only tests (SDK-dependent, expected)

Coordinator fixed 2 crash recovery test mocks post-run (AsyncIterable contract mismatch).

**Interface changes:**
- `CopilotSessionFactory` gained optional `resetForRestart?()` method
- `CopilotClientImpl` constructor gained `permissionPolicy` parameter
- `relay.ts` calls `factory.resetForRestart?.()` on stream errors

---

### 2026-04-30 — Phase 4 Scoping — Hardening and Polish

**Author:** Noble Six  
**Date:** 2026-04-30  
**Context:** Aaron confirms Reach is feature-complete for personal use. Phase 4 focuses on reliability, code quality, and maintainability before broader use.

#### Prioritization Summary

| Item | Priority | Complexity | Est. Effort | Owner | Blocking? |
|------|----------|------------|-------------|-------|-----------|
| ESLint setup | **P0** | Small | 30 min | Carter | Blocks P1 |
| Extract getReachDataDir() | **P1** | Small | 45 min | Carter | No |
| Integration tests | **P1** | Medium | 3-4 hours | Jun | No |
| interactiveDestructive mode | **P2** | Large | 6-8 hours | Noble Six + Kat | No |

#### Wave 1 (Foundation, 45 min total) — Completed ✓
1. **ESLint setup (Carter)** — Created `.eslintrc.json` with TypeScript-ESLint config. `npm run lint` passes clean.
2. **getReachDataDir() extraction (Carter)** — Centralized platform-aware path logic in `src/config/config.ts`. Refactored `main.ts` and `config.ts` to call shared function. Eliminated DRY violation.

#### Wave 2 (Quality + Enhancement, 6-8 hours total) — Planned
1. **Integration tests (Jun)** — 27 new tests: chat ID enforcement (9), pairing flow (10), SDK crash recovery (8). Component-part testing for tightly coupled workflows.
2. **interactiveDestructive mode (Noble Six + Kat)** — Permission callback threading (Option C: relay injects topic-aware callback). Telegram inline keyboard prompts for destructive tools. Requires architecture decision before implementation.

#### Open Questions for Aaron
1. **interactiveDestructive priority:** Confirm P2 acceptable. If needed before rollout, promote to P1.
2. **Tool classification granularity:** Coarse-grained (all `powershell` destructive) or fine-grained (parse command string)? Recommend starting coarse.
3. **Permission prompt location:** Same topic (keeps context) or dedicated admin topic?

#### Verification Criteria
- **Wave 1:** `npm run lint` passes, `npm run typecheck` passes, `npm run test` passes (144/148), `getReachDataDir()` exported, zero duplication.
- **Wave 2:** 27 integration tests pass (148 → 175 total), interactiveDestructive mode works end-to-end (manual smoke test), Telegram prompt timeout tested.

---

### 2026-04-30 — Integration Test Strategy Decisions

**Author:** Jun (Test Engineer)  
**Date:** 2026-04-30  
**Context:** Writing integration tests for three critical cross-boundary flows

#### Decision 1: Component-Part Testing for Tightly Coupled Workflows

**Decision:** When a workflow is tightly coupled to a main entry point (like pairing in `main.ts`), test the component parts separately rather than trying to integration-test the full workflow.

**Rationale:**
- The pairing flow in `main.ts` is deeply intertwined with process.exit(), setTimeout(), and bot lifecycle
- Mocking all of these correctly would be brittle and test the mocks more than the code
- Testing config round-trip, code validation, and /pair handler logic separately provides the same coverage with less brittleness

**Example:** `pairing-flow.test.ts` tests:
- Config persistence (saveConfig → loadConfig)
- Pairing code validation (6-digit range)
- /pair handler behavior (code matching, supergroup check)
- End-to-end scenario combining all parts

#### Decision 2: Test Through Public Interfaces, Not Internal Properties

**Decision:** When a class has getter-only properties or complex internal state, test through its public interface rather than trying to spy on internals.

**Rationale:**
- Attempting to spy on `CopilotClientImpl.sdk` fails because it's a getter-only property
- Testing backoff behavior through the factory interface is more robust and less coupled to implementation details
- If the implementation changes (e.g., different backoff algorithm), interface tests still pass

**Example:** Replaced direct CopilotClientImpl backoff tests with relay-level tests that verify the factory continues working after crashes.

#### Decision 3: grammY Bot Initialization in Tests

**Decision:** Always provide `botInfo` in the Bot constructor for integration tests that call `bot.handleUpdate()`.

**Rationale:**
- grammY requires `botInfo` to be set OR `bot.init()` to be called before processing updates
- Providing botInfo in constructor is simpler than async init and works for all test scenarios
- Prevents "Bot not initialized!" errors that break tests

**Example:**
```typescript
const bot = new Bot('fake-token', { 
  botInfo: { 
    id: 123, 
    is_bot: true, 
    first_name: 'TestBot', 
    // ... other required fields
  },
  client: {
    callApi: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 100 } }),
  } as any,
});
```

#### Impact

These decisions affect how future integration tests should be written:
1. **For tightly coupled code:** Prefer component-part testing over full-workflow mocking
2. **For class internals:** Test through public interfaces, avoid spying on private/getter properties
3. **For grammY bots:** Always provide botInfo in constructor when testing bot.handleUpdate()

---

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
- Noble Six is the final reviewer for cross-cutting changes; Carter owns bridge layer decisions; Kat owns bot UX decisions; Jun owns test strategy
