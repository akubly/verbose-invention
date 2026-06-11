/**
 * /new --cwd flag tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { ChannelPort, ChannelContext, CommandHandler } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';
import { makeMockBot } from '../helpers/botMocks.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

const {
  mockLoadConfig,
  mockSaveConfig,
  mockValidatePath,
  mockGetKnownCwdByAlias,
  mockTouchKnownCwd,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
  mockValidatePath: vi.fn(),
  mockGetKnownCwdByAlias: vi.fn(),
  mockTouchKnownCwd: vi.fn(),
}));

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/config.js')>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  };
});

vi.mock('../../src/config/knownCwds.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/knownCwds.js')>();
  return {
    ...actual,
    validatePath: (...args: unknown[]) => mockValidatePath(...args),
    getKnownCwdByAlias: (...args: unknown[]) => mockGetKnownCwdByAlias(...args),
    touchKnownCwd: (...args: unknown[]) => mockTouchKnownCwd(...args),
  };
});

function makeMockChannel(): ChannelPort {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: '100' }),
    editMessage: vi.fn().mockResolvedValue(true),
    splitMessage: vi.fn((text: string) => [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn(),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn().mockResolvedValue('approve'),
    capabilities: {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    },
  } as unknown as ChannelPort;
}

function getChannelHandler(channel: ChannelPort, command: string): CommandHandler | undefined {
  const calls = (channel.onCommand as ReturnType<typeof vi.fn>).mock.calls as [string, CommandHandler][];
  return calls.find(([cmd]) => cmd === command)?.[1];
}

const TEST_CONFIG_PATH = 'D:\\test\\reach\\config.json';
const SESSION_NAME = 'my-project';
const ALIAS = 'myrepo';
const ABS_PATH = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo';
const NOW = '2024-06-01T00:00:00.000Z';
const CHANNEL_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };

describe('/new --cwd flag', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
    vi.clearAllMocks();

    mockLoadConfig.mockResolvedValue({});
    mockSaveConfig.mockResolvedValue(undefined);
    mockValidatePath.mockResolvedValue({ ok: true, normalized: ABS_PATH });
    mockGetKnownCwdByAlias.mockReturnValue(undefined);
    mockTouchKnownCwd.mockImplementation((cfg: unknown) => cfg);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('/new <name> (no --cwd) → session registered with default cwd, no config load', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, SESSION_NAME);

    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[2]).toBe(SESSION_NAME);
    expect(callArgs[4]).toBeUndefined();
    expect(mockGetKnownCwdByAlias).not.toHaveBeenCalled();
    expect(mockValidatePath).not.toHaveBeenCalled();
  });

  it('/new <name> --cwd <abs-path> → path branch: validatePath called, resolved cwd passed to register', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd ${ABS_PATH}`);

    expect(mockValidatePath).toHaveBeenCalledWith(ABS_PATH);
    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new --cwd with invalid path → validatePath rejects → friendly error, no register', async () => {
    mockValidatePath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd ${ABS_PATH}`);

    expect(registry.register).not.toHaveBeenCalled();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|error|not exist/i);
  });

  it.skipIf(process.platform !== 'win32')(
    '/new --cwd UNC path (\\server\\share) → path branch → validatePath rejects UNC → friendly error',
    async () => {
      mockValidatePath.mockResolvedValue({
        ok: false,
        reason: 'UNC network paths are not supported',
      });

      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const channel = makeMockChannel();
      registerHandlers({
        bot: bot as any,
        registry,
        factory: makeMockFactory(),
        globalModel: 'test-model',
        configPath: TEST_CONFIG_PATH,
        channel,
      } as any);

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd \\server\share`);

      expect(registry.register).not.toHaveBeenCalled();
      expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|UNC|error/i);
    },
  );

  it('/new <name> --cwd <alias> hit → resolves path, touches lastUsedAt, register with resolved path', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    const configWithAlias = { knownCwds: [entry] };
    const touchedConfig = { knownCwds: [{ ...entry, lastUsedAt: NOW }] };

    mockLoadConfig.mockResolvedValue(configWithAlias);
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue(touchedConfig);

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd ${ALIAS}`);

    expect(mockGetKnownCwdByAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
    expect(mockTouchKnownCwd).toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, touchedConfig);
    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new <name> --cwd <unknown-alias> → alias miss → friendly error, no register', async () => {
    mockLoadConfig.mockResolvedValue({});
    mockGetKnownCwdByAlias.mockReturnValue(undefined);

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd unknown-alias`);

    expect(registry.register).not.toHaveBeenCalled();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toMatch(/❌|unknown|not found|alias/i);
  });

  it('/new <name> --cwd (no value) → usage reply, no register', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd`);

    expect(registry.register).not.toHaveBeenCalled();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|usage|cwd/i);
  });

  it('/new <name> --cwd <alias> --model <model> → both flags honored', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    mockLoadConfig.mockResolvedValue({ knownCwds: [entry] });
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue({ knownCwds: [{ ...entry, lastUsedAt: NOW }] });

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd ${ALIAS} --model claude-sonnet`);

    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('claude-sonnet');
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new <name> --model <model> --cwd <alias> → flags in reverse order also work', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    mockLoadConfig.mockResolvedValue({ knownCwds: [entry] });
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue({ knownCwds: [{ ...entry, lastUsedAt: NOW }] });

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --model claude-sonnet --cwd ${ALIAS}`);

    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('claude-sonnet');
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new --cwd myrepoxyz (non-alias, non-absolute) → alias lookup miss → friendly error', async () => {
    mockGetKnownCwdByAlias.mockReturnValue(undefined);

    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd myrepoxyz`);

    expect(registry.register).not.toHaveBeenCalled();
  });

  it('/new <name> --cwd <path> success → reply includes session name and success indicator', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(makeMockSession(['ok'])),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'new')!;
    await handler(CHANNEL_CTX, `${SESSION_NAME} --cwd ${ABS_PATH}`);

    expect(registry.register).toHaveBeenCalledOnce();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(replyText).toMatch(/✅|registered|success/i);
    expect(replyText).toContain(SESSION_NAME);
  });
});
