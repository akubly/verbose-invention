# Phase 9 Streaming Fix Design — Backpressure & Cross-Wiring

**Author:** Noble Six (Architect)
**Date:** 2026-05-30
**For:** Carter (Implementor)
**Status:** Draft — awaiting Aaron approval

---

## TL;DR

The extension-side `streamSdkResponse()` has two bugs: (1) `pipeSocket.write()` is fire-and-forget with no backpressure, and (2) concurrent `mirror.input` calls register duplicate listeners on the global `sdkSession` that cross-wire chunks between requests. However, investigation reveals the concurrency concern is **real but low-probability** — there is no serialization gate between the daemon's `mirror.input` dispatch and `streamSdkResponse()`. The fix is a **per-session serialization queue** (same pattern the daemon-side `CopilotSessionAdapter` already uses) plus **drain-aware writes** for backpressure. The SDK *does* expose `messageId` on deltas, but `session.idle` has no correlation field, making pure correlation insufficient — serialization is the correct approach.

---

## 1. Investigation Findings

### 1.1 Extension-side `streamSdkResponse` (extension.mjs)

**Location:** `extension.mjs:387–451`

Current pattern (post-Issue #8 fix):
- Lines 405–428: Three listeners registered on global `sdkSession`:
  - `assistant.message_delta` → builds JSON frame, calls `pipeSocket.write(frame, 'utf-8')` **fire-and-forget** (line 416)
  - `session.idle` → calls `cleanup()` + `resolve()` (line 420)
  - `session.error` → calls `cleanup()` + `reject()` (line 424)
- Lines 398–403: `cleanup()` uses a `settled` boolean guard and calls `unsub()` for each listener
- Line 436: `sdkSession.send({ prompt: text })` — fire-and-forget with `.catch()` guard
- Line 388: `activeInjectIds.add(requestId)` — tracks in-flight requests but provides **no serialization**

**Backpressure gap (I1):** `pipeSocket.write()` at line 416 never checks the return value. When `write()` returns `false`, the internal buffer grows unbounded. The old `for-await-of` pattern had natural backpressure because the generator yielded control.

**Cross-wiring gap (I2):** `handleMirrorInput()` (line 533) calls `await streamSdkResponse(...)` but the `await` only prevents the *same handler* from re-entering. Two Telegram messages dispatched by grammY concurrently (or an inject + mirror.input overlap) will both register listeners on `sdkSession`. Since all events are broadcast to all listeners:
- Both `assistant.message_delta` handlers fire for every chunk → chunks written to pipe for **both** requestIds
- Both `session.idle` handlers fire on one idle → **both** resolve, even if only one request completed

### 1.2 SDK Event Payload Shapes

**Source:** `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`

**`assistant.message_delta`** (line 1468):
```typescript
{
  id: string;          // event UUID
  timestamp: string;
  parentId: string | null;
  ephemeral: true;
  type: "assistant.message_delta";
  data: {
    messageId: string;      // ← CORRELATION KEY EXISTS
    deltaContent: string;
    parentToolCallId?: string;
  };
}
```

**`session.idle`** (line 265):
```typescript
{
  id: string;
  timestamp: string;
  parentId: string | null;
  ephemeral: true;
  type: "session.idle";
  data: {
    aborted?: boolean;      // ← NO messageId / correlation field
  };
}
```

**`sdkSession.send()`** (session.d.ts line 113):
```typescript
send(options: MessageOptions): Promise<string>;  // returns message ID
```

**Critical finding:** `assistant.message_delta.data.messageId` matches the string returned by `send()`. This means deltas *can* be correlated to the originating `send()` call. However, `session.idle` carries **no correlation field** — it signals "the session has no work in flight" globally. This means correlation alone cannot determine *which* request completed; only serialization (or "last writer wins" with messageId filtering on deltas) is fully correct.

### 1.3 Daemon-side Pattern (src/copilot/impl.ts)

**`CopilotSessionAdapter`** (lines 107–194) already solves this correctly with a **serialization queue**:

- Line 109: `private sendQueue: Promise<void> = Promise.resolve();`
- Lines 119–123: Each `bridge()` call chains onto `sendQueue`, acquiring a mutex-like lock
- Lines 125–126: `await gate;` — waits for prior send to fully complete
- Lines 137–147: Listeners registered AFTER lock acquired, BEFORE `send()` called
- Lines 190–193: `finally` block calls `unsub()` on all listeners, then `releaseLock()`

The daemon-side relay (`src/relay/relay.ts:140`) iterates `for await (const chunk of session.send(userText))` — the AsyncGenerator from `CopilotSessionAdapter.bridge()` naturally serializes. The relay itself has no additional serialization, but the adapter provides it.

**Conclusion:** The daemon-side is already safe. The extension-side is the gap.

### 1.4 Concurrency in Practice

**Is concurrent `streamSdkResponse` possible?**

Yes, through two paths:

1. **`mirror.input` + `inject` overlap:** `handleInject()` (line 460) and `handleMirrorInput()` (line 533) both call `streamSdkResponse()`. They are dispatched from the pipe's `data` handler (line 349–350, 329–331). If the daemon sends a `mirror.input` while an `inject` is in-flight, both run concurrently — `await` in `handleMirrorInput` does not block the pipe message dispatch loop.

2. **Rapid `mirror.input` bursts:** `handleMirrorInput` is `async` (line 533) and called from the synchronous message dispatch switch (line 350). The `await streamSdkResponse(...)` at line 554 does NOT block the dispatch loop from processing the next pipe message. Two rapid Telegram messages produce two concurrent `streamSdkResponse()` calls.

3. **Rate limiting partially mitigates but does not prevent:** The daemon-side `afkMode.ts:199` has a 20 msg/min per-session rate limit, but this is a throughput cap, not a serialization gate. Two messages sent 1 second apart pass the rate limiter and arrive as concurrent `mirror.input` events at the extension.

**Verdict: The concurrency concern is REAL, not theoretical.** It is low-probability in normal usage (typical human typing cadence means the first stream completes before the second arrives) but trivially triggerable by a fast user or automated tooling.

---

## 2. Design Decisions

### A) Correlation Mechanism: **Serialization Queue** (recommended)

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **(a) Serialization queue** | Simple, correct, matches daemon pattern, no SDK assumptions | Fast user waits; second message queued behind first |
| **(b) Generation counter** | Cheap | Doesn't work — `session.idle` has no correlation; both listeners fire |
| **(c) messageId correlation** | Uses SDK's built-in correlation | Requires awaiting `send()` before filtering deltas (race window); `session.idle` still has no messageId — would need "generation + messageId" hybrid |

**Recommendation: Option (a) — Serialization queue.**

Rationale:
1. **Correctness:** `session.idle` has no correlation field. Any scheme that tries to run concurrent sends must invent a way to know which send triggered idle. The SDK doesn't support this. Serialization sidesteps the problem entirely.
2. **Symmetry:** The daemon-side `CopilotSessionAdapter` uses exactly this pattern (impl.ts:109–123). Using the same pattern in the extension reduces cognitive load and proves correctness.
3. **Acceptable cost:** A Telegram user who sends two messages in <5 seconds sees a brief queue. This is acceptable — the SDK itself processes messages sequentially (one agentic loop at a time), so concurrent sends would be serialized inside the SDK anyway. We're making the implicit serial behavior explicit.
4. **No SDK version coupling:** Doesn't depend on `messageId` semantics remaining stable.

### B) Backpressure Restoration: **Drain-aware writes with microtask flush** (recommended)

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **(1) Buffer-then-flush** | Simple | Loses streaming UX entirely |
| **(2) Bounded queue + drop** | Preserves streaming | Data loss; complex drop logic |
| **(3) Drain-aware writes** | Preserves streaming; correct | Slightly complex; needs careful async handling |

**Recommendation: Option (3) — drain-aware writes, simplified.**

The key insight: since we're serializing requests (Decision A), only ONE `assistant.message_delta` handler is active at a time. We can safely use a simple drain-aware pattern:

1. Call `pipeSocket.write(frame, 'utf-8')` and check return value
2. If `write()` returns `false`, set a flag and await `pipeSocket.once('drain')` via a stored Promise
3. The next delta event checks the flag before writing
4. Since event handlers are synchronous, we buffer at most ONE pending chunk while waiting for drain

This is simpler than full cork/uncork and avoids the complexity of Option 3 as originally described. The serialization queue guarantees single-writer, making the drain logic straightforward.

**Practical note:** The pipe socket is a local named pipe (IPC, not network). Backpressure on a local pipe is extremely rare — the kernel buffer is typically 64KB+. This fix is defense-in-depth; the primary fix is serialization.

### C) Listener Lifecycle: **Cleanup is correct; add defensive removeListener**

**Current state (extension.mjs:398–403):**
```javascript
function cleanup() {
  if (settled) return;
  settled = true;
  clearTimeout(timeoutId);
  for (const unsub of unsubs) unsub();
}
```

**SDK verification:** `sdkSession.on()` returns `() => void` (an unsubscribe function) per `session.d.ts:159`. The current code stores these in `unsubs[]` and calls them in `cleanup()`. This is correct — listeners are removed on completion, error, and timeout.

**Gap:** If `streamSdkResponse()` throws before `unsubs` is populated (e.g., `sdkSession.send()` throws synchronously), the listeners from lines 405–428 would never be unsubscribed. However, `send()` returns a Promise (caught by `.catch()`), so synchronous throws are unlikely.

**Recommendation:** Move listener registration into the `try` block (already the case) and ensure `cleanup()` is called in the `finally` of the outer try/catch (lines 444–450). Current code already does this via the Promise executor's settled guard + the outer `finally` block. **No structural change needed.** Add a defensive comment explaining the lifecycle.

### D) Error Handling & `send()` Return Value

**Current code (extension.mjs:436–439):**
```javascript
sdkSession.send({ prompt: text }).catch((err) => {
  cleanup();
  reject(err instanceof Error ? err : new Error(String(err)));
});
```

The resolved value of `send()` (the message ID string) is **not used**. This is correct for the serialization approach — we don't need the message ID for correlation since only one request is active at a time.

**If we wanted messageId correlation (not recommended):** We'd need to `await` the send, capture the messageId, and filter deltas by `event.data.messageId === capturedId`. But since `session.idle` has no messageId, this alone doesn't solve the completion detection problem.

**Recommendation:** No change to error handling. The fire-and-forget pattern with `.catch()` is correct for the event-emitter model.

---

## 3. Concrete Code Sketch

### 3.1 Serialization Queue (add to extension.mjs module scope)

```javascript
// ─── Stream serialization ─────────────────────────────────────────────────────
// Mirrors CopilotSessionAdapter.sendQueue (src/copilot/impl.ts:109).
// Ensures only one streamSdkResponse() is active at a time, preventing
// cross-wiring of event listeners on the shared sdkSession.
let streamQueue = Promise.resolve();
```

### 3.2 Modified `streamSdkResponse`

```javascript
async function streamSdkResponse(text, requestId, label) {
  // Acquire serialization lock — wait for any prior stream to finish.
  let releaseLock;
  const gate = streamQueue;
  streamQueue = new Promise((resolve) => { releaseLock = resolve; });

  try {
    await gate;                       // wait for prior stream
    activeInjectIds.add(requestId);

    let chunkCount = 0;
    let drainPromise = null;          // backpressure: pending drain wait

    await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId;
      let unsubs = [];

      function cleanup() {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        for (const unsub of unsubs) unsub();
      }

      unsubs = [
        sdkSession.on('assistant.message_delta', (event) => {
          if (settled) return;        // guard: ignore events after completion
          const chunk = String(event?.data?.deltaContent ?? '');
          const frame = JSON.stringify({
            type: 'stream',
            sessionId: SESSION_ID,
            requestId,
            chunk,
            done: false,
          }) + '\n';

          if (pipeSocket !== null && !pipeSocket.destroyed) {
            const flushed = pipeSocket.write(frame, 'utf-8');
            if (!flushed && drainPromise === null) {
              // Backpressure: wait for drain before next write.
              // Chunks arriving while waiting are still pushed to
              // the socket (Node buffers them); this just prevents
              // runaway buffer growth by pausing at the next microtask.
              drainPromise = new Promise((r) => {
                pipeSocket.once('drain', () => { drainPromise = null; r(); });
              });
            }
          }
          chunkCount++;
        }),
        sdkSession.on('session.idle', () => {
          cleanup();
          resolve(undefined);
        }),
        sdkSession.on('session.error', (event) => {
          cleanup();
          reject(new Error(event?.data?.message ?? 'session error'));
        }),
      ];

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Stream timeout: no response from SDK'));
      }, STREAM_TIMEOUT_MS);

      sdkSession.send({ prompt: text }).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    // Wait for final drain before sending done frame
    if (drainPromise) await drainPromise;

    sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk: '', done: true });
    log('info', `${label} complete: requestId=${requestId} chunks=${chunkCount}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `${label} error: ${message}`);
    sendToDaemon({ type: 'stream.error', sessionId: SESSION_ID, requestId, error: message });
  } finally {
    activeInjectIds.delete(requestId);
    releaseLock();                    // release serialization lock
  }
}
```

### 3.3 Queue Reset on Reconnect

When the pipe reconnects or the SDK session changes, reset the queue to avoid deadlocks from an orphaned lock:

```javascript
// In the reconnect handler or wherever sdkSession is reassigned:
streamQueue = Promise.resolve();
```

Carter should identify all code paths where `sdkSession` is reassigned (search for `sdkSession =`) and add this reset.

---

## 4. Test Cases Carter Must Add

### 4.1 Serialization Test (Critical — validates I2 fix)

**File:** `tests/extension/streamSerialization.test.ts` (or appropriate test location)

**Scenario:** Two simultaneous `mirror.input` calls must not cross-wire.

```
Given: sdkSession mock that emits 3 deltas per send(), then session.idle
When:  Two streamSdkResponse() calls are made concurrently (no await between them)
Then:  - First call's chunks all carry requestId-1
       - Second call's chunks all carry requestId-2
       - First call's done frame arrives before second call's first chunk
       - No chunk has the wrong requestId
```

### 4.2 Backpressure Test (validates I1 fix)

**Scenario:** `pipeSocket.write()` returns false on first call.

```
Given: Mock pipeSocket where write() returns false, then emits 'drain' after 50ms
When:  streamSdkResponse() processes 5 delta events
Then:  - write() is called for all chunks (Node buffers internally)
       - drainPromise is created on first false return
       - Done frame is sent only after drain resolves
       - No uncaught errors or unhandled rejections
```

### 4.3 Queue Reset Test

**Scenario:** Queue doesn't deadlock across SDK session changes.

```
Given: streamSdkResponse() is in-flight (awaiting gate)
When:  sdkSession is reassigned (simulating reconnect) and streamQueue is reset
Then:  New streamSdkResponse() call proceeds without waiting for the orphaned lock
```

### 4.4 Regression: Single Request Still Works

**Scenario:** Normal single-request flow is unaffected by serialization machinery.

```
Given: No prior in-flight request
When:  streamSdkResponse() is called once
Then:  Chunks arrive, done frame sent, lock released — same behavior as before
```

---

## 5. Backward Compatibility

### Wire Protocol
**No change.** The `stream` and `stream.error` frame shapes are identical. The serialization is internal to the extension — the daemon sees the same frame sequence, just with guaranteed non-interleaving.

### Daemon-side `CopilotSessionAdapter`
**No change needed.** The daemon already serializes via `sendQueue`. The daemon-side code in `src/copilot/impl.ts` is already correct and serves as the reference implementation for this fix.

### `AfkStreamRouter` (daemon-side stream routing)
**No change.** `AfkStreamRouter` routes by `sessionId:requestId` key (afkStreamRouter.ts:64). It already handles interleaved streams correctly via per-key chain promises. The fix in the extension prevents interleaving at the source, which is strictly better.

---

## 6. Risks & Notes

1. **Lock starvation under SDK hang:** If the SDK never fires `session.idle` or `session.error`, the lock is held until the 5-minute timeout (`STREAM_TIMEOUT_MS`). This is acceptable — the timeout already exists and the `finally` block releases the lock.

2. **Queue depth:** Under sustained load (20 msg/min rate limit), the queue depth is bounded by `STREAM_TIMEOUT_MS / average_response_time`. With 30s average responses and 20 msg/min cap, queue depth ≈ 10. This is fine.

3. **Backpressure on IPC pipe:** The named pipe's kernel buffer is typically 64KB on Windows. A single chunk is ~200 bytes. Backpressure would only trigger after ~300 buffered chunks with no reads — extremely unlikely with the daemon actively consuming. The drain handling is defense-in-depth.

4. **`settled` guard improvement:** The existing `if (settled) return;` guard in the delta handler (added in the sketch) prevents processing events after cleanup. This is important because SDK events are dispatched synchronously — a delta could arrive between `cleanup()` and the `unsub()` calls if the SDK dispatches from within the idle handler.
