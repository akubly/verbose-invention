/**
 * Cloud-review-1 regression tests — Carter's fixes for Copilot review T1/T3/T4/T6/T7.
 *
 * T1 (ADR-9 regression): Idle eviction must NOT call dispose() while a
 *    permission prompt is pending.  BridgeSession.isBusy() gates eviction.
 *
 * T3 (Windows rename): generatePipeAuth() falls back to unlink-then-rename
 *    when fs.rename throws EPERM/EEXIST (Windows destination-exists edge case).
 *    The .tmp file is also cleaned up on hard failures.
 *
 * T4 (auth file lifecycle): cleanupPipeAuth() is called when bridge.start()
 *    throws so a stale bridge-auth.json is never left on disk.
 *
 * T6 (overflow latch): After the first overflow error is pushed into the stream
 *    queue, subsequent chunks must NOT enqueue additional items.
 *
 * T7 (shutdown cleanup race — ADR-10): ExtensionBridge.stop() must await
 *    cleanupPipeAuth() so the auth file is guaranteed gone before stop() resolves
 *    (and therefore before process.exit() is called in main.ts shutdown).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { Relay } from '../../src/relay/relay.js';
import { FakeBridge } from '../helpers/FakeBridge.js';
import { InMemoryAllowAlwaysStore } from '../../src/bridge/allowAlwaysStore.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import type { CopilotSession, CopilotSessionFactory } from '../../src/copilot/factory.js';

// ─── shared helpers ──────────────────────────────────────────────────────────

const SESSION_ID = 'sess-cr1';
const REQUEST_ID = 'req-cr1';

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  return { resolve: vi.fn((threadId: string) => map.get(threadId)) };
}

function makeMockChannel() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: '100' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    splitMessage: vi.fn((text: string, footer?: string) => footer ? [`${text}\n\n${footer}`] : [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn(),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn().mockResolvedValue('approve'),
    capabilities: { supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 },
  };
}

const DEFAULT_CTX = { threadId: '42', channelId: '-1001234567890' };

// ─── T1: ADR-9 regression — idle eviction must not abort pending permission ──

describe('T1 — idle eviction defers when session is busy (ADR-9 no-timeout)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // ── isBusy() unit tests (no fake timers needed) ───────────────────────────

  it('BridgeSession.isBusy() returns false when no permissions are pending', () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);
    expect(session.isBusy()).toBe(false);
  });

  it('BridgeSession.isBusy() returns true while a permission prompt is in-flight', () => {
    const bridge = new FakeBridge();
    // Callback that never resolves — keeps the permission permanently in-flight.
    const neverResolves = vi.fn(() => new Promise<boolean>(() => {}));
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: neverResolves,
      allowAlwaysStore: new InMemoryAllowAlwaysStore(),
      sendPermissionResponseFn: vi.fn(),
    });

    expect(session.isBusy()).toBe(false);

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-1', 'bash', '{}');
    // _handlePermissionRequest runs synchronously up to the first await, so
    // _pendingByPermId.set() already fired when emitPermissionRequest returns.
    expect(session.isBusy()).toBe(true);
  });

  it('BridgeSession.isBusy() returns false again once the permission resolves', async () => {
    const bridge = new FakeBridge();
    let resolve!: (v: boolean) => void;
    const controllable = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));

    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: controllable,
      allowAlwaysStore: new InMemoryAllowAlwaysStore(),
      sendPermissionResponseFn: vi.fn(),
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-2', 'bash', '{}');
    expect(session.isBusy()).toBe(true);

    resolve(true);
    // Use a macrotask boundary (setTimeout 0) to guarantee all microtasks from
    // _handlePermissionRequest's await chain have flushed before we check.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(session.isBusy()).toBe(false);
  });

  // ── idle eviction tests (fake timers required) ────────────────────────────

  it('idle eviction is deferred (dispose NOT called) while session is busy', async () => {
    vi.useFakeTimers();
    try {
      const disposeSpy = vi.fn();
      const busySession: CopilotSession = {
        send: vi.fn().mockReturnValue({ async *[Symbol.asyncIterator]() { yield 'ok'; } }),
        dispose: disposeSpy,
        isBusy: vi.fn().mockReturnValue(true), // always busy
      };
      const factory: CopilotSessionFactory = {
        resume: vi.fn().mockResolvedValue(busySession),
        create: vi.fn().mockResolvedValue(busySession),
      };

      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, 'hi');

      // Advance past IDLE_TIMEOUT_MS (default 300 000 ms).
      vi.advanceTimersByTime(310_000);

      // Session is busy — dispose must NOT have been called.
      expect(disposeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('idle eviction proceeds and calls dispose once the session is no longer busy', async () => {
    vi.useFakeTimers();
    try {
      const disposeSpy = vi.fn();
      let busyFlag = true;
      const lazySession: CopilotSession = {
        send: vi.fn().mockReturnValue({ async *[Symbol.asyncIterator]() { yield 'ok'; } }),
        dispose: disposeSpy,
        isBusy: vi.fn(() => busyFlag),
      };
      const factory: CopilotSessionFactory = {
        resume: vi.fn().mockResolvedValue(lazySession),
        create: vi.fn().mockResolvedValue(lazySession),
      };

      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, 'hi');

      // First idle fire: session is busy → deferred, dispose NOT called.
      vi.advanceTimersByTime(310_000);
      expect(disposeSpy).not.toHaveBeenCalled();

      // Permission resolves — session is no longer busy.
      busyFlag = false;

      // Second idle fire: session is idle → dispose IS called.
      vi.advanceTimersByTime(310_000);
      expect(disposeSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── T3: Windows rename fallback in generatePipeAuth ─────────────────────────

import * as fsStatic from 'node:fs/promises';
import * as osStatic from 'node:os';
import * as pathStatic from 'node:path';
import { generatePipeAuth, cleanupPipeAuth, getAuthFilePath } from '../../src/bridge/pipeAuth.js';
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import type { PipeAuthConfig } from '../../src/bridge/pipeAuth.js';

describe('T3 — generatePipeAuth() handles Windows rename EPERM/EEXIST', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * On Windows, fs.rename() to an existing destination throws EPERM.  The fix
   * (unlink-then-rename fallback) is exercised by calling generatePipeAuth()
   * twice against the same file path.
   *
   * Note: node:fs/promises ESM bindings are non-configurable so vi.spyOn cannot
   * wrap them.  These tests use the real filesystem instead.
   */
  it('succeeds on first write (creates the auth file)', async () => {
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t3a-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      const config = await generatePipeAuth();
      const raw = await fsStatic.readFile(getAuthFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as { pipeName: string; token: string };
      expect(parsed.pipeName).toBe(config.pipeName);
      expect(parsed.token).toBe(config.token);
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('succeeds when destination file already exists (second startup writes over first)', async () => {
    // Real filesystem test: write once, then write again without deleting.
    // On Windows this exercises the EPERM fallback (rename to existing file fails;
    // code unlinks destination then renames).  On Linux/macOS rename atomically overwrites.
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t3b-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      await generatePipeAuth();               // first write
      const config2 = await generatePipeAuth(); // second write — destination exists

      const raw = await fsStatic.readFile(getAuthFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as { pipeName: string; token: string };
      expect(parsed.pipeName).toBe(config2.pipeName);
      expect(parsed.token).toBe(config2.token);
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── T4: cleanupPipeAuth() called when bridge.start() throws ─────────────────

describe('T4 — auth file is removed when bridge startup fails', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('cleanupPipeAuth() removes the auth file written by generatePipeAuth()', async () => {
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t4-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      await generatePipeAuth();
      const filePath = getAuthFilePath();

      // Confirm the file exists after generatePipeAuth.
      await expect(fsStatic.access(filePath)).resolves.toBeUndefined();

      // Simulate: bridge.start() throws → main.ts catch calls cleanupPipeAuth().
      await cleanupPipeAuth();

      // File must be gone.
      await expect(fsStatic.access(filePath)).rejects.toThrow();
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cleanupPipeAuth() is a no-op when file is already gone (ENOENT — idempotent)', async () => {
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t4b-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      // No file written — should not throw.
      await expect(cleanupPipeAuth()).resolves.toBeUndefined();
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── T7: stop() awaits cleanupPipeAuth — no shutdown race ────────────────────

describe('T7 — ExtensionBridge.stop() awaits auth file removal', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('auth file is gone after stop() resolves (no server started)', async () => {
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t7-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      const config = await generatePipeAuth();
      const filePath = getAuthFilePath();

      // File exists before stop().
      await expect(fsStatic.access(filePath)).resolves.toBeUndefined();

      const bridge = new ExtensionBridge(config as PipeAuthConfig);
      await bridge.stop();

      // File must be gone by the time stop() resolves.
      await expect(fsStatic.access(filePath)).rejects.toThrow();
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('stop() is safe when auth file is already absent (no double-delete error)', async () => {
    const tempDir = await fsStatic.mkdtemp(pathStatic.join(osStatic.tmpdir(), 'reach-t7b-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      const config = await generatePipeAuth();
      await cleanupPipeAuth(); // remove it first

      const bridge = new ExtensionBridge(config as PipeAuthConfig);
      // Should not reject.
      await expect(bridge.stop()).resolves.toBeUndefined();
    } finally {
      await fsStatic.rm(tempDir, { recursive: true, force: true });
    }
  });
});


describe('T6 — stream overflow latch stops further enqueuing', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * MAX_STREAM_QUEUE_SIZE is 1000 (internal constant).
   * We emit exactly 1001 frames so the 1001st triggers the overflow path.
   *
   * Key design: the FakeBridge emitter is synchronous.  When bridge.emitStream()
   * is called, the listener executes synchronously.  The overflow path calls
   * this.bridge.off() synchronously too.  So all assertions below can run
   * WITHOUT awaiting anything — the test is fully synchronous.
   */
  const MAX_QUEUE = 1000;

  function setupOverflow(bridge: FakeBridge, sessionId = SESSION_ID, requestId = REQUEST_ID) {
    const session = new BridgeSession(bridge, sessionId, () => requestId);
    // Park the generator so listeners are registered.
    // We discard the Promise — we only need side effects (listener registration).
    void session.send('hi')[Symbol.asyncIterator]().next();
    // Fill the queue to the limit.
    for (let i = 0; i < MAX_QUEUE; i++) {
      bridge.emitStream(sessionId, requestId, `c${i}`, false);
    }
    // One more frame triggers overflow → latch removes listeners synchronously.
    bridge.emitStream(sessionId, requestId, 'overflow', false);
  }

  it('overflow removes the stream listener from the bridge emitter synchronously', () => {
    const bridge = new FakeBridge();
    setupOverflow(bridge);

    const streamOffCalls = bridge.offCalls.filter((c) => c.event === 'stream');
    expect(streamOffCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('overflow removes the stream.error listener from the bridge emitter synchronously', () => {
    const bridge = new FakeBridge();
    setupOverflow(bridge);

    const streamErrOffCalls = bridge.offCalls.filter((c) => c.event === 'stream.error');
    expect(streamErrOffCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('frames emitted after overflow trigger no additional off() calls (listeners already gone)', () => {
    const bridge = new FakeBridge();
    setupOverflow(bridge);

    const offCountBefore = bridge.offCalls.length;

    // 10 more frames — listeners are already removed, so these are no-ops on the emitter.
    for (let i = 0; i < 10; i++) {
      bridge.emitStream(SESSION_ID, REQUEST_ID, `post-${i}`, false);
    }

    // No new off() calls from the post-overflow frames.
    expect(bridge.offCalls.length).toBe(offCountBefore);
  });
});
