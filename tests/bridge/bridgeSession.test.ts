/**
 * J1 — BridgeSession contract tests.
 *
 * Uses FakeBridge (tests/helpers/FakeBridge.ts) to drive bridge events
 * deterministically. Tests are contract-oriented: they assert observable
 * behaviour (chunks yielded, errors thrown, listeners cleaned up) without
 * reaching into Kat's internal queue implementation.
 *
 * Timing technique: `iter.next()` runs the async generator synchronously
 * until its first `await`. By the time the call returns, the generator has
 * registered its listeners and is parked at the internal queue-wait Promise.
 * Emitting events _synchronously_ after that point fires the listener,
 * resolves the Promise, and queues a microtask — so `await iter.next()`
 * in the test picks up the value on the very next microtask drain.
 */

import { describe, it, expect } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

const SESSION_ID = 'sess-test-1';
const REQUEST_ID = 'req-test-abc';

/** Build a BridgeSession whose sendFn always returns the given requestId (or false). */
function makeSession(
  bridge: FakeBridge,
  sendResult: string | false = REQUEST_ID,
): BridgeSession {
  return new BridgeSession(bridge, SESSION_ID, () => sendResult);
}

// ── Test cases ────────────────────────────────────────────────────────────────

describe('BridgeSession', () => {
  // ── 1. Single chunk, done: true ─────────────────────────────────────────────

  it('yields a single chunk then completes when done: true', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next(); // generator starts, parks at queue-wait; signal is set

    bridge.emitStream(SESSION_ID, REQUEST_ID, 'the-chunk', true);

    const r1 = await p;
    const r2 = await iter.next();

    expect(r1).toEqual({ value: 'the-chunk', done: false });
    expect(r2.done).toBe(true);
  });

  // ── 2. Multi-chunk sequence, done: true on last ──────────────────────────────

  it('yields all chunks in order and completes after done: true on last', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStream(SESSION_ID, REQUEST_ID, 'one', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'two', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'three', true);

    // All three chunks land in the queue before the first await resolves.
    const r1 = await p;
    const r2 = await iter.next();
    const r3 = await iter.next();
    const r4 = await iter.next();

    expect(r1.value).toBe('one');
    expect(r2.value).toBe('two');
    expect(r3.value).toBe('three');
    expect(r4.done).toBe(true);
  });

  // ── 3. stream.error → generator throws ──────────────────────────────────────

  it('throws with the error message when stream.error arrives for our requestId', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStreamError(SESSION_ID, REQUEST_ID, 'CLI session crashed');

    await expect(p).rejects.toThrow('CLI session crashed');
  });

  // ── 4. Foreign requestId interleaved → not yielded ──────────────────────────

  it('ignores stream events for a different requestId', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const chunks: string[] = [];
    const consuming = (async () => {
      for await (const c of session.send('hello')) {
        chunks.push(c);
      }
    })();

    // Foreign requestId first — must not appear in chunks
    bridge.emitStream(SESSION_ID, 'req-OTHER', 'foreign-chunk', false);
    // Our requestId — should appear
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'our-chunk', true);

    await consuming;

    expect(chunks).toEqual(['our-chunk']);
    expect(chunks).not.toContain('foreign-chunk');
  });

  // ── 5. sendCommand returns false → throw immediately, no leaked listeners ───

  it('throws with "unreachable" semantics when sendFn returns false', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge, false); // sendFn always returns false

    await expect(
      (async () => {
        for await (const _ of session.send('hello')) {
          // should never reach here
        }
      })(),
    ).rejects.toThrow(/unreachable/i);

    // No listeners should have been registered (Kat's impl throws before on())
    // OR, if registered then cleaned up — net: onCalls.length === offCalls.length
    expect(bridge.onCalls.length).toBe(bridge.offCalls.length);
  });

  // ── 6. Listener cleanup on success (done: true) ──────────────────────────────

  it('calls bridge.off() for both stream and stream.error after successful completion', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStream(SESSION_ID, REQUEST_ID, 'done-chunk', true);

    await p;
    await iter.next(); // drive to completion

    const streamOffCalls = bridge.offCalls.filter((c) => c.event === 'stream');
    const errorOffCalls = bridge.offCalls.filter((c) => c.event === 'stream.error');

    expect(streamOffCalls).toHaveLength(1);
    expect(errorOffCalls).toHaveLength(1);

    // Same listener reference must be passed to off() as was passed to on()
    const streamOnListener = bridge.onCalls.find((c) => c.event === 'stream')?.listener;
    const streamOffListener = streamOffCalls[0]?.listener;
    if (streamOnListener !== undefined) {
      expect(streamOffListener).toBe(streamOnListener);
    }
  });

  // ── 7. Listener cleanup on stream.error ─────────────────────────────────────

  it('calls bridge.off() for both listeners after stream.error', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStreamError(SESSION_ID, REQUEST_ID, 'something broke');

    // The generator throws; catch so the test doesn't fail
    await p.catch(() => {});

    expect(bridge.offCalls.filter((c) => c.event === 'stream')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'stream.error')).toHaveLength(1);
  });

  // ── 8. Listener cleanup on early consumer abandonment ───────────────────────

  it('cleans up both listeners when the consumer breaks out early', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const consumed: string[] = [];
    const consuming = (async () => {
      for await (const chunk of session.send('hello')) {
        consumed.push(chunk);
        break; // abandon after first chunk — triggers iterator.return()
      }
    })();

    // Generator started, signal set; emit one chunk to unblock it
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'first', false); // not done

    await consuming; // consumer broke out, finally block should have run

    expect(consumed).toEqual(['first']);
    // Both listeners must be cleaned up despite the early exit
    expect(bridge.offCalls.filter((c) => c.event === 'stream')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'stream.error')).toHaveLength(1);
  });

  // ── 9. Chunks delivered before consumer awaits the first result ──────────────

  it('does not drop chunks that arrive synchronously after the generator starts', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    // Start the generator — it runs synchronously until its internal queue-wait
    // Promise, at which point `signal` is set and the generator is parked.
    const p = iter.next();

    // Emit THREE events synchronously before we await p.
    // All land in the queue while the generator is already parked.
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'early-1', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'early-2', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'early-3', true);

    const r1 = await p;
    const r2 = await iter.next();
    const r3 = await iter.next();
    const r4 = await iter.next();

    expect(r1.value).toBe('early-1');
    expect(r2.value).toBe('early-2');
    expect(r3.value).toBe('early-3');
    expect(r4.done).toBe(true);
  });

  // ── 10. Empty completion — done: true with no chunk content ─────────────────

  it('completes immediately yielding nothing when stream ends with no chunks', async () => {
    const bridge = new FakeBridge();
    const session = makeSession(bridge);

    const chunks: string[] = [];
    const consuming = (async () => {
      for await (const c of session.send('hello')) {
        chunks.push(c);
      }
    })();

    // Emit done with empty chunk string — signals completion with no content
    bridge.emitStream(SESSION_ID, REQUEST_ID, '', true);

    await consuming;

    expect(chunks).toEqual([]); // no content chunks
  });
});
