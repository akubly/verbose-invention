import { vi } from 'vitest';
import { AfkModeController, type TopicBinding } from '../../src/bot/afkMode.js';
import type { ModeState } from '../../src/bridge/protocol.js';
import type { FakeDaemon } from './FakeDaemon.js';
import type { FakeExtensionClient } from './FakeExtensionClient.js';

export const ADR11_TIMESTAMP = '2026-05-24T23:19:14-07:00';
export const CHAT_ID = -1001234567890;
/** Fixed user ID used in contract tests when allowedUserIds is configured. */
export const TEST_TELEGRAM_USER_ID = 11111;

export interface AfkSessionFixture {
  sessionId: string;
  sessionName: string;
  cwd: string;
  topicId?: number;
  chatId?: number;
  createdAt?: string;
  mode?: 'afk' | 'back';
  afkSince?: string;
  lastTopicId?: number;
}

export function makeSessionEntry(overrides: Partial<AfkSessionFixture> = {}): AfkSessionFixture {
  return {
    sessionId: 'sess-1',
    sessionName: 'reach-myapp',
    cwd: 'D:\\git\\verbose-invention',
    chatId: CHAT_ID,
    createdAt: ADR11_TIMESTAMP,
    ...overrides,
  };
}

export class MemoryAfkRegistry {
  private readonly bySessionId = new Map<string, AfkSessionFixture>();
  readonly writes: AfkSessionFixture[] = [];

  constructor(entries: AfkSessionFixture[] = []) {
    for (const entry of entries) this.upsertSync(entry);
  }

  upsertSync(entry: AfkSessionFixture): void {
    const next = { ...entry };
    this.bySessionId.set(next.sessionId, next);
    this.writes.push(next);
  }

  findBySessionId(sessionId: string): AfkSessionFixture | undefined {
    return this.bySessionId.get(sessionId);
  }

  findByName(sessionName: string): AfkSessionFixture | undefined {
    return Array.from(this.bySessionId.values()).find((entry) => entry.sessionName === sessionName);
  }

  async upsert(entry: AfkSessionFixture): Promise<void> {
    const prior = this.findByName(entry.sessionName);
    this.upsertSync({ ...prior, ...entry, sessionId: entry.sessionId ?? prior?.sessionId ?? entry.sessionName });
  }

  findByTopicId(topicId: number): AfkSessionFixture | undefined {
    return Array.from(this.bySessionId.values()).find(
      (entry) => entry.topicId === topicId || entry.lastTopicId === topicId,
    );
  }

  setAfk(sessionId: string, topicId: number): void {
    const current = this.bySessionId.get(sessionId) ?? makeSessionEntry({ sessionId });
    this.upsertSync({
      ...current,
      topicId,
      lastTopicId: topicId,
      mode: 'afk',
      afkSince: ADR11_TIMESTAMP,
    });
  }

  setBack(sessionId: string): void {
    const current = this.bySessionId.get(sessionId) ?? makeSessionEntry({ sessionId });
    this.upsertSync({ ...current, mode: 'back', afkSince: undefined });
  }

  list(): AfkSessionFixture[] {
    return Array.from(this.bySessionId.values());
  }
}

export class RelayTargetSpy {
  readonly calls: Array<{ sessionId: string; target: 'cli' | 'telegram'; topicId?: number; text?: string }> = [];

  targetTelegram(sessionId: string, topicId: number, text?: string): void {
    this.calls.push({ sessionId, target: 'telegram', topicId, text });
  }

  targetCli(sessionId: string, text?: string): void {
    this.calls.push({ sessionId, target: 'cli', text });
  }

  lastTarget(sessionId: string): 'cli' | 'telegram' | undefined {
    return this.calls.filter((call) => call.sessionId === sessionId).at(-1)?.target;
  }

  topicTargets(sessionId: string): number[] {
    return this.calls
      .filter((call) => call.sessionId === sessionId && call.target === 'telegram' && call.topicId !== undefined)
      .map((call) => call.topicId!);
  }
}

export function makeMockTelegramBot() {
  const order: string[] = [];
  const createdTopicIds: number[] = [];
  let nextTopicId = 9001;

  const record = <T extends unknown[]>(name: string, value: unknown) => vi.fn(async (...args: T) => {
    order.push(name);
    return typeof value === 'function' ? (value as (...inner: T) => unknown)(...args) : value;
  });

  const createForumTopic = record<[number, string]>('createForumTopic', () => {
    const topicId = nextTopicId++;
    createdTopicIds.push(topicId);
    return { message_thread_id: topicId };
  });
  const reopenForumTopic = record<[number, number]>('reopenForumTopic', true);
  const closeForumTopic = record<[number, number]>('closeForumTopic', true);
  const pinChatMessage = record<[number, number]>('pinChatMessage', true);
  const editMessageText = record<[number, number, string, Record<string, unknown>?]>('editMessageText', true);
  const sendMessage = record<[number, string, Record<string, unknown>?]>('sendMessage', (_chatId, text, options) => ({
    message_id: order.length + 100,
    chat: { id: CHAT_ID, type: 'supergroup' },
    text,
    message_thread_id: options?.message_thread_id,
  }));

  return {
    api: { createForumTopic, reopenForumTopic, closeForumTopic, pinChatMessage, editMessageText, sendMessage },
    order,
    createdTopicIds,
  };
}

export interface AfkContractDeps {
  daemon: FakeDaemon;
  clients: FakeExtensionClient[];
  telegram: ReturnType<typeof makeMockTelegramBot>;
  registry: MemoryAfkRegistry;
  relayTargets: RelayTargetSpy;
  chatId: number;
  now: () => string;
  showCliMessage: ReturnType<typeof vi.fn>;
}

export interface AfkContractDriver {
  handleAfkRequest(sessionId: string): Promise<void>;
  handleBackRequest(sessionId: string): Promise<void>;
  handleTelegramMessage(topicId: number, text: string): Promise<void>;
  handleCliStream?(sessionId: string, text: string): Promise<void>;
  getMode?(): ModeState;
}

export function loadAfkContractDriver(deps: AfkContractDeps): AfkContractDriver {
  return createBotAfkDriver(AfkModeController, deps);
}

function createBotAfkDriver(Ctor: unknown, deps: AfkContractDeps): AfkContractDriver {
  const bridge = makeBridgeAdapter(deps);
  const controller = new (Ctor as new (...args: unknown[]) => unknown)(
    deps.telegram,
    bridge,
    deps.registry,
    deps.chatId,
    async () => undefined,
    { allowedUserIds: new Set([TEST_TELEGRAM_USER_ID]) },
  ) as Record<string, unknown>;

  return {
    async handleAfkRequest(sessionId: string): Promise<void> {
      if (!deps.clients.some((client) => client.sessionId === sessionId)) {
        deps.showCliMessage(sessionId, '⚠ Reach daemon not running — start it first.');
        return;
      }
      bridge.emit('afk.request', sessionId);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async handleBackRequest(sessionId: string): Promise<void> {
      seedActiveState(controller, deps.registry);
      bridge.emit('back.request', sessionId);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async handleTelegramMessage(topicId: number, text: string): Promise<void> {
      seedActiveState(controller, deps.registry);
      await (controller.handleTelegramMessage as (ctx: unknown) => Promise<boolean>).call(
        controller,
        makeTelegramCtx(topicId, text),
      );
    },
    getMode(): ModeState {
      return (controller.getMode as () => ModeState).call(controller);
    },
  };
}

function makeBridgeAdapter(deps: AfkContractDeps) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const sessionInfo = () => deps.clients.map((client) => {
    const entry = deps.registry.findBySessionId(client.sessionId) ?? deps.registry.findByName(client.sessionName);
    return {
      sessionId: client.sessionId,
      sessionName: client.sessionName,
      cwd: entry?.cwd ?? 'D:\\git\\verbose-invention',
    };
  });

  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listSessions() {
      return sessionInfo();
    },
    getSessionInfo(sessionId: string) {
      return sessionInfo().find((session) => session.sessionId === sessionId);
    },
    setRegistrationAugmenter(_augmenter: unknown) {
      return undefined;
    },
    sendToSession(sessionId: string, msg: { type: string; topicId?: number; text?: string }) {
      deps.daemon.sendTo(sessionId, msg as never);
      if (msg.type === 'afk.activated' && msg.topicId !== undefined) {
        deps.relayTargets.targetTelegram(sessionId, msg.topicId);
      }
      if (msg.type === 'back.confirmed') deps.relayTargets.targetCli(sessionId);
      if (msg.type === 'mirror.input') deps.relayTargets.targetCli(sessionId, msg.text);
    },
    broadcastToSessions(msg: { type: string }) {
      for (const client of deps.clients) deps.daemon.sendTo(client.sessionId, msg as never);
    },
  };
}

function seedActiveState(controller: Record<string, unknown>, registry: MemoryAfkRegistry): void {
  const activeEntries = registry.list().filter((entry) => entry.mode === 'afk' && entry.lastTopicId !== undefined);
  if (activeEntries.length === 0) return;

  const mode = { active: true, since: activeEntries[0]?.afkSince ?? ADR11_TIMESTAMP };
  const sessionTopics = new Map<string, TopicBinding>();
  const topicSessions = new Map<number, string>();
  for (const entry of activeEntries) {
    const topicId = entry.topicId ?? entry.lastTopicId!;
    sessionTopics.set(entry.sessionId, {
      sessionId: entry.sessionId,
      sessionName: entry.sessionName,
      cwd: entry.cwd,
      topicId,
      topicUrl: `https://t.me/c/test/${topicId}`,
    });
    topicSessions.set(topicId, entry.sessionId);
  }
  (controller as unknown as AfkModeController).restoreSnapshot({ mode, sessionTopics, topicSessions });
}

function makeTelegramCtx(topicId: number, text: string) {
  return {
    message: { message_thread_id: topicId, text },
    chat: { id: CHAT_ID },
    from: { id: TEST_TELEGRAM_USER_ID },
  };
}
