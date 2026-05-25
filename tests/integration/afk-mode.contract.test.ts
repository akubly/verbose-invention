/**
 * ADR-11 /afk → Topic Open/Resume → /back contract tests.
 *
 * Validates ADR-11 §§2, 4, 5, 6, 7, 8, and 10:
 * - machine-wide AFK mode entered from CLI-side afk.request
 * - topic create/resume lifecycle and session registry reflection
 * - Telegram→CLI mirror.input while backgrounded
 * - CLI-only /back semantics, local resume banner, topic close
 * - immediate daemon-unreachable and invalid-state failures
 *
 * T4 protocol clarification: ADR-11 §2 says /back is CLI-only and is never
 * honored from Telegram. The T4 audit case is therefore intentionally rewritten
 * as a negative test: Telegram topic text "/back" must not produce
 * back.confirmed, mode transition, topic close, or relay re-targeting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDaemon } from '../helpers/FakeDaemon.js';
import { FakeExtensionClient } from '../helpers/FakeExtensionClient.js';
import {
  ADR11_TIMESTAMP,
  CHAT_ID,
  MemoryAfkRegistry,
  RelayTargetSpy,
  loadAfkContractDriver,
  makeMockTelegramBot,
  makeSessionEntry,
  type AfkContractDriver,
} from '../helpers/afkContract.js';

async function flush(): Promise<void> {
  // Readline emits lines through setImmediate; the extra microtask drains async mock continuations.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function makeHarness(entries = [makeSessionEntry()]) {
  const daemon = new FakeDaemon();
  const client = new FakeExtensionClient('sess-1', 'reach-myapp');
  client.connect(daemon);
  client.sendHello();
  await flush();

  const telegram = makeMockTelegramBot();
  const registry = new MemoryAfkRegistry(entries);
  const relayTargets = new RelayTargetSpy();
  const showCliMessage = vi.fn();
  const driver = await loadAfkContractDriver({
    daemon,
    clients: [client],
    telegram,
    registry,
    relayTargets,
    chatId: CHAT_ID,
    now: () => ADR11_TIMESTAMP,
    showCliMessage,
  });

  return { daemon, client, telegram, registry, relayTargets, showCliMessage, driver };
}

async function activate(driver: AfkContractDriver, client: FakeExtensionClient, sessionId = 'sess-1') {
  client.sendAfkRequest();
  await flush();
  await driver.handleAfkRequest(sessionId);
  await flush();
}

describe('ADR-11 AFK mode contract', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date(ADR11_TIMESTAMP));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('T1 — CLI /afk creates a Telegram topic, records it, and activates the CLI session', async () => {
    const { daemon, client, telegram, registry, relayTargets, driver } = await makeHarness();

    await activate(driver, client);

    expect(daemon.expectAfkRequest('sess-1')).toMatchObject({ type: 'afk.request', sessionId: 'sess-1' });
    expect(telegram.api.createForumTopic).toHaveBeenCalledOnce();
    expect(telegram.api.createForumTopic).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('reach-myapp'),
    );

    const topicId = telegram.createdTopicIds[0]!;
    expect(registry.findBySessionId('sess-1')).toMatchObject({
      sessionId: 'sess-1',
      mode: 'afk',
      lastTopicId: topicId,
      topicId,
    });
    expect(client.expectAfkActivated(topicId)).toMatchObject({ topicId, topicUrl: expect.any(String) });
    expect(client.expectModeChanged(true)).toMatchObject({ active: true, since: expect.any(String) });
    expect(telegram.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/AFK|Telegram|reach-myapp|sess-1/i),
      expect.objectContaining({ message_thread_id: topicId }),
    );
    expect(relayTargets.lastTarget('sess-1')).toBe('telegram');
  });

  it('T2 — idempotent /afk resumes an existing topic without creating a duplicate', async () => {
    const existingTopicId = 4242;
    const { client, telegram, registry, relayTargets, driver } = await makeHarness([
      makeSessionEntry({ lastTopicId: existingTopicId, topicId: existingTopicId, mode: 'back' }),
    ]);

    await activate(driver, client);

    expect(telegram.api.createForumTopic).not.toHaveBeenCalled();
    expect(telegram.api.reopenForumTopic).toHaveBeenCalledWith(CHAT_ID, existingTopicId);
    expect(client.expectAfkActivated(existingTopicId)).toMatchObject({ topicId: existingTopicId });
    expect(registry.findBySessionId('sess-1')).toMatchObject({
      mode: 'afk',
      topicId: existingTopicId,
      lastTopicId: existingTopicId,
    });
    expect(relayTargets.topicTargets('sess-1')).toEqual([existingTopicId]);
  });

  it('T3 — Telegram message in AFK topic is mirrored to the CLI without inject or timeout fallback', async () => {
    const topicId = 5151;
    const { client, daemon, relayTargets, driver } = await makeHarness([
      makeSessionEntry({ topicId, lastTopicId: topicId, mode: 'afk', afkSince: ADR11_TIMESTAMP }),
    ]);

    await driver.handleTelegramMessage(topicId, 'check the build logs');
    await flush();

    expect(client.expectMirrorInput('sess-1', 'check the build logs')).toMatchObject({
      source: 'telegram',
      topicId,
    });
    expect(client.receivedOfType('inject')).toHaveLength(0);
    expect(daemon.messagesOfType('stream.error')).toHaveLength(0);
    expect(relayTargets.lastTarget('sess-1')).toBe('cli');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T4 — Telegram /back is ignored because ADR-11 §2 makes /back CLI-only', async () => {
    const topicId = 6262;
    const { client, telegram, relayTargets, driver } = await makeHarness([
      makeSessionEntry({ topicId, lastTopicId: topicId, mode: 'afk', afkSince: ADR11_TIMESTAMP }),
    ]);
    // Prime baseline: relay was already targeting Telegram before the ignored Telegram /back.
    relayTargets.targetTelegram('sess-1', topicId);

    await driver.handleTelegramMessage(topicId, '/back');
    await flush();

    expect(client.receivedOfType('back.confirmed')).toHaveLength(0);
    expect(client.receivedOfType('mode.changed').filter((msg) => msg.active === false)).toHaveLength(0);
    expect(telegram.api.closeForumTopic).not.toHaveBeenCalled();
    expect(telegram.api.sendMessage).not.toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('Session resumed locally'),
      expect.anything(),
    );
    expect(relayTargets.lastTarget('sess-1')).toBe('telegram');
  });

  it('T5 — CLI /back clears AFK mode, banners the topic, closes it, and broadcasts mode.changed false', async () => {
    const topicId = 7373;
    const { client, telegram, registry, relayTargets, driver } = await makeHarness([
      makeSessionEntry({ topicId, lastTopicId: topicId, mode: 'afk', afkSince: ADR11_TIMESTAMP }),
    ]);

    client.sendBackRequest();
    await flush();
    await driver.handleBackRequest('sess-1');
    await flush();

    expect(client.receivedOfType('back.confirmed')).toHaveLength(1);
    expect(client.expectModeChanged(false)).toMatchObject({ active: false });
    expect(telegram.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      '🖥️ Session resumed locally',
      expect.objectContaining({ message_thread_id: topicId }),
    );
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(CHAT_ID, topicId);
    expect(telegram.order.indexOf('sendMessage')).toBeLessThan(telegram.order.indexOf('closeForumTopic'));
    expect(registry.findBySessionId('sess-1')).toMatchObject({ mode: 'back', lastTopicId: topicId });
    expect(relayTargets.lastTarget('sess-1')).toBe('cli');
  });

  it('T6 — /afk with daemon unreachable errors immediately with no retry/backoff timer', async () => {
    const daemon = new FakeDaemon();
    const telegram = makeMockTelegramBot();
    const registry = new MemoryAfkRegistry([makeSessionEntry({ sessionId: 'offline-session' })]);
    const relayTargets = new RelayTargetSpy();
    const showCliMessage = vi.fn();
    const driver = await loadAfkContractDriver({
      daemon,
      clients: [],
      telegram,
      registry,
      relayTargets,
      chatId: CHAT_ID,
      now: () => ADR11_TIMESTAMP,
      showCliMessage,
    });

    await driver.handleAfkRequest('offline-session');

    expect(showCliMessage).toHaveBeenCalledWith('offline-session', '⚠ Reach daemon not running — start it first.');
    expect(telegram.api.createForumTopic).not.toHaveBeenCalled();
    expect(relayTargets.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T7 — /back outside AFK mode reports Not in AFK mode and leaves state unchanged', async () => {
    const { client, telegram, registry, relayTargets, showCliMessage, driver } = await makeHarness([
      makeSessionEntry({ mode: 'back' }),
    ]);

    client.sendBackRequest();
    await flush();
    await driver.handleBackRequest('sess-1');
    await flush();

    expect(showCliMessage).toHaveBeenCalledWith('sess-1', 'Not in AFK mode.');
    expect(client.receivedOfType('back.confirmed')).toHaveLength(0);
    expect(client.receivedOfType('mode.changed')).toHaveLength(0);
    expect(telegram.api.closeForumTopic).not.toHaveBeenCalled();
    expect(registry.findBySessionId('sess-1')).toMatchObject({ mode: 'back' });
    expect(relayTargets.calls).toHaveLength(0);
  });

  it('T8 — rapid double /afk is idempotent: one topic, one activation, no state corruption', async () => {
    const { client, telegram, registry, relayTargets, driver } = await makeHarness();

    client.sendAfkRequest();
    client.sendAfkRequest();
    await flush();
    await Promise.all([driver.handleAfkRequest('sess-1'), driver.handleAfkRequest('sess-1')]);
    await flush();

    expect(telegram.api.createForumTopic).toHaveBeenCalledTimes(1);
    expect(telegram.createdTopicIds).toHaveLength(1);
    const topicId = telegram.createdTopicIds[0]!;
    expect(client.receivedOfType('afk.activated')).toHaveLength(1);
    expect(client.expectAfkActivated(topicId)).toMatchObject({ topicId });
    expect(client.receivedOfType('mode.changed').filter((msg) => msg.active)).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.findBySessionId('sess-1')).toMatchObject({ mode: 'afk', topicId, lastTopicId: topicId });
    expect(relayTargets.topicTargets('sess-1')).toEqual([topicId]);
  });
});
