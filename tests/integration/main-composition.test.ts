/**
 * A8 + N3 — Composition root integration harness for main().
 *
 * Verifies two branches of main() in isolation:
 *
 *   A8a — Pairing-mode early-return: when isPairingMode is true, main()
 *         calls runPairingMode() and returns without starting any servers,
 *         registries, or bridge connections.
 *
 *   A8b — Normal-mode wiring: when a chatId is known (from config-file or env),
 *         main() wires all dependencies and starts the grammY bot.
 *
 *   N3  — Config-file allowedUserIdSet end-to-end: when parseEnv() returns an
 *         allowedUserIdSet sourced from config.json (not env var), main() passes
 *         it through to AfkModeController. Complements the unit-level coverage
 *         in tests/config/env.test.ts (M5-4) which already tests the parseEnv()
 *         config-file branch in isolation.
 *
 * All external module boundaries are mocked; no real network, file I/O, or
 * process.exit. vi.hoisted() is used so mock instances are accessible inside
 * vi.mock() factory functions AND in test assertions.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { EnvConfig } from '../../src/config/env.js';

// ── Hoisted mock instances ────────────────────────────────────────────────────
// These are created before vi.mock factories run, so factories can close over them.

const {
  mockBotStart,
  mockBotStop,
  mockBridgeStart,
  mockBridgeStop,
  mockRegistryLoad,
  MockAfkModeController,
  mockRegisterHandlers,
  mockGeneratePipeAuth,
  mockCleanupPipeAuth,
} = vi.hoisted(() => {
  const mockBotStart = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockBotStop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockBridgeStart = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockBridgeStop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockRegistryLoad = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const MockAfkModeController = vi.fn().mockImplementation(() => ({}));
  const mockRelayDispose = vi.fn();
  const mockRegisterHandlers = vi.fn().mockReturnValue({ dispose: mockRelayDispose });
  const mockGeneratePipeAuth = vi.fn().mockResolvedValue({
    pipeName: 'reach-bridge-test',
    pipePath: '\\\\.\\pipe\\reach-bridge-test',
    token: 'aabbcc',
  });
  const mockCleanupPipeAuth = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  return {
    mockBotStart,
    mockBotStop,
    mockBridgeStart,
    mockBridgeStop,
    mockRegistryLoad,
    MockAfkModeController,
    mockRegisterHandlers,
    mockGeneratePipeAuth,
    mockCleanupPipeAuth,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/channel/telegram/index.js', () => ({})); // suppress side-effect registration
vi.mock('../../src/channel/registry.js', () => ({
  createChannel: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    splitMessage: vi.fn((text: string) => [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn(),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn(),
    capabilities: { supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 },
  }),
}));

vi.mock('../../src/config/env.js', () => ({
  parseEnv: vi.fn(),
}));

vi.mock('../../src/bot/pairing.js', () => ({
  runPairingMode: vi.fn<[EnvConfig], Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../../src/bridge/pipeAuth.js', () => ({
  generatePipeAuth: mockGeneratePipeAuth,
  cleanupPipeAuth: mockCleanupPipeAuth,
}));

vi.mock('../../src/bridge/extensionBridge.js', () => ({
  ExtensionBridge: vi.fn().mockImplementation(() => ({
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
}));

vi.mock('../../src/bot/index.js', () => ({
  createBot: vi.fn().mockImplementation(() => ({
    start: mockBotStart,
    stop: mockBotStop,
  })),
}));

vi.mock('../../src/bot/handlers.js', () => ({
  registerHandlers: mockRegisterHandlers,
}));

vi.mock('../../src/sessions/registry.js', () => ({
  SessionRegistry: vi.fn().mockImplementation(() => ({
    load: mockRegistryLoad,
  })),
}));

vi.mock('../../src/copilot/impl.js', () => ({
  CopilotClientImpl: vi.fn().mockImplementation(() => ({
    stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/bridge/bridgeSessionFactory.js', () => ({
  BridgeSessionFactory: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/bridge/compositeSessionFactory.js', () => ({
  CompositeSessionFactory: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/bot/afkMode.js', () => ({
  AfkModeController: MockAfkModeController,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { main } from '../../src/main.js';
import { parseEnv } from '../../src/config/env.js';
import { runPairingMode } from '../../src/bot/pairing.js';
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import { createBot } from '../../src/bot/index.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { CopilotClientImpl } from '../../src/copilot/impl.js';
import { BridgeSessionFactory } from '../../src/bridge/bridgeSessionFactory.js';
import { CompositeSessionFactory } from '../../src/bridge/compositeSessionFactory.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makePairingConfig(): EnvConfig {
  return {
    token: 'test-token',
    chatId: undefined,
    isPairingMode: true,
    model: 'claude-sonnet-4',
    permissionPolicy: 'approveAll',
    allowedUserIdSet: undefined,
    configPath: 'C:\\fake\\config.json',
    registryPath: 'C:\\fake\\data\\registry.json',
    reachChannel: 'telegram',
  };
}

function makeNormalConfig(overrides: { allowedUserIdSet?: ReadonlySet<number> } = {}): EnvConfig {
  return {
    token: 'test-token',
    chatId: 12345,
    isPairingMode: false,
    model: 'claude-sonnet-4',
    permissionPolicy: 'interactiveDestructive',
    allowedUserIdSet: undefined,
    configPath: 'C:\\fake\\config.json',
    registryPath: 'C:\\fake\\data\\registry.json',
    reachChannel: 'telegram',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Integration: main() composition root (A8 + N3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.restoreAllMocks() in afterEach clears the `implementation` closure of every
    // vi.fn() (including hoisted ones). Re-establish ALL implementations here so each
    // test starts with a fully-functional mock graph.
    mockBotStart.mockResolvedValue(undefined);
    mockBotStop.mockResolvedValue(undefined);
    mockBridgeStart.mockResolvedValue(undefined);
    mockBridgeStop.mockResolvedValue(undefined);
    mockRegistryLoad.mockResolvedValue(undefined);
    mockGeneratePipeAuth.mockResolvedValue({
      pipeName: 'reach-bridge-test',
      pipePath: '\\\\.\\pipe\\reach-bridge-test',
      token: 'aabbcc',
    });
    mockCleanupPipeAuth.mockResolvedValue(undefined);
    MockAfkModeController.mockImplementation(() => ({}));
    mockRegisterHandlers.mockReturnValue({ dispose: vi.fn() });

    // Re-establish inline mock implementations (also cleared by restoreAllMocks).
    vi.mocked(ExtensionBridge).mockImplementation(() => ({
      start: mockBridgeStart,
      stop: mockBridgeStop,
    }));
    vi.mocked(createBot).mockImplementation(() => ({
      start: mockBotStart,
      stop: mockBotStop,
    }));
    vi.mocked(SessionRegistry).mockImplementation(() => ({
      load: mockRegistryLoad,
    }));
    vi.mocked(CopilotClientImpl).mockImplementation(() => ({
      stop: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mocked(BridgeSessionFactory).mockImplementation(() => ({}));
    vi.mocked(CompositeSessionFactory).mockImplementation(() => ({}));

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  // ── A8a: Pairing-mode early-return ──────────────────────────────────────────

  describe('A8a — pairing-mode early-return path', () => {
    it('calls runPairingMode() and returns without starting the bot', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makePairingConfig());

      await main();

      expect(runPairingMode).toHaveBeenCalledOnce();
      expect(mockBotStart).not.toHaveBeenCalled();
    });

    it('passes the resolved config to runPairingMode()', async () => {
      const cfg = makePairingConfig();
      vi.mocked(parseEnv).mockResolvedValue(cfg);

      await main();

      expect(runPairingMode).toHaveBeenCalledWith(cfg);
    });

    it('does not construct ExtensionBridge, SessionRegistry, or CopilotClientImpl in pairing mode', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makePairingConfig());

      await main();

      expect(ExtensionBridge).not.toHaveBeenCalled();
      expect(SessionRegistry).not.toHaveBeenCalled();
      expect(CopilotClientImpl).not.toHaveBeenCalled();
      expect(mockRegisterHandlers).not.toHaveBeenCalled();
    });
  });

  // ── A8b: Config-file env resolution (normal mode) ───────────────────────────

  describe('A8b — config-file env resolution (normal mode)', () => {
    it('wires all dependencies and starts the bot when bridge is available', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig());

      await main();

      expect(SessionRegistry).toHaveBeenCalledOnce();
      expect(ExtensionBridge).toHaveBeenCalledOnce();
      expect(mockBridgeStart).toHaveBeenCalledOnce();
      expect(CopilotClientImpl).toHaveBeenCalledOnce();
      expect(mockRegistryLoad).toHaveBeenCalledOnce();
      expect(createBot).toHaveBeenCalledWith('test-token', 12345);
      expect(mockRegisterHandlers).toHaveBeenCalledOnce();
      expect(mockBotStart).toHaveBeenCalledOnce();
    });

    it('falls back to sdk-only factory and skips AfkModeController when bridge is unavailable', async () => {
      mockGeneratePipeAuth.mockRejectedValueOnce(new Error('named pipe unavailable'));
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig());

      await main();

      // Bot still starts despite bridge failure
      expect(mockBotStart).toHaveBeenCalledOnce();
      // AfkModeController requires a bridge — must not be constructed
      expect(MockAfkModeController).not.toHaveBeenCalled();
    });
  });

  // ── N3: Config-file allowedUserIdSet wired into AfkModeController ───────────

  describe('N3 — config-file allowedUserIdSet wired through main()', () => {
    it('passes config-file allowedUserIdSet to AfkModeController options (bridge available)', async () => {
      const configAllowedIds: ReadonlySet<number> = new Set([777, 888]);
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig({ allowedUserIdSet: configAllowedIds }));

      await main();

      expect(MockAfkModeController).toHaveBeenCalledOnce();
      // arg index 5 = AfkModeOptions; must contain the allowedUserIds from config
      const ctorOptions = MockAfkModeController.mock.calls[0][5] as { allowedUserIds?: ReadonlySet<number> };
      expect(ctorOptions).toMatchObject({ allowedUserIds: configAllowedIds });
    });

    it('omits allowedUserIds from AfkModeController options when allowedUserIdSet is undefined', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig({ allowedUserIdSet: undefined }));

      await main();

      expect(MockAfkModeController).toHaveBeenCalledOnce();
      const ctorOptions = MockAfkModeController.mock.calls[0][5] as Record<string, unknown>;
      expect(ctorOptions).not.toHaveProperty('allowedUserIds');
    });
  });
});
