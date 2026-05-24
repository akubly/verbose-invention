# Skill: No-Timer Regression Assertion

**Owner:** Jun  
**Category:** Testing patterns  
**Applies to:** Any function from which a `setTimeout` (or `setInterval`) was deliberately removed — regression-guard against re-introduction.

---

## Problem

When a timeout is removed from production code as a deliberate architectural decision (e.g., ADR-9 Branch A: no-timeout permission prompting), there is no automated guard preventing a future developer from accidentally re-introducing it. Normal tests will pass whether or not a `setTimeout` is present — the timeout just hasn't fired yet.

---

## Solution: Spy on `globalThis.setTimeout` and Assert Zero Calls

```ts
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('promptUserForPermission — no-timeout invariant', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy BEFORE calling the function under test
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('does NOT create a setTimeout for the prompt lifetime', async () => {
    const abortController = new AbortController();
    
    // Call the function — must return a pending Promise (don't await it here)
    const promptPromise = promptUserForPermission(
      fakeBot, chatId, topicId, 'bash', '{}', abortController.signal
    );

    // Assert: no setTimeout was created for the prompt's lifetime
    // (observability setInterval is allowed — check specifically for setTimeout)
    const setTimeoutCalls = setTimeoutSpy.mock.calls;
    expect(setTimeoutCalls).toHaveLength(0);

    // Cleanup: abort so the promise resolves and the test can exit
    abortController.abort();
    await promptPromise;
  });
});
```

---

## Key Invariants

1. **Spy BEFORE the call** — `vi.spyOn` must be set up before `promptUserForPermission()` is called, not after.

2. **Assert call count, not absence of arguments** — `expect(spy.mock.calls).toHaveLength(0)` is explicit. Alternatives like `expect(spy).not.toHaveBeenCalled()` are equivalent but less readable.

3. **`setInterval` is permitted** — The observability scanner uses `setInterval`, not `setTimeout`. Only `setTimeout` is prohibited at the prompt call site. If your function uses both, scope the assertion appropriately:
   ```ts
   // Only assert on setTimeout, not setInterval
   expect(setTimeoutSpy.mock.calls).toHaveLength(0);
   // setInterval is allowed; don't assert on it
   ```

4. **Restore the spy in `afterEach`** — Required or other tests will see a spy instead of real `setTimeout`.

---

## Detecting `Infinity` Coercion

The Node.js implementation trap: `setTimeout(fn, Infinity)` coerces `Infinity` to `0` (integer truncation) and fires **immediately**. This means a function that passes `Infinity` as a "no-op timeout" is actually a zero-delay timeout — a silent bug. The no-timer assertion catches this too: the spy fires as soon as the call is made, even before `vi.advanceTimersByTime`.

```ts
// ❌ This fires immediately — caught by the spy assertion
setTimeout(() => deny(), Infinity);

// ✅ This is true no-timeout
// (just don't call setTimeout at all)
```

---

## Combined Pattern: Spy + Fake Timers

When you also need to advance time (e.g., to test the observability scanner), combine with fake timers:

```ts
vi.useFakeTimers({
  toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
  // omit setImmediate — readline compatibility
});

const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

// Call the function under test
const pending = promptUserForPermission(/* ... */);

// Assert no timeout was created
expect(setTimeoutSpy.mock.calls).toHaveLength(0);

// Advance time — no spurious denial should fire
vi.advanceTimersByTime(72 * 60 * 60 * 1000); // 72 hours
expect(setTimeoutSpy.mock.calls).toHaveLength(0); // still zero

vi.useRealTimers();
```

---

## When to Use This Pattern

Apply the no-timer regression assertion whenever:

- A `setTimeout` was removed from production code as part of a documented architectural decision (e.g., no-timeout policy, no-debounce simplification).
- The decision is enshrined in an ADR and a violation would be a breaking change.
- The behavior in the absence of the timer is **identical** to the behavior with an unfired timer — meaning tests alone cannot detect the regression.

---

## Codebase Example

- ADR-9 §7 — `promptUserForPermission()` in `src/bridge/prompt.ts`: `timeoutHandle` removed by K3. C5-02 in `jun-adr9-revised-test-catalog.md` applies this pattern.
- Node.js trap doc: `setTimeout(fn, Infinity)` → fires immediately (coerces to 0).

---

## Related Skills

- `async-iterable-adapter-testing` — cleanup assertions for listener references
- `interleaved-control-plane-testing` — full bidirectional control-plane test matrix
