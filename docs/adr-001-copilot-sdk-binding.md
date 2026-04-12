# ADR-001: Copilot SDK Binding Approach

**Status:** Proposed  
**Date:** 2026-04-11  
**Deciders:** Noble Six  

## Context

Reach bridges Telegram forum topics to GitHub Copilot CLI sessions. The relay layer (`src/relay/relay.ts`) consumes a `CopilotClient` abstraction defined in `src/types.ts` that exposes:

```ts
interface CopilotClient {
  createSession(options: { name: string; repoPath?: string }): Promise<CopilotSession>;
  resumeSession(sessionId: string): Promise<CopilotSession>;
}

interface CopilotSession {
  id: string;
  send(message: string): AsyncIterable<CopilotChunk>;
}

interface CopilotChunk { text: string; }
```

The relay streams chunks from `session.send()` with throttled Telegram edits. A `StubCopilotClient` is wired in as a placeholder. We need to bind this to the real `@github/copilot-sdk`.

### Constraints

- The SDK is in **public preview** (v0.2.2) and may introduce breaking changes.
- Reach runs as a long-lived Windows daemon — the SDK client must be stable across hours/days.
- The relay is event-driven and expects `AsyncIterable<CopilotChunk>` for streaming.
- Session names are human-readable strings chosen by the user (e.g. `reach-cairn`).

## Decision

**Adapter pattern.** Implement a thin adapter layer (`src/copilot/impl.ts`) that:

1. Holds a single `CopilotClient` instance for the daemon lifetime.
2. Maps Reach session names to SDK session IDs (using the name directly as the `sessionId`).
3. Wraps the SDK's event-emitter streaming API into `AsyncIterable<CopilotChunk>` via an async generator.
4. Handles `onPermissionRequest` with `approveAll` (personal single-user tool — no untrusted agents).

**The existing `CopilotClient`/`CopilotSession` interfaces in `src/types.ts` remain unchanged.** They are the correct abstraction for the relay. The adapter bridges the impedance mismatch.

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

### 1. Adapter Class (`src/copilot/impl.ts`)

```ts
import { CopilotClient as SdkClient, approveAll } from '@github/copilot-sdk';
import type { CopilotClient, CopilotSession, CopilotChunk } from '../types.js';

export class CopilotClientImpl implements CopilotClient {
  private sdk: SdkClient;
  private started = false;

  constructor(private model = 'claude-sonnet-4') {}

  private async ensureStarted(): Promise<void> {
    if (!this.started) {
      this.sdk = new SdkClient();
      await this.sdk.start();
      this.started = true;
    }
  }

  async createSession(options: { name: string; repoPath?: string }): Promise<CopilotSession> {
    await this.ensureStarted();
    const sdkSession = await this.sdk.createSession({
      sessionId: options.name,        // use friendly name as session ID
      model: this.model,
      streaming: true,
      workingDirectory: options.repoPath,
      onPermissionRequest: approveAll,
    });
    return new CopilotSessionAdapter(sdkSession);
  }

  async resumeSession(sessionId: string): Promise<CopilotSession> {
    await this.ensureStarted();
    const sdkSession = await this.sdk.resumeSession(sessionId, {
      model: this.model,
      streaming: true,
      onPermissionRequest: approveAll,
    });
    return new CopilotSessionAdapter(sdkSession);
  }
}
```

### 2. Session Adapter (event → AsyncIterable bridge)

```ts
import { CopilotSession as SdkSession } from '@github/copilot-sdk';

class CopilotSessionAdapter implements CopilotSession {
  readonly id: string;

  constructor(private sdk: SdkSession) {
    this.id = sdk.sessionId;
  }

  async *send(message: string): AsyncIterable<CopilotChunk> {
    // Create a channel: SDK events push into it, async generator pulls from it
    const chunks: CopilotChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const unsubDelta = this.sdk.on('assistant.message_delta', (event) => {
      chunks.push({ text: event.data.deltaContent });
      resolve?.();
    });

    const unsubIdle = this.sdk.on('session.idle', () => {
      done = true;
      resolve?.();
    });

    const unsubError = this.sdk.on('session.error', (event) => {
      error = new Error(event.data?.message ?? 'SDK session error');
      done = true;
      resolve?.();
    });

    try {
      await this.sdk.send({ prompt: message });

      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => { resolve = r; });
          resolve = null;
        }
      }

      if (error) throw error;
    } finally {
      unsubDelta();
      unsubIdle();
      unsubError();
    }
  }
}
```

### 3. Wiring (`src/main.ts` DI root)

```ts
import { CopilotClientImpl } from './copilot/impl.js';

const copilotClient = new CopilotClientImpl(process.env.REACH_MODEL ?? 'claude-sonnet-4');
// Inject into relay: new Relay(registry, copilotClient, idleMonitor)
```

### 4. Session Name as Session ID

The SDK's `sessionId` accepts arbitrary strings. We use the Reach session name directly (e.g. `"reach-cairn"`) as the SDK session ID. This means:

- `createSession({ name: "reach-cairn" })` → `sdk.createSession({ sessionId: "reach-cairn" })`
- `resumeSession("reach-cairn")` → `sdk.resumeSession("reach-cairn", { ... })`
- The registry's `copilotSessionId` field stores the same value as `name`
- `listSessions()` can verify a session exists before attempting resume

### 5. Recommended Session Name Validation

Although the SDK imposes no constraints, Reach should validate names for UX:

```ts
const SESSION_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}$/;
```

Rationale: lowercase + hyphens mirrors DNS label rules, avoids filesystem/URL encoding issues, keeps topic titles clean.

## Consequences

### Positive

- **Relay unchanged.** The `AsyncIterable<CopilotChunk>` contract holds — Carter's bridge code needs zero modifications.
- **Testable.** `StubCopilotClient` remains valid for unit tests. Integration tests can use the real adapter.
- **Session resumption is free.** The SDK persists session state to disk and resumes by ID. Reach's lazy-recreation pattern maps directly.
- **Streaming works.** The async generator bridge converts `assistant.message_delta` events into the throttle-friendly iterable the relay expects.

### Negative / Risks

- **SDK is preview.** Breaking changes possible. Mitigation: pin version, keep adapter thin so changes are localized.
- **Single CLI process.** The SDK spawns one Copilot CLI server per `CopilotClient`. Multiple concurrent sessions share that process. If it crashes, all sessions break. Mitigation: reconnect logic in `ensureStarted()` with state check.
- **`approveAll` is coarse.** In a personal tool this is acceptable. If Reach ever serves multiple users, tool permission needs finer control.
- **No explicit session name in SDK metadata.** `SessionMetadata` has `sessionId` and `summary` but no `name` field. We store the mapping in Reach's registry. If someone resumes via raw SDK, the "name" is just the ID.

### Neutral

- `CopilotChunk` stays as `{ text: string }` — maps directly to `deltaContent`. No structural change needed.
- The `SessionEntry.copilotSessionId` field in `src/types.ts` becomes redundant with `name` (they're the same string). Consider removing it to reduce confusion, or keep it for clarity.

## Open Questions

1. **Model selection** — Should the model be configurable per-session or global? Current sketch uses a global `REACH_MODEL` env var. Aaron to decide.
2. **Permission granularity** — `approveAll` is fine for personal use. If Reach ever runs in a shared context, we need a permission policy. Punt for now?
3. **CLI process lifecycle** — Should Reach restart the SDK's CLI process on crash? The SDK's `autoStart: true` helps but doesn't cover mid-session failures. Worth adding a health check / reconnect wrapper?
4. **`session.error` event shape** — The generated types are large; need to verify the exact error event type during implementation. The async generator error path may need adjustment.
5. **SessionEntry.copilotSessionId** — Remove (since it equals `name`) or keep for forward-compat if naming strategy changes?
