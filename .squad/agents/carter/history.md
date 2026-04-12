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

<!-- Append learnings below -->
