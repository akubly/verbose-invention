/**
 * Review-cycle 1 regression tests — Carter's fixes.
 *
 * B1: BridgeSession.dispose() removes all three permission-plane listeners so
 *     idle-evicted sessions don't leak handlers onto the bridge emitter.
 *
 * B2: session.disconnected fired while _generateStream is waiting terminates the
 *     async generator with an error so relay.ts's for-await loop unblocks.
 *
 * I9: Concurrent permission request rate-limit auto-denies when >MAX_PENDING.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';
import { InMemoryAllowAlwaysStore } from '../../src/bridge/allowAlwaysStore.js';

const SESSION_ID = 'sess-r1-1';
const REQUEST_ID = 'req-r1-abc';

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makePermSession(bridge: FakeBridge, sessionId = SESSION_ID) {
  const sendResponseFn = vi.fn();
  const permissionCallback = vi.fn().mockResolvedValue(true);
  const session = new BridgeSession(bridge, sessionId, () => REQUEST_ID, {
    permissionCallback,
    allowAlwaysStore: new InMemoryAllowAlwaysStore(),
    sendPermissionResponseFn: sendResponseFn,
  });
  return { session, sendResponseFn, permissionCallback };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── B1: dispose() removes all three permission listeners ─────────────────────

describe('B1 — BridgeSession.dispose() listener cleanup', () => {
  it('dispose() calls bridge.off() for all three permission-plane listeners', async () => {
    const bridge = new FakeBridge();
    const { session } = makePermSession(bridge);

    // Three listeners registered at construction.
    expect(bridge.onCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.onCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.onCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);

    // Simulate idle eviction — call dispose() without any disconnect event.
    session.dispose();

    // All three listeners must have been removed.
    expect(bridge.offCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);
  });

  it('dispose() is idempotent — calling twice removes listeners exactly once', () => {
    const bridge = new FakeBridge();
    const { session } = makePermSession(bridge);

    session.dispose();
    session.dispose(); // second call must be a no-op

    expect(bridge.offCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);
  });

  it('after dispose() a new session on the same sessionId fires the callback only once (no duplicate)', async () => {
    const bridge = new FakeBridge();

    // Session 1 — simulates what was in the relay cache before idle eviction.
    const cb1 = vi.fn().mockResolvedValue(true);
    const resp1 = vi.fn();
    const session1 = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: cb1,
      allowAlwaysStore: new InMemoryAllowAlwaysStore(),
      sendPermissionResponseFn: resp1,
    });

    // Idle eviction: relay calls dispose() then drops the reference.
    session1.dispose();

    // Session 2 — created on the next relay call for the same topic/sessionId.
    const cb2 = vi.fn().mockResolvedValue(true);
    const resp2 = vi.fn();
    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: cb2,
      allowAlwaysStore: new InMemoryAllowAlwaysStore(),
      sendPermissionResponseFn: resp2,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-dup', 'bash', '{}');
    await flush();

    // Only session 2 should have been called — session 1's listener was disposed.
    expect(cb1).not.toHaveBeenCalled();
    expect(resp1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
    expect(resp2).toHaveBeenCalledWith(SESSION_ID, 'perm-dup', 'allow');
  });

  it('session.disconnected event also removes all three listeners (existing path still works)', async () => {
    const bridge = new FakeBridge();
    makePermSession(bridge);

    bridge.emitDisconnected(SESSION_ID);
    await flush();

    expect(bridge.offCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);
  });
});

// ── B2: session.disconnected terminates _generateStream ──────────────────────

describe('B2 — stream terminates on session.disconnected', () => {
  it('session.disconnected while generator is waiting throws a disconnect error', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    // Park the generator at the queue-wait Promise.
    const p = iter.next();

    // Extension dies — pipe fires session.disconnected.
    bridge.emitDisconnected(SESSION_ID);

    await expect(p).rejects.toThrow(/disconnected/i);
  });

  it('session.disconnected after some chunks throws, not hangs', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const chunks: string[] = [];
    let caughtErr: Error | undefined;

    const consuming = (async () => {
      try {
        for await (const chunk of session.send('hello')) {
          chunks.push(chunk);
        }
      } catch (err) {
        caughtErr = err instanceof Error ? err : new Error(String(err));
      }
    })();

    // A couple of chunks arrive…
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'part1', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'part2', false);
    // …then the extension dies.
    bridge.emitDisconnected(SESSION_ID);

    await consuming;

    expect(chunks).toEqual(['part1', 'part2']);
    expect(caughtErr).toBeDefined();
    expect(caughtErr!.message).toMatch(/disconnected/i);
  });

  it('cleanup removes session.disconnected listener from stream path after completion', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStream(SESSION_ID, REQUEST_ID, 'x', true);
    await p;
    await iter.next(); // drive to completion

    const streamDisconnOff = bridge.offCalls.filter((c) => c.event === 'session.disconnected');
    expect(streamDisconnOff).toHaveLength(1);
  });
});

// ── I9: rate limit on permission.request ─────────────────────────────────────

describe('I9 — concurrent permission request rate limit', () => {
  it('auto-denies when concurrent pending permissions exceed the cap (5)', async () => {
    const bridge = new FakeBridge();

    // Callback that never resolves until we tell it to — keeps permissions in-flight.
    const resolvers: Array<(v: boolean) => void> = [];
    const pendingCallback = vi.fn((_name: string, _args: string, _sig?: AbortSignal) => {
      return new Promise<boolean>((resolve) => { resolvers.push(resolve); });
    });
    const sendResponseFn = vi.fn();

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: pendingCallback,
      allowAlwaysStore: new InMemoryAllowAlwaysStore(),
      sendPermissionResponseFn: sendResponseFn,
    });

    // Fire 5 requests — all should call the callback.
    for (let i = 1; i <= 5; i++) {
      bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, `perm-${i}`, 'bash', '{}');
    }
    await flush();
    expect(pendingCallback).toHaveBeenCalledTimes(5);
    sendResponseFn.mockClear();

    // 6th request while all 5 are still in-flight → auto-denied without callback.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-over-limit', 'bash', '{}');
    await flush();

    expect(pendingCallback).toHaveBeenCalledTimes(5); // still 5, no new call
    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, 'perm-over-limit', 'deny');

    // Cleanup: resolve all pending so test doesn't leak.
    for (const r of resolvers) r(false);
    await flush();
  });
});
