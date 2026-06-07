/**
 * A8 + N3 — Composition root integration harness for main().
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { EnvConfig } from '../../src/config/env.js';

const {
  mockBotStop,
  mockBridgeStart,
  mockBridgeStop,
  mockRegistryLoad,
  MockAfkModeController,
  mockRegisterHandlers,
  mockGeneratePipeAuth,
  mockCleanupPipeAuth,
  mockChannelStart,
  mockChannelStop,
  mockSetMessageInterceptor,
  mockTelegramBot,
  MockTelegramChannelClass,
} = vi.hoisted(() => {
  const mockBotStop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockBridgeStart = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockBridgeStop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockRegistryLoad = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const MockAfkModeController = vi.fn().mockImplementation(() => ({}));
  const mockRelayDispose = vi.fn();
  const mockRegisterHandlers = vi.fn().mockReturnValue({ dispose: mockRelayDispose });
  const mockGeneratePipeAuth = vi.fn().mockResolvedValue({
    pipeName: 'reach-bridge-test',
    pipePath: '\\.\pipe\reach-bridge-test',
    token: 'aabbcc',
  });
  const mockCleanupPipeAuth = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockChannelStart = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockChannelStop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const mockSetMessageInterceptor = vi.fn();
  const mockTelegramBot = { stop: mockBotStop };

  // A concrete class so `channel instanceof TelegramChannel` is true in main().
  class MockTelegramChannelClass {
    bot = mockTelegramBot;
    start = mockChannelStart;
    stop = mockChannelStop;
    setMessageInterceptor = mockSetMessageInterceptor;
    sendMessage = vi.fn().mockResolvedValue({ id: 'msg-1' });
    editMessage = vi.fn().mockResolvedValue(true);
    splitMessage = vi.fn((text: string) => [text]);
    formatForTransport = vi.fn((text: string) => text);
    createThread = vi.fn();
    onMessage = vi.fn();
    onCommand = vi.fn();
    promptUser = vi.fn().mockResolvedValue('approve');
    name = 'telegram';
    capabilities = {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    };
  }

  return {
    mockBotStop,
    mockBridgeStart,
    mockBridgeStop,
    mockRegistryLoad,
    MockAfkModeController,
    mockRegisterHandlers,
    mockGeneratePipeAuth,
    mockCleanupPipeAuth,
    mockChannelStart,
    mockChannelStop,
    mockSetMessageInterceptor,
    mockTelegramBot,
    MockTelegramChannelClass,
  };
});

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/channel/telegram/index.js', () => ({ TelegramChannel: MockTelegramChannelClass }));
vi.mock('../../src/channel/registry.js', () => ({
  createChannel: vi.fn().mockImplementation(() => new MockTelegramChannelClass()),
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

import { main } from '../../src/main.js';
import { createChannel } from '../../src/channel/registry.js';
import { parseEnv } from '../../src/config/env.js';
import { runPairingMode } from '../../src/bot/pairing.js';
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { CopilotClientImpl } from '../../src/copilot/impl.js';
import { BridgeSessionFactory } from '../../src/bridge/bridgeSessionFactory.js';
import { CompositeSessionFactory } from '../../src/bridge/compositeSessionFactory.js';

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

describe('Integration: main() composition root (A8 + N3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBotStop.mockResolvedValue(undefined);
    mockBridgeStart.mockResolvedValue(undefined);
    mockBridgeStop.mockResolvedValue(undefined);
    mockRegistryLoad.mockResolvedValue(undefined);
    mockGeneratePipeAuth.mockResolvedValue({
      pipeName: 'reach-bridge-test',
      pipePath: '\\.\pipe\reach-bridge-test',
      token: 'aabbcc',
    });
    mockCleanupPipeAuth.mockResolvedValue(undefined);
    mockChannelStart.mockResolvedValue(undefined);
    mockChannelStop.mockResolvedValue(undefined);
    MockAfkModeController.mockImplementation(() => ({}));
    mockRegisterHandlers.mockReturnValue({ dispose: vi.fn() });
    vi.mocked(ExtensionBridge).mockImplementation(() => ({
      start: mockBridgeStart,
      stop: mockBridgeStop,
    }));
    vi.mocked(createChannel).mockImplementation(() => new MockTelegramChannelClass() as any);
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

  describe('A8a — pairing-mode early-return path', () => {
    it('calls runPairingMode() and returns without starting the channel', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makePairingConfig());

      await main();

      expect(runPairingMode).toHaveBeenCalledOnce();
      expect(mockChannelStart).not.toHaveBeenCalled();
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

  describe('A8b — config-file env resolution (normal mode)', () => {
    it('wires all dependencies and starts the channel when bridge is available', async () => {
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig());

      await main();

      expect(SessionRegistry).toHaveBeenCalledOnce();
      expect(ExtensionBridge).toHaveBeenCalledOnce();
      expect(mockBridgeStart).toHaveBeenCalledOnce();
      expect(CopilotClientImpl).toHaveBeenCalledOnce();
      expect(mockRegistryLoad).toHaveBeenCalledOnce();
      expect(mockRegisterHandlers).toHaveBeenCalledOnce();
      expect(mockSetMessageInterceptor).toHaveBeenCalledOnce();
      expect(mockChannelStart).toHaveBeenCalledOnce();
    });

    it('falls back to sdk-only factory and skips AfkModeController when bridge is unavailable', async () => {
      mockGeneratePipeAuth.mockRejectedValueOnce(new Error('named pipe unavailable'));
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig());

      await main();

      expect(mockChannelStart).toHaveBeenCalledOnce();
      expect(MockAfkModeController).not.toHaveBeenCalled();
      expect(mockSetMessageInterceptor).not.toHaveBeenCalled();
    });
  });

  describe('N3 — config-file allowedUserIdSet wired through main()', () => {
    it('passes config-file allowedUserIdSet to AfkModeController options (bridge available)', async () => {
      const configAllowedIds: ReadonlySet<number> = new Set([777, 888]);
      vi.mocked(parseEnv).mockResolvedValue(makeNormalConfig({ allowedUserIdSet: configAllowedIds }));

      await main();

      expect(MockAfkModeController).toHaveBeenCalledOnce();
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
