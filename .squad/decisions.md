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
- Lists available commands: `/new <name>`, `/list`, `/remove <name>`, `/help`
- Provides link to documentation
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

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
- Noble Six is the final reviewer for cross-cutting changes; Carter owns bridge layer decisions; Kat owns bot UX decisions; Jun owns test strategy

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
- Noble Six is the final reviewer for cross-cutting changes; Carter owns bridge layer decisions; Kat owns bot UX decisions; Jun owns test strategy
