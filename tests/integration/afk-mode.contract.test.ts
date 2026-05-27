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
import { ERROR_CODES } from '../../src/bridge/protocol.js';
import { FakeDaemon } from '../helpers/FakeDaemon.js';
import { FakeExtensionClient } from '../helpers/FakeExtensionClient.js';
import {
  ADR11_TIMESTAMP,
  CHAT_ID,
  MemoryAfkRegistry,
  RelayTargetSpy,
  TEST_TELEGRAM_USER_ID,
  loadAfkContractDriver,
  loadAllowAllAfkContractDriver,
  makeMockTelegramBot,
  makeSessionEntry,
  type AfkContractDriver,
} from '../helpers/afkContract.js';

async function flush(): Promise<void> {
  // Readline emits lines through setImmediate; the extra microtask drains async mock continuations.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function makeHarness(
  entries = [makeSessionEntry()],
  clientDefs = [{ sessionId: 'sess-1', sessionName: 'reach-myapp' }],
  { allowAll = false }: { allowAll?: boolean } = {},
) {
  const daemon = new FakeDaemon();
  const clients = clientDefs.map(({ sessionId, sessionName }) => new FakeExtensionClient(sessionId, sessionName));
  for (const connectedClient of clients) {
    connectedClient.connect(daemon);
    connectedClient.sendHello();
  }
  await flush();

  const telegram = makeMockTelegramBot();
  const registry = new MemoryAfkRegistry(entries);
  const relayTargets = new RelayTargetSpy();
  const showCliMessage = vi.fn();
  const loadDriver = allowAll ? loadAllowAllAfkContractDriver : loadAfkContractDriver;
  const driver = loadDriver({
    daemon,
    clients,
    telegram,
    registry,
    relayTargets,
    chatId: CHAT_ID,
    now: () => ADR11_TIMESTAMP,
    showCliMessage,
  });

  return { daemon, client: clients[0]!, clients, telegram, registry, relayTargets, showCliMessage, driver };
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

  it('T7 — /back outside AFK mode delivers error frame to extension and leaves state unchanged', async () => {
    const { client, telegram, registry, relayTargets, driver } = await makeHarness([
      makeSessionEntry({ mode: 'back' }),
    ]);

    client.sendBackRequest();
    await flush();
    await driver.handleBackRequest('sess-1');
    await flush();

    expect(client.lastError).toMatchObject({
      type: 'error',
      sessionId: 'sess-1',
      error: 'Not in AFK mode.',
      code: ERROR_CODES.AFK_NOT_ACTIVE,
    });
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

  it('T9c — partial-activation rollback clears lastTopicId so retry creates fresh topic (B6-1)', async () => {
    // B6-1 regression: after partial-activation failure, compensatePartialActivation used to
    // leave lastTopicId in the registry. A retry would then call reopenForumTopic on a topic
    // whose orphaned compensation close was still in-flight, resurrecting the wrong topic.
    //
    // Fix A (293e850): delete rolledBack.lastTopicId in the registry-rollback loop so
    //   the next ensureTopic call creates a fresh topic instead.
    // Fix B (293e850): hoist activationPromise guard above mode.active check so a retry
    //   during the ~7s compensation window cannot bypass serialization.
    const { clients, registry, telegram, driver } = await makeHarness(
      [
        makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp' }),
        makeSessionEntry({ sessionId: 'sess-2', sessionName: 'reach-api' }),
      ],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'sess-2', sessionName: 'reach-api' },
      ],
    );
    void clients; // two-session harness required for partial-activation failure path

    // sess-1 creates topic 9001 via the original monotonic impl; sess-2 fails.
    const originalCreateImpl = telegram.api.createForumTopic.getMockImplementation()!;
    telegram.api.createForumTopic
      .mockImplementationOnce(originalCreateImpl)            // sess-1 → 9001 (tracked by createdTopicIds)
      .mockRejectedValueOnce(new Error('Telegram API unavailable for sess-2')); // sess-2 → throws

    // closeForumTopic hangs for the compensation close of topic 9001.
    let resolveHangingClose!: () => void;
    const hangingClose = new Promise<boolean>((resolve) => {
      resolveHangingClose = () => resolve(true);
    });
    telegram.api.closeForumTopic.mockImplementationOnce(() => hangingClose);

    // First activation attempt: sess-2 fails → compensation starts, closeForumTopic hangs.
    await driver.handleAfkRequest('sess-1');
    await flush(); // drain to where compensatePartialActivation is blocking on Promise.race

    // Advance past COMPENSATION_TIMEOUT_MS (7 000 ms) so the race resolves with a timeout error.
    vi.advanceTimersByTime(8_000);
    // Drain the microtask/async chain: timeout rejection → compensationClose.catch → Promise.all
    // → compensatePartialActivation resolves → registry rollback → editGeneralSummary → error send.
    for (let i = 0; i < 8; i++) await flush();

    // Fix A: registry rollback must have removed lastTopicId for sess-1.
    const afterRollback = registry.findBySessionId('sess-1');
    expect(afterRollback?.lastTopicId).toBeUndefined();
    expect(afterRollback?.mode).toBe('back');

    // Fix B: mode must be inactive so the retry is not blocked.
    expect(driver.getMode?.()).toMatchObject({ active: false });

    // Second activation — must create a FRESH topic (9002), not reopen 9001.
    await driver.handleAfkRequest('sess-1');
    // Drain the fresh-activation success path: ensureTopic creates new topics for both
    // sessions → registry.upsert for each → sendAfkActivated dispatched to each session.
    for (let i = 0; i < 8; i++) await flush();

    // reopenForumTopic must not have been called for 9001 (Fix A: lastTopicId was cleared).
    expect(telegram.api.reopenForumTopic).not.toHaveBeenCalledWith(CHAT_ID, 9001);
    // createForumTopic must have been called again on the retry (fresh topic 9002).
    expect(telegram.createdTopicIds).toContain(9002);

    // Release the hanging close — compensation already timed out; this resolves the dangling
    // promise so no unhandled-rejection warnings surface after the test.
    resolveHangingClose();
    await flush();

    // Second activation completes successfully.
    expect(driver.getMode?.()).toMatchObject({ active: true });
  });

  it('T9 — Telegram API failure during activate rolls back state and delivers error frame to extension', async () => {    const { client, telegram, registry, driver } = await makeHarness();

    // Simulate Telegram API failure on the first topic creation.
    telegram.api.createForumTopic.mockRejectedValueOnce(new Error('Telegram API unavailable'));

    await driver.handleAfkRequest('sess-1');
    await flush();

    // Mode must have been rolled back to inactive.
    expect(driver.getMode?.()).toMatchObject({ active: false });
    // Registry must not show the session as afk (rolled back).
    expect(registry.findBySessionId('sess-1')).not.toMatchObject({ mode: 'afk' });
    // Extension must receive an error frame — not silently drop the failure.
    expect(client.lastError).toMatchObject({
      type: 'error',
      sessionId: 'sess-1',
      error: expect.any(String),
      code: ERROR_CODES.AFK_ACTIVATION_FAILED,
    });
  });

  it('T9b — partial activation: only notified sessions receive back.confirmed/mode.changed compensation', async () => {
    // B5-1: validates the notified-only compensation invariant introduced in Cycle 5.
    // registry.upsert succeeds for sess-1 (topic created, afk.activated sent, notified[]),
    // then throws for sess-2 (upsert in ensureTopic throws — with Fix A, sess-2's binding is
    // never written to sessionTopics because upsert runs before the map write).
    // compensatePartialActivation must only back-notify sess-1, and only sess-1's topic is closed
    // (sess-2's topic was created in Telegram but never committed to the in-memory maps).
    const { clients, registry, telegram, driver } = await makeHarness(
      [
        makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp' }),
        makeSessionEntry({ sessionId: 'sess-2', sessionName: 'reach-api' }),
      ],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'sess-2', sessionName: 'reach-api' },
      ],
    );
    const client1 = clients[0]!;
    const client2 = clients[1]!;

    vi.spyOn(registry, 'upsert')
      .mockResolvedValueOnce(undefined)           // sess-1 upsert succeeds → afk.activated sent
      .mockRejectedValueOnce(new Error('upsert-fail')); // sess-2 upsert throws → activation aborts

    await driver.handleAfkRequest('sess-1');
    await flush(); // drain the rejection from the mock
    await flush(); // allow compensatePartialActivation's async ops (detached closeForumTopic) to settle

    // Internal activate() rejected — mode is rolled back to inactive.
    expect(driver.getMode?.()).toMatchObject({ active: false });

    // Only sess-1 received afk.activated (it was notified before the upsert failure).
    expect(client1.receivedOfType('afk.activated')).toHaveLength(1);
    expect(client2.receivedOfType('afk.activated')).toHaveLength(0);

    // Compensation must only reach sessions that were notified.
    expect(client1.receivedOfType('back.confirmed')).toHaveLength(1);
    expect(client2.receivedOfType('back.confirmed')).toHaveLength(0);

    expect(client1.receivedOfType('mode.changed').filter((msg) => msg.active === false)).toHaveLength(1);
    expect(client2.receivedOfType('mode.changed').filter((msg) => msg.active === false)).toHaveLength(0);

    // B7-1 sub-claim B (registry-before-maps): upsert now runs before sessionTopics.set,
    // so sess-2's binding was never stored in the map. Compensation closes sess-1's topic
    // (which fully committed). F1 orphan prevention closes sess-2's topic immediately when
    // upsert throws, so total: 2 closes (sess-1 via compensation, sess-2 via F1 catch).
    expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(2);
  });

  it('T10 — partial activation rollback closes opened topics and notifies extensions', async () => {
    const topicId = 9101;
    const { clients, telegram, driver } = await makeHarness(
      [
        makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp' }),
        makeSessionEntry({ sessionId: 'sess-2', sessionName: 'reach-api' }),
      ],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'sess-2', sessionName: 'reach-api' },
      ],
    );
    const client1 = clients[0]!;
    const client2 = clients[1]!;

    telegram.api.createForumTopic
      .mockResolvedValueOnce({ message_thread_id: topicId })
      .mockRejectedValueOnce(new Error('Telegram API unavailable for sess-2'));

    await driver.handleAfkRequest('sess-1');
    await flush(); // drain the rejection from the mock
    await flush(); // allow compensatePartialActivation's async ops (detached closeForumTopic) to settle

    expect(driver.getMode?.()).toMatchObject({ active: false });
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(CHAT_ID, topicId);
    expect(client1.expectModeChanged(false)).toMatchObject({ active: false });
    expect(client1.receivedOfType('afk.activated')).toHaveLength(1);
    expect(client1.receivedOfType('back.confirmed')).toHaveLength(1);
    expect(client2.receivedOfType('afk.activated')).toHaveLength(0);
    expect(client1.lastError).toMatchObject({
      type: 'error',
      sessionId: 'sess-1',
      error: expect.any(String),
      code: ERROR_CODES.AFK_ACTIVATION_FAILED,
    });
  });

  it('T11 — allow-all variant: message from non-configured user is mirrored when allowedUserIds is undefined', async () => {
    const { client, telegram, driver } = await makeHarness(undefined, undefined, { allowAll: true });

    await activate(driver, client);
    const topicId = telegram.createdTopicIds[0]!;

    const unknownUserId = TEST_TELEGRAM_USER_ID + 9999;
    await driver.handleTelegramMessage(topicId, 'hello from unknown user', unknownUserId);
    await flush();

    expect(client.receivedOfType('mirror.input')).toHaveLength(1);
    expect(client.receivedOfType('mirror.input')[0]).toMatchObject({
      type: 'mirror.input',
      sessionId: 'sess-1',
      text: 'hello from unknown user',
    });
  });

  it('T12 — handleTelegramMessage rejects messages from wrong chat ID', async () => {
    // I5-5 defense-in-depth: chat.id check in handleTelegramMessage must reject context
    // objects whose chat.id does not match the configured chatId, even for a known topicId.
    const { client, telegram, driver } = await makeHarness();

    await activate(driver, client);
    const topicId = telegram.createdTopicIds[0]!;

    // Clear sendMessage call history from activation so the assertion below
    // cleanly checks only whether the wrong-chat event triggered a reply.
    telegram.api.sendMessage.mockClear();

    const WRONG_CHAT = CHAT_ID - 1;
    await driver.handleTelegramMessage(topicId, 'evil input', TEST_TELEGRAM_USER_ID, WRONG_CHAT);
    await flush();

    expect(client.receivedOfType('mirror.input')).toHaveLength(0);
    // M6-3: silent rejection — no Telegram reply to the wrong-chat sender.
    expect(telegram.api.sendMessage).not.toHaveBeenCalled();
    // Note: console.error/console.warn log-level assertions are not added here because the
    // wrong-chat guard is a silent early-return (no log emitted by design per I6-3 comment).
  });

  it('T13a — B7-1 race: two rapid activate calls for an unbound session both bypass the sessionTopics guard', async () => {
    // B7-1 sub-claim A: while mode.active === true, two rapid activate('late-1') calls both pass
    // !sessionTopics.has('late-1') because the map is only written inside ensureTopic() AFTER
    // createForumTopic resolves (line 428), not before. Both calls enter ensureTopic() and queue
    // a createForumTopic via serializedTopicOperation. Expected: exactly one topic created.
    const { telegram, driver } = await makeHarness(
      [makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp', topicId: 9001, lastTopicId: 9001, mode: 'afk', afkSince: ADR11_TIMESTAMP })],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'late-1', sessionName: 'reach-late' },
      ],
    );

    // Mode is already active (seeded). Fire two rapid late-register requests without awaiting
    // between them so both calls reach activate() before any microtask processes the first.
    void driver.handleAfkRequest('late-1');
    void driver.handleAfkRequest('late-1');

    // Drain the full async chain (topic queue, upsert, afk.activated).
    for (let i = 0; i < 8; i++) await flush();

    // If the race exists: createForumTopic is called twice (two topics for late-1).
    // Correct behaviour: exactly one topic created.
    expect(telegram.api.createForumTopic).toHaveBeenCalledOnce();
  });

  it('T13b — B7-1 stuck-state: upsert failure after sessionTopics.set leaves session permanently stuck', async () => {
    // B7-1 sub-claim B: ensureTopic() writes sessionTopics (line 428) BEFORE registry.upsert()
    // (line 431). If upsert throws, the in-memory binding remains. Subsequent activate() calls
    // see sessionTopics.has('late-1') === true and no-op via the fast-path guard.
    const { telegram, registry, driver } = await makeHarness(
      [makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp', topicId: 9001, lastTopicId: 9001, mode: 'afk', afkSince: ADR11_TIMESTAMP })],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'late-1', sessionName: 'reach-late' },
      ],
    );

    // Inject a one-shot upsert failure. createForumTopic will succeed, sessionTopics.set
    // will run (the binding is stored), then upsert throws — activate().catch() absorbs the error.
    vi.spyOn(registry, 'upsert').mockRejectedValueOnce(new Error('upsert-fail'));

    await driver.handleAfkRequest('late-1');
    for (let i = 0; i < 4; i++) await flush();

    // Mode stays active; the error was swallowed by the .catch on activate().
    expect(driver.getMode()).toMatchObject({ active: true });

    // Registry is healthy again. Second activation attempt for late-1.
    // If stuck-state bug exists: sessionTopics.has('late-1') === true → fast-path no-op,
    // createForumTopic never called again, afk.activated never sent.
    await driver.handleAfkRequest('late-1');
    for (let i = 0; i < 4; i++) await flush();

    // Expected: createForumTopic called a second time (retry succeeds).
    // Stuck-state bug: createForumTopic called only once total.
    expect(telegram.api.createForumTopic).toHaveBeenCalledTimes(2);
  });

  it('F1a — late-register: upsert failure after topic creation triggers orphan cleanup', async () => {
    // F1 fix: createOrReopenTopic catches upsert failure and closes the orphan topic before re-throwing.
    // Previously (Cycle 8 F1 bug): the topic was created but never added to sessionTopics, so compensation
    // had no record of it. The orphan was never closed. After Kat's commit 60afb67, the orphan is cleaned up.
    const { telegram, registry, driver } = await makeHarness(
      [makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp', topicId: 9001, lastTopicId: 9001, mode: 'afk', afkSince: ADR11_TIMESTAMP })],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'late-1', sessionName: 'reach-late' },
      ],
    );

    // First attempt: upsert throws after topic 9001 is created.
    vi.spyOn(registry, 'upsert').mockRejectedValueOnce(new Error('disk full'));

    await driver.handleAfkRequest('late-1');
    for (let i = 0; i < 4; i++) await flush();

    // F1 fix: the orphan topic (9001) was closed before re-throwing the upsert error.
    expect(telegram.createdTopicIds).toEqual([9001]);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(-1001234567890, 9001);

    // Second attempt: upsert succeeds. A fresh topic (9002) is created because the first
    // attempt did not persist lastTopicId (the upsert failed).
    await driver.handleAfkRequest('late-1');
    for (let i = 0; i < 4; i++) await flush();

    // Fix verification: two topics created (9001 orphaned and cleaned, 9002 active), orphan closed.
    expect(telegram.createdTopicIds).toEqual([9001, 9002]);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(1);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(-1001234567890, 9001);
  });

  it('F1b — first-activation: upsert failure after topic creation triggers orphan cleanup', async () => {
    // F1 fix variant: orphan cleanup also protects first-activation (activateAllSessions).
    // Previously: if a topic was created but upsert threw, compensation had no record and the
    // orphan was never closed. After Kat's commit 60afb67, createOrReopenTopic closes the orphan.
    const { telegram, registry, driver } = await makeHarness(
      [
        makeSessionEntry({ sessionId: 'sess-1', sessionName: 'reach-myapp' }),
        makeSessionEntry({ sessionId: 'sess-2', sessionName: 'reach-api' }),
      ],
      [
        { sessionId: 'sess-1', sessionName: 'reach-myapp' },
        { sessionId: 'sess-2', sessionName: 'reach-api' },
      ],
    );

    // First activation: sess-1's topic is created, then upsert throws.
    // sess-2 is never processed (loop exits early).
    vi.spyOn(registry, 'upsert').mockRejectedValueOnce(new Error('disk full'));

    await driver.handleAfkRequest('sess-1');
    for (let i = 0; i < 4; i++) await flush();

    // F1 fix: the orphan topic (9001) was closed before re-throwing the upsert error.
    expect(telegram.createdTopicIds).toEqual([9001]);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(-1001234567890, 9001);

    // Second activation: both sessions succeed. Two fresh topics (9002, 9003) are created.
    await driver.handleAfkRequest('sess-1');
    for (let i = 0; i < 6; i++) await flush();

    // Fix verification: three topics created (9001 orphaned and cleaned, 9002 + 9003 active), orphan closed.
    expect(telegram.createdTopicIds).toEqual([9001, 9002, 9003]);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(1);
    expect(telegram.api.closeForumTopic).toHaveBeenCalledWith(-1001234567890, 9001);
  });
});
