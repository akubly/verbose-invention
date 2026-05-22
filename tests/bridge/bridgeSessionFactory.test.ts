/**
 * J3 — BridgeSessionFactory contract tests.
 *
 * Mocks ExtensionBridge with only the surface the factory uses:
 *   - getSessionByName(name)  → ExtensionConnection | undefined
 *   - sendCommand(sId, text)  → string | false  (passed as sendFn to BridgeSession)
 *   - on/off                  → BridgeEmitter surface (forwarded to BridgeSession)
 *
 * Tests cover: resume + create happy / null / throw paths, resetForRestart no-op,
 * and permissionCallback accepted-but-ignored (documented ADR-9 gap).
 */

import { describe, it, expect, vi } from 'vitest';
import { BridgeSessionFactory } from '../../src/bridge/bridgeSessionFactory.js';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import type { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import type { PermissionPromptCallback } from '../../src/copilot/factory.js';

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Minimal ExtensionBridge mock that covers only the surface BridgeSessionFactory
 * and BridgeSession use. `sessionsByName` maps human-readable session names to
 * their internal sessionIds (as the real bridge stores after `hello` messages).
 */
function makeBridgeMock(
  sessionsByName: Record<string, string> = {},
): ExtensionBridge {
  return {
    getSessionByName: vi.fn((name: string) => {
      const sessionId = sessionsByName[name];
      if (!sessionId) return undefined;
      return { sessionId, status: 'registered' as const, send: vi.fn() };
    }),
    sendCommand: vi.fn((): string | false => 'req-factory-1'),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    // Fill remaining shape with stubs so the cast is safe
    getSession: vi.fn(() => undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionBridge;
}

// ── J3 tests ──────────────────────────────────────────────────────────────────

describe('BridgeSessionFactory', () => {
  // ── 1. resume() — session registered ────────────────────────────────────────

  it('resume() returns a BridgeSession when the session is registered on the bridge', async () => {
    const bridge = makeBridgeMock({ 'reach-myapp': 'sess-uuid-1' });
    const factory = new BridgeSessionFactory(bridge);

    const result = await factory.resume('reach-myapp');

    expect(result).toBeInstanceOf(BridgeSession);
  });

  // ── 2. resume() — session NOT registered ────────────────────────────────────

  it('resume() returns null when the session is not registered on the bridge', async () => {
    const bridge = makeBridgeMock({}); // no sessions
    const factory = new BridgeSessionFactory(bridge);

    const result = await factory.resume('nonexistent-session');

    expect(result).toBeNull();
  });

  // ── 3. create() — session registered ────────────────────────────────────────

  it('create() returns a BridgeSession when the session is registered on the bridge', async () => {
    const bridge = makeBridgeMock({ 'reach-myapp': 'sess-uuid-2' });
    const factory = new BridgeSessionFactory(bridge);

    const result = await factory.create('reach-myapp');

    expect(result).toBeInstanceOf(BridgeSession);
  });

  // ── 4. create() — session NOT registered → throws ────────────────────────────

  it('create() throws a descriptive error when the session is not registered', async () => {
    const bridge = makeBridgeMock({}); // no sessions
    const factory = new BridgeSessionFactory(bridge);

    await expect(factory.create('ghost-session')).rejects.toThrow(/ghost-session/i);
  });

  // ── 5. resetForRestart() — no-op, does not throw ────────────────────────────

  it('resetForRestart() is a no-op and does not throw', () => {
    const bridge = makeBridgeMock();
    const factory = new BridgeSessionFactory(bridge);

    expect(() => factory.resetForRestart()).not.toThrow();
  });

  // ── 6. permissionCallback accepted but ignored (ADR-9 documented gap) ────────

  it('accepts a permissionCallback without crashing, but does not invoke it', async () => {
    const bridge = makeBridgeMock({ 'reach-myapp': 'sess-uuid-3' });
    const factory = new BridgeSessionFactory(bridge);

    const permCb: PermissionPromptCallback = vi.fn().mockResolvedValue(true);

    const result = await factory.resume('reach-myapp', undefined, permCb);

    expect(result).toBeInstanceOf(BridgeSession);
    // Callback accepted for interface compatibility, but never called —
    // bridge sessions handle permissions locally in the extension (ADR-9 gap).
    expect(permCb).not.toHaveBeenCalled();
  });
});
