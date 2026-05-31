# Item 1 — Revised Spec: Orientation with Last Assistant Message

**Date:** 2026-05-30T11:46:26-07:00  
**Author:** Noble Six (Lead / Architect)  
**Trigger:** Aaron counterproposal — echo last assistant message instead of SDK summarization

---

## Feasibility Assessment: **CHEAP**

**No new SDK call required.** The extension already has the SDK session handle and can subscribe to events. We add one listener, cache the last message, and send it with `afk.request`.

---

## Where the Data Lives

| Component | Has Last Assistant Message? | Accessible from Orientation Handler? |
|-----------|-----------------------------|------------------------------------|
| AfkStreamRouter | ❌ No — deletes on completion (line 162) | N/A |
| Daemon bridge layer | ❌ No — routes chunks, doesn't cache | N/A |
| SDK session (extension-side) | ✅ Yes — `assistant.message` events | Not directly — daemon has no SDK access |
| **Extension cache (NEW)** | ✅ Add listener + cache variable | ✅ Send with `afk.request` → daemon has it |

**Solution:** Extension caches last `assistant.message` event content, includes in `afk.request`. Daemon receives it and includes in orientation message.

---

## Implementation

### Extension Changes (`extension.mjs`)

1. **Add state variable:**
```javascript
/** Last completed assistant message content, cached for orientation. */
let lastAssistantMessage = '';
```

2. **Add listener in `wireSessionEvents()`:**
```javascript
// Cache last assistant message for AFK orientation (Item 1)
sdkSession.on('assistant.message', (event) => {
  if (event?.data?.content) {
    lastAssistantMessage = String(event.data.content);
  }
});
```

3. **Extend `sendModeRequest()` for `afk.request`:**
```javascript
function sendModeRequest(type) {
  const msg = { type, sessionId: SESSION_ID };
  if (type === 'afk.request' && lastAssistantMessage.length > 0) {
    // Truncate to 500 chars for orientation message
    msg.lastAssistantExcerpt = lastAssistantMessage.length > 500
      ? lastAssistantMessage.slice(0, 497) + '...'
      : lastAssistantMessage;
  }
  // ... existing logic
}
```

**Lines changed:** ~15 in extension.mjs

### Protocol Changes (`protocol.ts`)

Extend `AfkRequestMessage`:
```typescript
export interface AfkRequestMessage {
  type: 'afk.request';
  sessionId: string;
  /** Last assistant message, truncated to 500 chars. Optional for backward compat. */
  lastAssistantExcerpt?: string;
}
```

**Lines changed:** ~3 in protocol.ts

### Daemon Changes (`afkMode.ts`)

1. **Store excerpt in `TopicBinding`:**
```typescript
export interface TopicBinding extends BridgeSessionInfo {
  topicId: number;
  topicUrl: string;
  orientationSent?: boolean;
  lastAssistantExcerpt?: string;  // NEW
}
```

2. **Capture from `afk.request`:** In the bridge handler that receives `afk.request`, pass `lastAssistantExcerpt` to activate flow.

3. **Orientation message** — update the activation banner in `activateAllSessions()`:
```typescript
await this.safeSendMessage(
  `📍 Session: ${binding.sessionName}\n` +
  `📂 CWD: ${binding.cwd}\n` +
  `🤖 Model: ${binding.model || this.globalModel}\n` +
  `🛰️ Mode: AFK (since ${binding.afkSince})\n` +
  (binding.lastAssistantExcerpt 
    ? `\n💬 Last: ${binding.lastAssistantExcerpt}`
    : ''),
  binding.topicId,
);
```

**Lines changed:** ~20 in afkMode.ts + minor bridge plumbing

---

## Orientation Message Format

```
📍 Session: reach-myproject
📂 CWD: D:\git\myproject
🤖 Model: claude-sonnet-4
🛰️ Mode: AFK (since 11:30)

💬 Last: Here's the implementation for the config parser. I added validation for the schema fields and included unit tests in tests/config/...
```

**Fields:**
| Field | Source | Always Present |
|-------|--------|---------------|
| Session name | `binding.sessionName` | ✅ |
| CWD | `binding.cwd` | ✅ |
| Model | `binding.model` or `globalModel` | ✅ |
| Mode + since | `afkSince` | ✅ |
| Last excerpt | `afk.request.lastAssistantExcerpt` | ❓ Only if message exists |

---

## Revised T1 Task Definition

**Owner:** Kat  
**Complexity:** S (still ~3 hours)

**Subtasks:**
- [ ] Add `lastAssistantMessage` cache + listener in extension.mjs (~15 LOC)
- [ ] Extend `afk.request` to include `lastAssistantExcerpt` (protocol.ts, ~3 LOC)
- [ ] Plumb excerpt through bridge → afkMode.ts (~10 LOC)
- [ ] Update activation message format in `activateAllSessions()` (~10 LOC)
- [ ] Unit tests: orientation includes excerpt when present, omits when absent

**Total estimate:** 3–4 hours (unchanged from original — cheap path confirmed)

---

## Open Question for Aaron

**Q1-1-revised:** Truncation length for last assistant excerpt?
- **500 chars** (recommended — fits one Telegram message, readable)
- **1000 chars** (if context is more valuable than brevity)
- **No limit** (risk: huge messages for long model responses)

**Default if no answer:** 500 chars.

---

## What This Does NOT Include

- **Full session transcript** — only the last assistant message
- **Summary/paraphrase** — verbatim excerpt, no model call
- **User messages** — only assistant output (what the model said)
- **Tool outputs** — only the final `assistant.message`, not intermediate tool results

---

## Summary

| Aspect | Value |
|--------|-------|
| Feasibility | **Cheap** — 15 lines extension, 3 lines protocol, 20 lines daemon |
| Token cost | **Zero** — no SDK `getMessages()` or summarization call |
| Latency impact | **Zero** — listener is already firing for other events |
| Complexity | **S (unchanged)** |
| New open questions | 1 (truncation length) |

**Verdict:** Aaron's counterproposal is free. Cache the last `assistant.message` event, send with `afk.request`, display in orientation. No model call, no transcript fetch.
