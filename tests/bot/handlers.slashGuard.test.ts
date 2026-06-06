/**
 * registerHandlers — slash command guard behaviour (Phase 9 Item 2).
 *
 * Verifies that the channel.onMessage handler in src/bot/handlers.ts uses
 * isBotCommand() to distinguish bot commands from CLI pass-through commands:
 *
 *   - Bot commands (/new, /list, /help, …) → handler exits early. No relay.
 *   - CLI commands (/clear, /agent, /model, /unknowncommand, …) → isBotCommand()
 *     returns false → handler proceeds to relay.relay(ctx).
 *   - Plain text → always reaches relay (regression coverage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import type { ChannelPort, ChannelContext } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';
import { makeMockBot } from '../helpers/botMocks.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

const CHANNEL_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };
const NO_TOPIC_CTX: ChannelContext = { threadId: '', channelId: '-1001234567890' };

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

function getMessageHandler(channel: ChannelPort) {
  const calls = (channel.onMessage as ReturnType<typeof vi.fn>).mock.calls as [(ctx: ChannelContext, text: string) => Promise<void>][];
  return calls[0]?.[0];
}

describe('registerHandlers message:text — slash command guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('bot command /new in topic → message handler exits early, relay not triggered', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/new test-name');

    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('bot command /list in topic → message handler exits early', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/list');

    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('bot command /help in topic → message handler exits early', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/help');

    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('/clear in topic → relay triggered, placeholder reply sent', async () => {
    const session = makeMockSession(['/clear applied']);
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(session);
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/clear');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('/agent in topic → relay triggered', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['agent info']));
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/agent');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('/model in topic → relay triggered', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['model switched']));
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/model');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('/unknowncommand in topic → relay triggered (unknown = not a bot command = CLI)', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['ok']));
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/unknowncommand');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('/clear with args in topic → relay triggered', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['cleared']));
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, '/clear some args');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('plain text in topic → relay triggered (regression, unchanged)', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['Response from Copilot']));
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(CHANNEL_CTX, 'Build the parser');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
      '…',
    );
  });

  it('non-topic message → ignored (empty threadId, regression)', async () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getMessageHandler(channel)!;
    await handler(NO_TOPIC_CTX, '/clear');

    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
