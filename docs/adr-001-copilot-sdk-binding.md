# ADR-001: Copilot SDK Binding Approach

**Status:** Accepted  
**Date:** 2026-04-11  
**Deciders:** Noble Six  

## Context

Reach bridges Telegram forum topics to GitHub Copilot CLI sessions. The relay layer (`src/relay/relay.ts`) consumes a `CopilotSessionFactory` abstraction defined in `src/copilot/factory.ts` that exposes:

```ts
interface CopilotSession {
  send(message: string): AsyncIterable<string>;
}

interface CopilotSessionFactory {
  resume(sessionName: string): Promise<CopilotSession | null>;
  create(sessionName: string): Promise<CopilotSession>;
}
```

The relay streams string chunks from `session.send()` with throttled Telegram edits. The real `CopilotClientImpl` is wired in via `src/main.ts` (bound to the `@github/copilot-sdk`).

Sessions are created lazily: the `/new` command only registers a topic→sessionName mapping in the registry. The actual SDK session is created on the first relay (message forwarded to Copilot), using `factory.resume()` with a fallback to `factory.create()`.

### Constraints

- The SDK is in **public preview** (v0.2.2) and may introduce breaking changes.
- Reach runs as a long-lived Windows daemon — the SDK client must be stable across hours/days.
- The relay is event-driven and expects `AsyncIterable<string>` for streaming.
- Session names are human-readable strings chosen by the user (e.g. `reach-cairn`).

## Decision

**Adapter pattern.** Implement a thin adapter layer (`src/copilot/impl.ts`) that:

1. Holds a single SDK `CopilotClient` instance for the daemon lifetime.
2. Implements `CopilotSessionFactory` with `resume(sessionName)` and `create(sessionName)`.
3. Maps Reach session names to SDK session IDs (using the name directly as the `sessionId`).
4. Wraps the SDK's event-emitter streaming API into `AsyncIterable<string>` via an async generator.
5. Handles `onPermissionRequest` with `approveAll` (personal single-user tool — no untrusted agents).

**The `CopilotSessionFactory`/`CopilotSession` interfaces in `src/copilot/factory.ts` are the relay's contract.** The adapter bridges the impedance mismatch between the SDK's event-emitter model and our async-iterable streaming contract.

### Alternatives Considered

| Approach | Pros | Cons |
|---|---|---|
| **A. Adapter (chosen)** | Relay untouched; SDK details isolated; testable via stub | One more layer of indirection |
| **B. Rewrite relay to use SDK events directly** | No adapter needed | Relay couples to SDK; harder to test; breaks if SDK changes |
| **C. Use `sendAndWait()` (no streaming)** | Simplest implementation | No streaming UX; user sees nothing until full response |

## SDK API Surface (Discovered)

**Package:** `@github/copilot-sdk` v0.2.2 (public preview)  
**Transport:** JSON-RPC over stdio to a spawned Copilot CLI process

### Key Exports

```ts
// Main exports from "@github/copilot-sdk"
export class CopilotClient {
  constructor(options?: CopilotClientOptions);
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: SessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
  listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]>;
  deleteSession(sessionId: string): Promise<void>;
  ping(): Promise<{ message: string; timestamp: number }>;
}

export class CopilotSession {
  readonly sessionId: string;
  send(options: MessageOptions): Promise<string>;          // returns message ID
  sendAndWait(options: MessageOptions): Promise<AssistantMessageEvent | undefined>;
  on(eventType: string, handler): () => void;              // event subscription
  disconnect(): Promise<void>;
  abort(): Promise<void>;
  getMessages(): Promise<SessionEvent[]>;
}

export function approveAll(): PermissionRequestResult;     // auto-approve all tool use
export function defineTool(...): Tool;                      // custom tool helper
```

### Critical Type Details

**`SessionConfig`** (for `createSession`):
- `sessionId?: string` — custom ID; if omitted, server generates one
- `model?: string` — e.g. `"gpt-5"`, `"claude-sonnet-4.5"`
- `streaming?: boolean` — enables `assistant.message_delta` events
- `onPermissionRequest: PermissionHandler` — **required**
- `workingDirectory?: string` — scopes tool operations

**`MessageOptions`** (for `send`/`sendAndWait`):
- `prompt: string` — the user message
- `attachments?: Array<...>` — file/blob attachments

**Streaming events** (via `session.on()`):
- `"assistant.message_delta"` → `{ deltaContent: string, messageId: string }`
- `"assistant.message"` → `{ content: string, messageId: string }`
- `"session.idle"` → session finished processing

**`ResumeSessionConfig`**: Same as `SessionConfig` minus `sessionId`. Resumes by ID, preserving conversation history.

### What the SDK Does NOT Have

- **No "named sessions" concept.** Sessions are identified by opaque `sessionId` strings. The SDK accepts a custom `sessionId` on create but does not enforce naming rules.
- **No `AsyncIterable` streaming.** Streaming uses event emitters (`session.on("assistant.message_delta", ...)`), not async iterators.
- **No session name validation.** The `sessionId` field is a free-form string.

## Implementation Plan

### 1. Session Adapter & Factory (`src/copilot/impl.ts`)

The implementation uses three key patterns:

**Startup memoization:** The `CopilotClientImpl` memoizes the startup promise in `startPromise` (not a boolean flag). If startup fails, the promise is cleared so retry is possible.

**Session metadata check:** On `resume()`, the factory calls `getSessionMetadata(sessionName)` to verify the session exists before attempting to resume. This mirrors SDK semantics (a missing session returns `null`, not an error).

**Async generator bridge:** `CopilotSessionAdapter.send()` returns an async generator that bridges SDK events into `AsyncIterable<string>`. Key details:
- Events are queued as `{ kind, value }` items until consumed
- Serialization lock (`sendQueue` promise chain) ensures only one `send()` is active at a time; this prevents race conditions in event subscription
- Lock is acquired inside the generator body (at first `next()`) not before, so unresumed generators don't deadlock
- `Promise.race` combines event notification with a stream timeout; if no events arrive for 5 minutes, the generator throws
- All listeners are unsubscribed in `finally` to prevent leaks
- `send()` is fire-and-forget; errors are caught and queued

**Wiring:** `src/main.ts` instantiates `CopilotClientImpl(model)` and passes it to the relay. The factory starts the SDK lazily on first `resume()`/`create()` call.

### 4. Session Name as Session ID

The SDK's `sessionId` accepts arbitrary strings. We use the Reach session name directly (e.g. `"reach-cairn"`) as the SDK session ID. This means:

- `factory.create("reach-cairn")` → `sdk.createSession({ sessionId: "reach-cairn" })`
- `factory.resume("reach-cairn")` → `sdk.resumeSession("reach-cairn", { ... })`
- `listSessions()` can verify a session exists before attempting resume

### 5. Lazy Session Creation

Sessions are not created at `/new` time. The `/new` command only registers a mapping from a Telegram topic ID to a session name in the `SessionRegistry`. The actual SDK session is created lazily on the first relay call — when a user sends a message in the linked topic, the relay calls `factory.resume()` (falling back to `factory.create()`) and caches the handle.

### 5. Recommended Session Name Validation

Although the SDK imposes no constraints, Reach should validate names for UX:

```ts
const SESSION_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}$/;
```

Rationale: lowercase + hyphens mirrors DNS label rules, avoids filesystem/URL encoding issues, keeps topic titles clean.

## Consequences

### Positive

- **Relay unchanged.** The `AsyncIterable<string>` contract holds — the relay's bridge code needs zero modifications.
- **Testable.** `StubCopilotSessionFactory` remains valid for unit tests. Integration tests can use the real adapter.
- **Session resumption is free.** The SDK persists session state to disk and resumes by ID. Reach's lazy-creation pattern maps directly.
- **Streaming works.** The async generator bridge converts `assistant.message_delta` events into the throttle-friendly iterable the relay expects.

### Negative / Risks

- **SDK is preview.** Breaking changes possible. Mitigation: pin version, keep adapter thin so changes are localized.
- **Single CLI process.** The SDK spawns one Copilot CLI server per `CopilotClient`. Multiple concurrent sessions share that process. If it crashes, all sessions break. Mitigation: reconnect logic in `ensureStarted()` with state check.
- **`approveAll` is coarse.** In a personal tool this is acceptable. If Reach ever serves multiple users, tool permission needs finer control.
- **No explicit session name in SDK metadata.** `SessionMetadata` has `sessionId` and `summary` but no `name` field. We store the mapping in Reach's registry. If someone resumes via raw SDK, the "name" is just the ID.

### Neutral

- The relay streams plain `string` chunks — the `deltaContent` from the SDK maps directly with no wrapper type needed.
- `SessionEntry` in `src/types.ts` contains only `sessionName`, `topicId`, `chatId`, and `createdAt`. No SDK-specific fields leak into the domain model.

## Open Questions

1. **Model selection** — Should the model be configurable per-session or global? Current sketch uses a global `REACH_MODEL` env var. Aaron to decide.
2. **Permission granularity** — `approveAll` is fine for personal use. If Reach ever runs in a shared context, we need a permission policy. Punt for now?
3. **CLI process lifecycle** — Should Reach restart the SDK's CLI process on crash? The SDK's `autoStart: true` helps but doesn't cover mid-session failures. Worth adding a health check / reconnect wrapper?
4. **`session.error` event shape** — The generated types are large; need to verify the exact error event type during implementation. The async generator error path may need adjustment.
