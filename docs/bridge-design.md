# Bridge Layer Design — Reach

**Author:** Carter (Bridge Dev)  
**Status:** Implemented — files in `src/bot/`, `src/relay/`, `src/sessions/`, `src/copilot/`

---

## 1. grammY Forum Topic Fundamentals

Telegram forum topics require a **supergroup** with `is_forum: true`. The bot must be a member (admin rights help for topic management, but aren't required for reading/writing messages).

Every message posted inside a topic carries `message.message_thread_id` — the numeric ID of that topic. The top-level "General" topic always has `message_thread_id === 1`. Messages posted directly to the group (outside any topic) have no `message_thread_id`.

```typescript
// Detect topic messages in grammY
bot.on('message', (ctx) => {
  const topicId = ctx.message.message_thread_id; // undefined = not in a topic
});

// Reply into a specific topic
await ctx.api.sendMessage(chatId, text, { message_thread_id: topicId });
```

The bot identifies incoming work by `(chatId, topicId)` pairs. Since this is a single-user personal tool, `chatId` is constant (one group), but we store it alongside `topicId` for correctness.

---

## 2. Topic → Session Mapping Strategy

### Data model

```
topicId (number)
  └─> SessionEntry {
        sessionName: string   // e.g. "reach-cairn", "reach-myapp"
        topicId:    number    // redundant but makes serialisation symmetric
        chatId:     number    // the supergroup chat ID
        createdAt:  string    // ISO-8601
      }
```

### Lifecycle

```
User: /new reach-myapp        (in a forum topic)
 └─> registry.register(topicId, chatId, "reach-myapp")
      └─> persisted to data/registry.json

Restart
 └─> registry.load()           restores entries from JSON
      └─> SDK sessions are NOT persisted — recreated lazily on first message

User sends message in topic
 └─> relay.relay(ctx)
      └─> registry.resolve(topicId) → SessionEntry
           └─> activeSessions.get(topicId) ?? factory.resume(name) ?? factory.create(name)
                └─> stream response back
```

Lazy session creation is intentional: it avoids opening SDK sessions for topics that are just browsed after a restart, and keeps the registry a simple durable mapping that doesn't encode transient SDK state.

---

## 3. Message Relay Flow

```
[Telegram message arrives]
       │
       ▼
ctx.message.message_thread_id  ──── undefined? ──────► ignore
       │ (topicId)
       ▼
registry.resolve(topicId)  ──── not found? ──────────► reply "⚠️ No session..."
       │ (SessionEntry)
       ▼
activeSessions.get(topicId)
       │ (null)
       ▼
factory.resume(entry.sessionName)  ── null? ──► factory.create(entry.sessionName)
       │ (CopilotSession)
       ▼
activeSessions.set(topicId, session)
idleMonitor.reset(topicId, onIdle)
       │
       ▼
ctx.api.sendMessage(...)         ← send placeholder "…"
       │ (placeholderMsg)
       ▼
session.send(userText)           ← returns AsyncIterable<string>
       │
   ┌───┘
   │ for await (chunk of stream)
   │   accumulated += chunk
   │   if (Date.now() - lastEdit >= THROTTLE_MS)
   │     editMessage(placeholderMsg, accumulated)    ← streaming effect
   └───┐
       ▼
editMessage(placeholderMsg, accumulated, { parse_mode: 'Markdown' })  ← final edit
```

### Error paths

| Error | Action |
|---|---|
| `registry.resolve` returns `undefined` | Reply "⚠️ No session linked" in topic |
| `factory.create/resume` throws | Reply "❌ Could not open session: <msg>" |
| SDK stream throws mid-flight | Edit placeholder with "❌ Stream error: <msg>" |
| Telegram edit fails (rate limit) | Caught, logged, retry on next chunk |

---

## 4. Streaming Strategy

Telegram allows **~1 `editMessageText` call per second per chat** before returning 429. Copilot SDK streams can emit dozens of chunks per second. We throttle edits:

```typescript
const STREAM_EDIT_THROTTLE_MS = 800; // comfortably under 1/s limit

let accumulated = '';
let lastEditAt = 0;

for await (const chunk of session.send(userText)) {
  accumulated += chunk;
  if (Date.now() - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
    await editMessage(placeholder, accumulated);        // plain text mid-stream
    lastEditAt = Date.now();
  }
}
// Final edit: full text with Markdown parsing
await editMessage(placeholder, accumulated, { parse_mode: 'Markdown' });
```

**Why plain text mid-stream?** Telegram's Markdown parser is strict and will reject a message with an unclosed code-fence. Mid-stream the text is likely incomplete. The final edit uses `parse_mode: 'Markdown'` with a fallback to plain text if Telegram rejects it (e.g. malformed output from the model).

---

## 5. Error Handling Approach

### Relay-level
- All errors in `relay.relay()` are caught and reported as edits to the placeholder message so the user always gets feedback.
- `session.send()` errors evict the cached session so the next message re-creates it (handles stale sessions after long inactivity).

### Bot-level
- `bot.catch()` logs unhandled errors. grammY retries network errors internally.
- `/new`, `/list`, `/remove` validate inputs and reply with clear error messages.

### Registry-level
- `registry.load()` swallows `ENOENT` (first run). Other FS errors propagate to startup where they can be handled.
- Writes are atomic via temp-file-then-rename (future hardening — initial implementation writes directly).

---

## 6. Idle Backoff Strategy

Active in-memory SDK sessions are expensive. We evict them after inactivity:

```
IdleMonitor.reset(topicId, onIdle)   ← called on every message
  └─> clearTimeout(existing)
       setTimeout(onIdle, IDLE_TIMEOUT_MS)   ← default: 30 minutes

onIdle():
  activeSessions.delete(topicId)
  // registry entry stays — session name is remembered across idle periods
  // SDK session is recreated lazily on next message
```

The SDK session object itself may have its own keepalive/heartbeat — Noble Six's SDK integration layer should handle that. From the bridge's perspective, we treat idle eviction as "forget the session object; recreate on demand."

**No polling loop** — the bridge is purely event-driven. Idle backoff is purely about resource cleanup, not about message delivery timing.

---

## 7. Module Map

```
src/
  bot/index.ts          grammY bot wiring — commands, message router
  relay/relay.ts        core relay logic — stream, throttle, error handling
  sessions/registry.ts  durable topic→session map with JSON persistence
  copilot/factory.ts    CopilotSession interface + stub factory (Noble Six fills in SDK impl)
  idleMonitor.ts        per-topic idle timer for session eviction
```

### Dependency diagram

```
bot/index.ts
  ├─ sessions/registry.ts
  └─ relay/relay.ts
       ├─ sessions/registry.ts
       ├─ copilot/factory.ts   (interface only — impl injected)
       └─ idleMonitor.ts
```

---

## 8. Open Questions for Noble Six

1. **SDK API shape** — What does `@github/copilot-sdk` actually export? Specifically: how do you create/resume a named session, and what does the stream return (`AsyncIterable<string>`? event emitter?). The `CopilotSession` interface in `src/copilot/factory.ts` is a placeholder — Noble Six needs to fill in the real binding.

2. **Session naming conventions** — Are session names validated by the SDK (alphanumeric only? max length?)? Should `/new` enforce a regex?

3. **Chat ID config** — The bot needs to know the allowed supergroup chat ID to avoid responding to unintended groups. Should this be an env var (`REACH_CHAT_ID`) or auto-detected on first `/new`?

4. **Windows Service integration** — Where does the registry JSON live? Suggest `%APPDATA%\reach\registry.json` or next to the binary. Noble Six should decide and expose it as config.
