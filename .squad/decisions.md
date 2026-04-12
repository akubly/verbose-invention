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
4. **30-minute idle eviction** — in-memory SDK sessions evicted after 30 min idle; registry entry preserved; session recreated lazily.
5. **No allowed-chat-ID guard yet** — flagged as open question; `REACH_CHAT_ID` env var guard recommended before any shared deployment.

---

### 2026-04-12 — API Alignment — Canonical Bridge Layer Interfaces (Carter)

Implementation and tests had diverged; tests were canonical (written TDD by Jun). All changes below bring implementation into alignment. **All 26 tests now pass.**

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

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
- Noble Six is the final reviewer for cross-cutting changes; Carter owns bridge layer decisions; Kat owns bot UX decisions; Jun owns test strategy
