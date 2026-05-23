/**
 * ADR-9 Permission Prompting — Categories 1, 3, and 7.
 *
 * Category 1: Happy path — permission.request → callback invoked → permission.response sent.
 * Category 3: Correlation / ordering — foreign sessionId events are ignored; multi-session isolation.
 * Category 7: Regression guards — listener cleanup, no-perm-options baseline, data-plane coexistence.
 *
 * Test doubles: FakeBridge (listener tracking + synchronous emit helpers).
 * All tests drive BridgeSession at the unit level via FakeBridge — no real named pipe.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { InMemoryAllowAlwaysStore } from '../../src/bridge/allowAlwaysStore.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-perm-1';
const REQUEST_ID = 'req-perm-abc';
const PERM_ID = 'perm-uuid-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a BridgeSession wired with a permission callback and response spy.
 * sendResponseFn is a vi.fn() spy — assert on it to verify permission.response delivery.
 */
function makePermSession(
  bridge: FakeBridge,
  sessionId = SESSION_ID,
  opts: {
    callback?: (toolName: string, args: string, signal?: AbortSignal) => Promise<boolean>;
    store?: InMemoryAllowAlwaysStore;
  } = {},
) {
  const sendResponseFn = vi.fn();
  const permissionCallback =
    opts.callback ?? vi.fn().mockResolvedValue(true);

  const session = new BridgeSession(bridge, sessionId, () => REQUEST_ID, {
    permissionCallback,
    allowAlwaysStore: opts.store,
    sendPermissionResponseFn: sendResponseFn,
  });

  return { session, sendResponseFn, permissionCallback };
}

/**
 * Awaits one I/O cycle (all pending microtasks + one setImmediate tick).
 * Used after emitPermissionRequest() so the void async _handlePermissionRequest
 * has had a chance to resolve and call sendPermissionResponseFn.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Category 1: Happy Path ───────────────────────────────────────────────────

describe('C1 — happy-path permission prompting', () => {
  it('C1-01: permission.request → callback returns true → sendPermissionResponseFn called with "allow"', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn().mockResolvedValue(true),
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{"cmd":"ls"}');
    await flush();

    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C1-02: permission.request → callback returns false → sendPermissionResponseFn called with "deny"', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn().mockResolvedValue(false),
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{"cmd":"rm -rf /"}');
    await flush();

    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'deny');
  });

  it('C1-03: callback receives correct toolName and args from the permission.request event', async () => {
    const bridge = new FakeBridge();
    const { permissionCallback, sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn().mockResolvedValue(true),
    });

    bridge.emitPermissionRequest(
      SESSION_ID, REQUEST_ID, PERM_ID, 'powershell', '{"script":"Get-ChildItem"}',
    );
    await flush();

    expect(permissionCallback).toHaveBeenCalledOnce();
    const [toolName, args] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, AbortSignal | undefined];
    expect(toolName).toBe('powershell');
    expect(args).toBe('{"script":"Get-ChildItem"}');
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C1-04: callback receives an AbortSignal that is not already aborted at call time', async () => {
    const bridge = new FakeBridge();
    let receivedSignal: AbortSignal | undefined;

    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn((_toolName: string, _args: string, signal?: AbortSignal) => {
        receivedSignal = signal;
        return Promise.resolve(true);
      }),
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C1-05: two simultaneous permission.requests → two independent callback invocations and responses', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn, permissionCallback } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn().mockResolvedValue(true),
    });

    const PERM_ID_2 = 'perm-uuid-002';
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{"a":1}');
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID_2, 'powershell', '{"b":2}');
    await flush();

    expect(permissionCallback).toHaveBeenCalledTimes(2);
    expect(sendResponseFn).toHaveBeenCalledTimes(2);
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID_2, 'allow');
  });
});

// ─── Category 3: Correlation / Ordering ──────────────────────────────────────

describe('C3 — correlation and ordering', () => {
  it('C3-01: permission.request for a different sessionId is silently ignored', async () => {
    const bridge = new FakeBridge();
    const { permissionCallback } = makePermSession(bridge, SESSION_ID);

    // Emit with a foreign sessionId — should not trigger our callback.
    bridge.emitPermissionRequest('sess-OTHER', REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    expect(permissionCallback).not.toHaveBeenCalled();
  });

  it('C3-02: permission.cancelled for a different sessionId does not affect a pending prompt', async () => {
    const bridge = new FakeBridge();
    let externalResolve!: (approved: boolean) => void;

    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn((_toolName: string, _args: string, signal?: AbortSignal) => {
        return new Promise<boolean>((resolve) => {
          externalResolve = resolve;
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      }),
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    // Cancel for a different session — must not abort our prompt.
    bridge.emitPermissionCancelled('sess-OTHER', PERM_ID);
    await flush();

    // Our prompt is still pending — not yet resolved.
    expect(sendResponseFn).not.toHaveBeenCalled();

    // Resolve it manually to clean up.
    externalResolve(true);
    await flush();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C3-03: two BridgeSessions on the same FakeBridge — each session only handles its own requests', async () => {
    const bridge = new FakeBridge();

    const { sendResponseFn: responseA, permissionCallback: cbA } = makePermSession(
      bridge,
      'sess-A',
    );
    const { sendResponseFn: responseB, permissionCallback: cbB } = makePermSession(
      bridge,
      'sess-B',
    );

    // Fire request for sess-B only.
    bridge.emitPermissionRequest('sess-B', 'req-B', 'perm-B', 'bash', '{}');
    await flush();

    // sess-A's callback should not fire.
    expect(cbA).not.toHaveBeenCalled();
    expect(responseA).not.toHaveBeenCalled();

    // sess-B's callback should fire exactly once.
    expect(cbB).toHaveBeenCalledOnce();
    expect(responseB).toHaveBeenCalledWith('sess-B', 'perm-B', 'allow');
  });
});

// ─── Category 7: Regression Guards ───────────────────────────────────────────

describe('C7 — regression guards', () => {
  it('C7-01: all three permission listeners are cleaned up when session.disconnected fires', async () => {
    const bridge = new FakeBridge();
    makePermSession(bridge, SESSION_ID);

    // Three listeners registered on construction: permission.request, permission.cancelled,
    // session.disconnected.
    const permReqOn = bridge.onCalls.filter((c) => c.event === 'permission.request');
    const permCxlOn = bridge.onCalls.filter((c) => c.event === 'permission.cancelled');
    const discOn = bridge.onCalls.filter((c) => c.event === 'session.disconnected');

    expect(permReqOn).toHaveLength(1);
    expect(permCxlOn).toHaveLength(1);
    expect(discOn).toHaveLength(1);

    // Trigger disconnect — self-cleanup removes all three.
    bridge.emitDisconnected(SESSION_ID);
    await flush();

    const permReqOff = bridge.offCalls.filter((c) => c.event === 'permission.request');
    const permCxlOff = bridge.offCalls.filter((c) => c.event === 'permission.cancelled');
    const discOff = bridge.offCalls.filter((c) => c.event === 'session.disconnected');

    expect(permReqOff).toHaveLength(1);
    expect(permCxlOff).toHaveLength(1);
    expect(discOff).toHaveLength(1);

    // Same listener references passed to off() as were passed to on().
    expect(permReqOff[0]!.listener).toBe(permReqOn[0]!.listener);
    expect(permCxlOff[0]!.listener).toBe(permCxlOn[0]!.listener);
    expect(discOff[0]!.listener).toBe(discOn[0]!.listener);
  });

  it('C7-02: BridgeSession constructed WITHOUT permOptions registers zero permission listeners', () => {
    const bridge = new FakeBridge();
    // No permOptions — backward-compatible mode.
    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const permListeners = bridge.onCalls.filter(
      (c) =>
        c.event === 'permission.request' ||
        c.event === 'permission.cancelled' ||
        // session.disconnected is only registered by _wirePermissionHandlers
        c.event === 'session.disconnected',
    );

    expect(permListeners).toHaveLength(0);
  });

  it('C7-03: an active stream yields correctly while a permission prompt is concurrently pending', async () => {
    const bridge = new FakeBridge();
    // Callback that hangs until manually resolved.
    let resolvePermission!: (approved: boolean) => void;
    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, {
      callback: vi.fn(() => new Promise<boolean>((r) => { resolvePermission = r; })),
    });

    // Start a data-plane stream.
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: vi.fn().mockResolvedValue(true),
      sendPermissionResponseFn: sendResponseFn,
    });

    const chunks: string[] = [];
    const streamDone = (async () => {
      for await (const chunk of session.send('hello')) {
        chunks.push(chunk);
      }
    })();

    // Emit permission.request while stream is open — data plane must not stall.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');

    // Stream chunks arrive normally.
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'chunk-1', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'chunk-2', true);

    await streamDone;
    expect(chunks).toEqual(['chunk-1', 'chunk-2']);

    // Resolve the permission — should still complete cleanly.
    resolvePermission(true);
    await flush();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });
});
