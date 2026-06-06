/**
 * /cwd command group tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import type { ChannelPort, ChannelContext, CommandHandler } from '../../src/channel/port.js';
import { makeMockFactory } from '../mocks/sdk.js';
import { makeMockBot } from '../helpers/botMocks.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

const {
  mockLoadConfig,
  mockSaveConfig,
  mockValidateAlias,
  mockValidatePath,
  mockAddKnownCwd,
  mockRemoveKnownCwd,
  mockListKnownCwds,
  mockGetKnownCwdByAlias,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
  mockValidateAlias: vi.fn(),
  mockValidatePath: vi.fn(),
  mockAddKnownCwd: vi.fn(),
  mockRemoveKnownCwd: vi.fn(),
  mockListKnownCwds: vi.fn(),
  mockGetKnownCwdByAlias: vi.fn(),
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
    validateAlias: (...args: unknown[]) => mockValidateAlias(...args),
    validatePath: (...args: unknown[]) => mockValidatePath(...args),
    addKnownCwd: (...args: unknown[]) => mockAddKnownCwd(...args),
    removeKnownCwd: (...args: unknown[]) => mockRemoveKnownCwd(...args),
    listKnownCwds: (...args: unknown[]) => mockListKnownCwds(...args),
    getKnownCwdByAlias: (...args: unknown[]) => mockGetKnownCwdByAlias(...args),
  };
});

function makeMockChannel(): ChannelPort {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: '100' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
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
const ALIAS = 'myrepo';
const CWD_PATH = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo';
const NOW = '2024-06-01T00:00:00.000Z';
const GENERAL_CTX: ChannelContext = { threadId: '', channelId: '-1001234567890' };
const TOPIC_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };

function makeKnownEntry(alias = ALIAS, path = CWD_PATH) {
  return { alias, path, addedAt: NOW };
}

describe('/cwd command group', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
    vi.clearAllMocks();

    mockLoadConfig.mockResolvedValue({});
    mockSaveConfig.mockResolvedValue(undefined);
    mockValidateAlias.mockReturnValue({ ok: true });
    mockValidatePath.mockResolvedValue({ ok: true, normalized: CWD_PATH });
    mockAddKnownCwd.mockImplementation((cfg: any, alias: string, path: string, now: string) => ({
      ...cfg,
      knownCwds: [...(cfg.knownCwds ?? []), { alias, path, addedAt: now }],
    }));
    mockRemoveKnownCwd.mockImplementation((cfg: any, alias: string) => ({
      ...cfg,
      knownCwds: (cfg.knownCwds ?? []).filter((c: any) => c.alias !== alias),
    }));
    mockListKnownCwds.mockReturnValue([]);
    mockGetKnownCwdByAlias.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('/cwd list — empty registry → replies with empty-state message', async () => {
    mockListKnownCwds.mockReturnValue([]);
    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    expect(channel.sendMessage).toHaveBeenCalledOnce();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText.toLowerCase()).toMatch(/no known|no cwd|empty/);
  });

  it('/cwd list — populated registry → reply contains alias and path for each entry', async () => {
    const entries = [
      makeKnownEntry('repo-a', CWD_PATH),
      makeKnownEntry('repo-b', CWD_PATH.replace('myrepo', 'other')),
    ];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    expect(channel.sendMessage).toHaveBeenCalledOnce();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toContain('repo-a');
    expect(replyText).toContain('repo-b');
  });

  it('/cwd bare (empty args) → defaults to list behaviour', async () => {
    mockListKnownCwds.mockReturnValue([]);
    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, '');

    expect(channel.sendMessage).toHaveBeenCalledOnce();
  });

  it('/cwd add <alias> <path> happy path → validates, persists, replies success', async () => {
    const newConfig = { knownCwds: [makeKnownEntry()] };
    mockAddKnownCwd.mockReturnValue(newConfig);

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `add ${ALIAS} ${CWD_PATH}`);

    expect(mockValidateAlias).toHaveBeenCalledWith(ALIAS);
    expect(mockValidatePath).toHaveBeenCalledWith(CWD_PATH);
    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, newConfig);
    expect(channel.sendMessage).toHaveBeenCalledOnce();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/✅|added|success/i);
  });

  it('/cwd add — invalid alias → friendly error, saveConfig NOT called', async () => {
    mockValidateAlias.mockReturnValue({ ok: false, reason: 'starts with hyphen' });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `add -bad ${CWD_PATH}`);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|error|invalid/i);
  });

  it('/cwd add — invalid path → friendly error, saveConfig NOT called', async () => {
    mockValidatePath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `add ${ALIAS} ${CWD_PATH}`);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|error|not exist/i);
  });

  it('/cwd add — alias collision → friendly error, saveConfig NOT called', async () => {
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    mockAddKnownCwd.mockImplementation(() => {
      throw new Error(`Alias "${ALIAS}" already exists in knownCwds`);
    });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `add ${ALIAS} ${CWD_PATH}`);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toMatch(/❌|error|already|collision/i);
  });

  it('/cwd remove <alias> — alias exists → removes, persists, replies success', async () => {
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    const newConfig = { knownCwds: [] };
    mockRemoveKnownCwd.mockReturnValue(newConfig);

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `remove ${ALIAS}`);

    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, newConfig);
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/✅|removed|success/i);
  });

  it('/cwd remove <alias> — alias missing → friendly "not found" error, saveConfig NOT called', async () => {
    mockLoadConfig.mockResolvedValue({ knownCwds: [] });
    mockGetKnownCwdByAlias.mockReturnValue(undefined);

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `remove ${ALIAS}`);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/❌|not found|unknown/i);
  });

  it('/cwd unknownsub → usage reply, no state change', async () => {
    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'unknownsub');

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledOnce();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toMatch(/usage|list|add|remove|❌/i);
  });

  it('general-topic-only: /cwd in a session topic → friendly refusal, no state change', async () => {
    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(TOPIC_CTX, 'list');

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledOnce();
    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toMatch(/general|topic|❌/i);
  });

  it('relativeTime: invalid timestamp string → reply contains "unknown", never "NaN"', async () => {
    const entries = [{ alias: 'bad', path: CWD_PATH, addedAt: NOW, lastUsedAt: 'not-a-date' }];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).not.toMatch(/NaN/);
    expect(replyText).toContain('unknown');
  });

  it('relativeTime: future timestamp (clock skew +60s) → reply contains "just now", not negative', async () => {
    const futureIso = new Date(new Date(NOW).getTime() + 60_000).toISOString();
    const entries = [{ alias: 'future', path: CWD_PATH, addedAt: NOW, lastUsedAt: futureIso }];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).not.toMatch(/-\d/);
    expect(replyText).toContain('just now');
  });

  it('relativeTime: exactly now → "just now"', async () => {
    const entries = [{ alias: 'fresh', path: CWD_PATH, addedAt: NOW, lastUsedAt: NOW }];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toContain('just now');
  });

  it('relativeTime: 2 days ago → "2d ago" (regression guard)', async () => {
    const twoDaysAgo = new Date(new Date(NOW).getTime() - 2 * 24 * 60 * 60_000).toISOString();
    const entries = [{ alias: 'old', path: CWD_PATH, addedAt: twoDaysAgo, lastUsedAt: twoDaysAgo }];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, 'list');

    const replyText: string = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(replyText).toContain('2d ago');
  });

  it('removing alias for an active session cwd — succeeds; session itself is unaffected', async () => {
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    mockRemoveKnownCwd.mockReturnValue({ knownCwds: [] });

    const sessionEntry: SessionEntry = {
      sessionName: 'active-session',
      threadId: '99',
      channelId: '-1001234567890',
      createdAt: NOW,
      cwd: CWD_PATH,
    };
    const { bot } = makeMockBot();
    const channel = makeMockChannel();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry([sessionEntry]),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
      channel,
    } as any);

    const handler = getChannelHandler(channel, 'cwd')!;
    await handler(GENERAL_CTX, `remove ${ALIAS}`);

    expect(mockSaveConfig).toHaveBeenCalledOnce();
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/✅|removed|success/i);
  });
});
