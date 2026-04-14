# Noble Six — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Lead / Architect
- **Joined:** 2026-04-12T06:02:10.439Z

## Project Background

**Why Reach exists:** Aaron (akubly on GitHub) wanted to control Copilot CLI sessions from his phone when away from his keyboard. Enterprise users use Teams MCP for this; personal users have no equivalent. Reach is the personal-user answer.

**Sister project:** Cairn (`D:\git\stunning-adventure`, `akubly/stunning-adventure`) — a Copilot CLI session intelligence daemon that detects patterns and generates insights. Reach is the mobile bridge; Cairn is the insight engine. Same owner, independent projects. Read Cairn's architecture for inspiration on how to structure a TypeScript CLI companion daemon.

**Name:** Reach (from Halo lore — humanity's most important military planet). The squad is Halo-themed: Noble Six (me), Carter, Kat, Jun, Scribe, Ralph.

## What's Been Built (Day 1)

- `src/types.ts` — `SessionEntry`, `CopilotChunk`, `CopilotSession`, `CopilotClient` interfaces
- `src/sessions/registry.ts` — durable `topicId → SessionEntry` JSON-backed registry
- `src/relay/relay.ts` — bidirectional relay with streaming throttle and idle eviction
- `src/bot/index.ts` — grammY Bot factory with chat ID guard
- `src/bot/handlers.ts` — `/new`, `/list`, `/remove`, catch-all relay handler
- `src/idleMonitor.ts` — per-topic idle timer for in-memory session eviction
- `src/copilot/factory.ts` — `StubCopilotClient` (placeholder until SDK binding lands)
- `docs/bridge-design.md` — Carter's detailed bridge layer design doc

## Critical Open Work (Noble Six Owns)

**The `@github/copilot-sdk` binding is the highest-priority outstanding item.** The `CopilotClient` interface in `src/types.ts` is a best-guess placeholder. Noble Six must:
1. Read the real SDK API (installed as `@github/copilot-sdk` in `node_modules`)
2. Verify/adjust `CopilotSession.send()` return type (is it `AsyncIterable<CopilotChunk>` or something else?)
3. Implement a real `CopilotClientImpl` in `src/copilot/impl.ts` (or similar)
4. Wire it into a `src/main.ts` DI root

Other open questions: registry file location (recommend `%APPDATA%\reach\registry.json`), session name validation, `REACH_CHAT_ID` env var guard.

## Key Architecture Decisions

1. External daemon (not CLI extension) — required to start new sessions remotely
2. Telegram forum topics as sessions — one topic = one named Copilot session
3. grammY for the Telegram bot — TypeScript-first, plugin-rich
4. Named session registry persisted to JSON, SDK handles recreated lazily
5. CopilotClient interface as abstraction boundary — relay never imports SDK directly

## Inspiration Map (from research)

| Feature | Source |
|---------|--------|
| `Client` interface abstraction | `austenstone/copilot-remote` |
| Deterministic/named session IDs | `austenstone/copilot-remote` |
| Edit-in-place streaming | `austenstone/copilot-remote` |
| HUD footer pattern (TBD) | `julianchun/copilot-telegram-bot` |
| Two-tier permissions (TBD) | `julianchun/copilot-telegram-bot` |
| Session pairing codes (TBD) | `examon/copilot-cli-telegram-bridge` |
| `/new <friendly-name>` single command | Reach original |
| Windows Service support | Reach original |

## Learnings

### 2026-04-11 — SDK API Surface Discovery

Investigated `@github/copilot-sdk` v0.2.2 (public preview). Key findings:

1. **No named sessions.** SDK uses opaque `sessionId` strings. Accepts custom IDs on `createSession({ sessionId: "..." })`, so we use the friendly name directly as the ID.
2. **Event-based streaming, not AsyncIterable.** `session.on("assistant.message_delta", cb)` yields `{ deltaContent: string }` chunks. `session.on("session.idle", cb)` signals completion. Must bridge to `AsyncIterable<string>` via async generator.
3. **`send()` returns `Promise<string>` (message ID)**, not an iterable. `sendAndWait()` returns the final `AssistantMessageEvent`.
4. **`onPermissionRequest` is required** on `createSession`. Using `approveAll` for personal tool.
5. **SDK spawns/manages a Copilot CLI server process** via JSON-RPC (stdio by default). One `CopilotClient` instance serves all sessions.
6. **Session state persists to disk.** `resumeSession(id, config)` restores conversation history. Maps directly to Reach's lazy-recreation pattern.
7. **Adapter pattern chosen.** `CopilotSessionFactoryImpl` wraps the SDK, `CopilotSessionAdapter` bridges events→AsyncIterable. Relay code unchanged.

ADR written: `docs/adr-001-copilot-sdk-binding.md`

### 2026-04-12 — Cross-Agent Note from Carter

Carter changed the bridge layer API during test alignment:

1. **CopilotSession.send() now yields string, not CopilotChunk** — stream chunks are plain strings (not `{ text: string }` objects). The async generator bridge in `CopilotSessionAdapter` should yield each `deltaContent` chunk as-is.
2. **CopilotClient replaced by CopilotSessionFactory** — new interface in `src/copilot/factory.ts`:
   ```typescript
   export interface CopilotSessionFactory {
     resume(sessionName: string): Promise<CopilotSession | null>;
     create(sessionName: string): Promise<CopilotSession>;
   }
   ```
   Sessions are name-based, not opaque ID-based. Caller tries `resume()` first, falls back to `create()` if null.

**Action for Noble Six:** When building `src/copilot/impl.ts`, update the ADR implementation sketch to match the new `CopilotSessionFactory` interface and plain-string streaming. The relay layer and tests are already aligned; SDK binding is the remaining integration point.

### 2026-04-12 — SDK Binding Implementation & main.ts DI Root

Implemented `src/copilot/impl.ts` and `src/main.ts`. Key learnings:

1. **`getSessionMetadata()` does NOT auto-start the SDK client** — unlike `createSession()`/`resumeSession()` which auto-start when `autoStart: true` (default), `getSessionMetadata()` throws if the client isn't connected. Required adding `ensureStarted()` with lazy `sdk.start()` call.
2. **Async generator bridge pattern** — Queue-based bridge with `notify` callback. Event listeners (`assistant.message_delta`, `session.idle`, `session.error`) are subscribed BEFORE `sdkSession.send()` is fired. `send()` is fire-and-forget (returns message ID); the generator yields from the queue until `session.idle` signals done. `finally` block cleans up all subscriptions.
3. **`approveAll` is a `const PermissionHandler`**, not a function — imported and passed directly to both `SessionConfig` and `ResumeSessionConfig`.
4. **`onPermissionRequest` is required** in both `SessionConfig` and `ResumeSessionConfig` (the `Pick` type preserves the non-optional constraint from `SessionConfig`).
5. **`resume()` uses two-phase check** — `getSessionMetadata()` returns `undefined` for unknown sessions (no throw), then `resumeSession()` is wrapped in try/catch to handle corrupted session data gracefully (returns `null` instead of throwing).
6. **Registry path** — Windows: `%APPDATA%\reach\registry.json`, Unix: `~/.config/reach/registry.json`. Platform detected via `os.platform()`.
7. **Graceful shutdown** — `Promise.allSettled([bot.stop(), factory.stop()])` ensures both teardowns run even if one fails. `process.exit(0)` in `.finally()`.
8. **All 56 tests pass** — No test changes required. The impl.ts is cleanly isolated behind the `CopilotSessionFactory` interface.
