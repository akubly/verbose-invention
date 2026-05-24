# Skill: Push-to-Pull Async Iterator (Event Queue Adapter)

**Trigger:** You need to expose an `AsyncIterable<T>` (pull interface) that is driven by
event-emitter pushes (e.g. `on('data', ...)` / `on('error', ...)`), without buffering the
full response before yielding.

---

## Problem

Node.js event emitters are push-based: listeners fire whenever the emitter decides.  
`AsyncIterable<T>` is pull-based: the consumer drives iteration with `for await`.  
Bridging them requires buffering items between pushes and pulls, plus careful lifecycle management.

Common failure modes:
- **Race window:** items arrive between the empty-queue check and the `await`, sleeping forever
- **Listener leak:** listeners not removed on error or early iterator return (`break`, `throw`)
- **Last-frame semantics:** a single event may contain both a final item AND a completion signal
- **Concurrent-use footgun:** multiple callers sharing event listeners get interleaved items

---

## Solution: Manual Async Queue

```typescript
type QueueItem<T> =
  | { kind: 'value'; value: T }
  | { kind: 'done' }
  | { kind: 'error'; err: Error };

async function *fromPushEvents<T>(
  subscribe: (push: (item: QueueItem<T>) => void) => void,
  unsubscribe: () => void,
): AsyncGenerator<T> {
  const queue: QueueItem<T>[] = [];
  let signal: (() => void) | null = null;
  const wake = (): void => { const s = signal; signal = null; s?.(); };

  subscribe((item) => { queue.push(item); wake(); });

  try {
    while (true) {
      // Drain all available items before waiting.
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.kind === 'value') yield item.value;
        else if (item.kind === 'done') return;
        else throw item.err;
      }
      // Wait for the next push.
      // CRITICAL: re-check queue AFTER assigning signal to close the race window.
      await new Promise<void>((r) => {
        signal = r;
        if (queue.length > 0) { signal = null; r(); }
      });
    }
  } finally {
    // Guaranteed cleanup: normal completion, error, AND early abandonment (break/return).
    unsubscribe();
  }
}
```

---

## Race Window (the critical bug)

```typescript
// ❌ WRONG — item can arrive between check and await, sleeping forever
if (queue.length === 0) {
  await new Promise<void>(r => { signal = r; });
}

// ✅ CORRECT — re-check after assigning signal
await new Promise<void>((r) => {
  signal = r;
  if (queue.length > 0) { signal = null; r(); }
});
```

---

## Listener Cleanup Rules

1. **Always `try/finally`** around the generator loop. The `finally` block fires on:
   - Normal completion (all items consumed)
   - Error (item threw or listener pushed an error)
   - Early abandonment: consumer calls `break`, `return`, or throws inside `for await`
     (the runtime calls `.return()` on the generator, triggering `finally`)

2. **Typed listener → `off()` cast**: if `off(event, listener)` requires `(...args: unknown[]) => void`
   but your listener has specific types, store typed aliases and cast only at the `off()` callsite:
   ```typescript
   const onData: (chunk: string) => void = (chunk) => { queue.push(...); wake(); };
   emitter.on('data', onData);
   try { ... } finally {
     emitter.off('data', onData as (...args: unknown[]) => void);
   }
   ```

---

## Last-Frame Semantics

Some protocols bundle a final value with the completion signal in one event:
```typescript
// ADR-8 stream: done:true frame may carry a non-empty chunk
const onStream = (_sId: string, _rId: string, chunk: string, done: boolean) => {
  if (chunk.length > 0) queue.push({ kind: 'value', value: chunk }); // yield final chunk
  if (done) queue.push({ kind: 'done' });                             // then complete
  wake();
};
```

---

## Isolation: Per-Request Queue

If the emitter multiplexes multiple concurrent streams (e.g. identified by `requestId`),
create a **new queue per call** and filter by ID in the listener:
```typescript
const onStream = (_sId: string, rId: string, chunk: string, done: boolean) => {
  if (rId !== myRequestId) return;  // ignore foreign events
  // ...
};
```
Each `send()` invocation creates its own isolated queue. No cross-contamination between
concurrent callers.

---

## Codebase Example

- `src/bridge/bridgeSession.ts` — `BridgeSession._generateStream()` — adapts
  `ExtensionBridge` stream/stream.error events into `AsyncIterable<string>`
- `src/copilot/impl.ts` — `CopilotSessionAdapter.bridge()` — same pattern for SDK events

---

## Related Skills

- `typed-eventemitter` — composition pattern for typed on/off; pairs with this skill
