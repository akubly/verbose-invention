import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { ChannelPort, ChannelContext, CommandHandler } from '../../src/channel/port.js';
import { makeMockFactory } from '../mocks/sdk.js';

function makeMockBot() {
  const bot = {
    command: vi.fn(),
    on: vi.fn(),
    catch: vi.fn(),
  };

  return { bot };
}

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

function makeResumeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry & { findByName: ReturnType<typeof vi.fn>; findAllByName: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  const nameMap = new Map(entries.map((e) => [e.sessionName, e]));

  const registry = {
    register: vi.fn(async (threadId: string, channelId: string, sessionName: string, model?: string) => {
      const entry: SessionEntry = {
        sessionName,
        threadId,
        channelId,
        createdAt: new Date().toISOString(),
        ...(model !== undefined && { model }),
      };
      map.set(threadId, entry);
      nameMap.set(sessionName, entry);
    }),
    resolve: vi.fn((threadId: string) => map.get(threadId)),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn(async (threadId: string) => {
      const entry = map.get(threadId);
      if (entry) {
        nameMap.delete(entry.sessionName);
        map.delete(threadId);
        return true;
      }
      return false;
    }),
    load: vi.fn(),
    upsert: vi.fn(),
    findByName: vi.fn((name: string) => nameMap.get(name)),
    findAllByName: vi.fn((name: string) => Array.from(map.values()).filter((e) => e.sessionName === name)),
    move: vi.fn(async (fromThreadId: string, toThreadId: string) => {
      const old = map.get(fromThreadId);
      if (old) {
        map.delete(fromThreadId);
        const newEntry: SessionEntry = {
          ...old,
          threadId: toThreadId,
        };
        map.set(toThreadId, newEntry);
        nameMap.set(old.sessionName, newEntry);
      }
    }),
  } as unknown as ISessionRegistry & { findByName: ReturnType<typeof vi.fn>; findAllByName: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> };

  return registry;
}

const CHANNEL_CTX: ChannelContext = { threadId: '10', channelId: '-1001234567890' };
const NO_TOPIC_CTX: ChannelContext = { threadId: '', channelId: '-1001234567890' };

const REMOTE_ENTRY: SessionEntry = {
  sessionName: 'my-session',
  threadId: '99',
  channelId: '-1001234567890',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const OTHER_ENTRY: SessionEntry = {
  sessionName: 'other-session',
  threadId: '99',
  channelId: '-1001234567890',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const LOCAL_ENTRY: SessionEntry = {
  sessionName: 'my-session',
  threadId: '10',
  channelId: '-1001234567890',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('/resume command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers a /resume command handler', () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    const channel = makeMockChannel();

    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const registeredCommands = (channel.onCommand as ReturnType<typeof vi.fn>).mock.calls.map(([cmd]: [string]) => cmd);
    expect(registeredCommands).toContain('resume');
  });

  it('replies with a usage hint when no session name is provided', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, '');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      CHANNEL_CTX,
      expect.stringMatching(/[Uu]sage|\/resume/),
    );
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('replies with a usage hint when match is undefined (no args)', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, '');

    expect(registry.register).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalled();
  });

  it('rejects when used outside a forum topic (no message_thread_id)', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(NO_TOPIC_CTX, 'my-session');

    expect(registry.register).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      NO_TOPIC_CTX,
      expect.stringMatching(/forum topic|[Uu]sage|\/resume/),
    );
  });

  it('errors when session name is not found in the registry', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'unknown-session');

    expect(registry.register).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      CHANNEL_CTX,
      expect.stringContaining('unknown-session'),
    );
  });

  it('lists available session names in the error when session not found', async () => {
    const existing: SessionEntry = {
      sessionName: 'available-one',
      threadId: '50',
      channelId: '-100',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([existing]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'no-such-session');

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toMatch(/\/list|available|session/i);
  });

  it('replies with "already bound here" when session is already linked to this topic', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([LOCAL_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText.toLowerCase()).toMatch(/already|bound|here/);
  });

  it('moves session from old topic to current topic via atomic move()', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.move).toHaveBeenCalledWith('99', '10');
    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('carries the existing model forward on move', async () => {
    const entryWithModel: SessionEntry = {
      ...REMOTE_ENTRY,
      model: 'claude-opus-4.5',
    };
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([entryWithModel]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.move).toHaveBeenCalledWith('99', '10');
  });

  it('confirms move with a success message mentioning the old topic ID', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toContain('my-session');
    expect(replyText).toContain('99');
  });

  it('rejects move when current topic is already linked to a different session', async () => {
    const currentTopicEntry: SessionEntry = {
      sessionName: 'other-session',
      threadId: '10',
      channelId: '-1001234567890',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([currentTopicEntry, REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toMatch(/already linked|\/remove/i);
    expect(replyText).toContain('other-session');
  });

  it('triggers registry persistence on a successful move (move is called once atomically)', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.move).toHaveBeenCalledTimes(1);
    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('/help text includes /resume', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'help')!;
    await handler(CHANNEL_CTX, '');

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toContain('/resume');
  });

  it('calls relay.rekeySession(oldThreadId, newThreadId) after a successful move', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    const relay = registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const rekeySpy = vi.spyOn(relay, 'rekeySession');

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(rekeySpy).toHaveBeenCalledWith('99', '10');
  });

  it('does not call relay.rekeySession when move() throws', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    registry.move.mockRejectedValueOnce(new Error('Destination topic 10 is already bound to "other"'));
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    const relay = registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const rekeySpy = vi.spyOn(relay, 'rekeySession');

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(rekeySpy).not.toHaveBeenCalled();
  });

  it('refuses with disambiguation list when legacy duplicates share the same name', async () => {
    const dup1: SessionEntry = { sessionName: 'my-session', threadId: '42', channelId: '-100', createdAt: '2026-01-01T00:00:00.000Z' };
    const dup2: SessionEntry = { sessionName: 'my-session', threadId: '99', channelId: '-100', createdAt: '2026-01-01T00:00:00.000Z' };

    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([dup1, dup2]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    expect(registry.move).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toMatch(/[Mm]ultiple|duplicate/i);
    expect(replyText).toContain('my-session');
    expect(replyText).toContain('42');
    expect(replyText).toContain('99');
  });

  it('mentions /remove (not /rename) in the legacy-duplicates refusal', async () => {
    const dup1: SessionEntry = { sessionName: 'my-session', threadId: '42', channelId: '-100', createdAt: '2026-01-01T00:00:00.000Z' };
    const dup2: SessionEntry = { sessionName: 'my-session', threadId: '99', channelId: '-100', createdAt: '2026-01-01T00:00:00.000Z' };

    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([dup1, dup2]);
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).toContain('/remove');
    expect(replyText).not.toContain('/rename');
  });

  it('surfaces the move() destination-bound error with a clean ⚠️ message, not a generic failure', async () => {
    const { bot } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    registry.move.mockRejectedValueOnce(
      new Error('Destination topic 10 is already bound to "other-session"'),
    );
    const factory = makeMockFactory();
    const channel = makeMockChannel();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const handler = getChannelHandler(channel, 'resume')!;
    await handler(CHANNEL_CTX, 'my-session');

    const replyText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(replyText).not.toMatch(/[Ff]ailed to resume/);
    expect(replyText).toMatch(/already|linked|bound/i);
    expect(replyText).toMatch(/[Rr]emove|\/remove/);
  });
});
