# Skill: Testing Push-to-Pull Async Iterable Adapters

**Owner:** Jun  
**Category:** Testing patterns  
**Applies to:** Any `AsyncIterable<T>` adapter that wraps a push-based event emitter

---

## Problem

A push-based source (event emitter, bridge, socket) must be adapted to a
pull-based `AsyncIterable<T>` consumer. Testing this requires:

1. Emitting events **after** the consumer has started waiting but **before** awaiting
   the yielded value — a timing window that is easy to miss or over-engineer.
2. Verifying cleanup: listeners registered on `on()` must be deregistered with `off()`
   using the **same listener reference**, even on error or early cancellation paths.
3. Verifying the adapter ignores events not intended for this request (correlation IDs).

---

## Core Pattern: Synchronous Emit Between `iter.next()` and `await`

When `iter.next()` is called on an `async function*` generator:
- The generator runs **synchronously** until its first `await`.
- All setup code (registering listeners, initializing state) runs in that synchronous
  stretch.
- The `signal` resolver (if the generator uses a promise to signal new data) IS set
  after `iter.next()` returns, even though `await iter.next()` hasn't completed yet.

This means: **emit events synchronously after calling `iter.next()`, then await the result.**

```ts
// ✅ Correct: emit between next() and await
const p = iter.next();                            // generator runs to first await
bridge.emitStream(sId, rId, 'hello ', false);     // fires synchronously → resolves promise
const result = await p;                           // await now returns immediately
expect(result.value).toBe('hello ');

// ❌ Wrong: await first, then emit (deadlock)
const result = await iter.next();  // suspended forever
bridge.emitStream(sId, rId, 'hello ', false);  // never reached
```

---

## FakeEmitter / FakeBridge Helper Design

The test double must:
1. **Implement the full emitter interface** — including all overloads typed correctly.
2. **Track `on`/`off` calls with listener references** — not just event names.
3. **Provide emit helpers** — `emitStream()`, `emitStreamError()` for concise test code.

```ts
// tests/helpers/FakeBridge.ts pattern
export class FakeBridge implements BridgeEmitter {
  onCalls: Array<[string, (...args: unknown[]) => void]> = [];
  offCalls: Array<[string, (...args: unknown[]) => void]> = [];

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.onCalls.push([event, listener]);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.offCalls.push([event, listener]);
    return this;
  }

  emitStream(sId: string, rId: string, chunk: string, done: boolean): void {
    for (const [, fn] of this.onCalls.filter(([e]) => e === 'stream')) {
      fn(sId, rId, chunk, done);
    }
  }
}
```

**Why listener reference equality matters:** The adapter must call `off(event, sameRef)`
with the exact same listener object it passed to `on()`. Without reference tracking,
a test only verifies that `off` was called at all — not that the cleanup is correct.

```ts
// Test: listener registered with on() is exactly the one passed to off()
expect(bridge.offCalls[0][1]).toBe(bridge.onCalls[0][1]);
```

---

## Cleanup Test Matrix

| Scenario | `on` count | `off` count | Notes |
|----------|-----------|-------------|-------|
| Normal stream to `done` | 1 | 1 | listeners registered and released |
| Error mid-stream | 1 | 1 | cleanup must run on error path |
| `sendFn` returns false (pre-listen) | 0 | 0 | Kat's impl throws before registering |
| Generator cancelled externally | 1 | 1 | `return()` on generator must trigger cleanup |

---

## Fake Timer Interaction: Frozen `Date.now()`

When using `vi.useFakeTimers()` without a `now` option:
- `Date.now()` is **frozen at the real current epoch** (e.g., `1748040000000`), NOT at 0.
- If an adapter/relay has a `lastEditAt` starting at 0, the first `Date.now() - 0` test
  is `1748040000000 ≥ 800` → throttle fires immediately.
- Subsequent events: `1748040000000 - 1748040000000 = 0 < 800` → throttle blocked.
- Result: **1 throttle-fire per freeze cycle**, not 0 and not N.

```ts
// ✅ Correct: freeze at current epoch, expect 2 edits (1 mid-stream + 1 final)
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
// ... emit 5 chunks ...
expect(editCalls.length).toBe(2);  // 1 mid-stream (first chunk) + 1 final

// ❌ Wrong: assumed Date.now() = 0, expected 1 edit
expect(editCalls.length).toBe(1);  // fails — first chunk triggers throttle
```

To get exactly 1 edit (only final, no mid-stream throttle): use `vi.useFakeTimers({ now: 0, ... })`.

---

## Relay Integration Tests via setImmediate

When testing a relay that consumes an `AsyncIterable<T>`, the relay starts concurrently
(e.g., `const relayDone = relay.relay(ctx)`). You must give it time to reach the
`for await` loop before emitting.

```ts
// Start relay
const relayDone = relay.relay(ctx);

// Let relay reach `for await (const chunk of session.stream())` — all pending
// microtasks drain, relay setup `await`s are mock-resolved.
await new Promise<void>(resolve => setImmediate(resolve));

// Now safe to emit
bridge.emitStream(sId, rId, 'chunk1 ', false);
```

**Note:** Keep `setImmediate` real (not faked) when using `vi.useFakeTimers`. See the
`toFake` list above — `setImmediate` is intentionally omitted.

---

## Test Scope for Throttle Regression Guards

Full at-most-once-per-800ms throttle tests require complex async orchestration tightly
coupled to relay timing internals. The tradeoff is usually not worth it at the integration
level if the same contract is already covered in relay unit tests.

**Preferred scope for integration throttle guard:**
1. Assert final-edit **content** contains all chunks (if throttle is broken, content would be wrong).
2. Assert total edit count is **far fewer than chunk count** (proves throttle is working).

These two assertions together verify the throttle contract across the adapter boundary
without needing precise timer control.

---

## References

- `tests/helpers/FakeBridge.ts` — canonical FakeBridge implementation
- `tests/bridge/bridgeSession.test.ts` — J1 tests: 10 BridgeSession contract cases
- `tests/bridge/relay-with-bridge.test.ts` — J2 tests: relay+bridge integration
- `tests/helpers/FakeDaemon.ts` — comment explaining `toFake` list (setImmediate)
- `tests/relay/relay.test.ts` — `beforeEach` with `vi.useFakeTimers()` pattern
