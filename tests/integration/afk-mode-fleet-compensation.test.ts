/**
 * A6-6 fleet compensation tests — parallel close burst at N=20+.
 *
 * Exercises compensatePartialActivation at fleet scale (20 sessions) and under
 * simulated 429 retry pressure to resolve the A6-6 architect watch.
 *
 * HARNESS CONTRACT (Kat-safe):
 *   - Only the public AfkModeController surface is used (via loadAllowAllAfkContractDriver).
 *   - No private method access; tests survive afkMode.ts internals being refactored.
 *   - Activation failure is triggered at postGeneralSummary (AFTER all N topics are
 *     created and notified), so compensatePartialActivation runs over the full fleet.
 *   - delay is injected as a no-op so withRateLimitRetry retries complete as microtasks.
 *   - vi.useFakeTimers prevents the COMPENSATION_TIMEOUT_MS race timer from firing,
 *     meaning all closes complete via the close-result path (not the timeout).
 *
 * VERDICT TARGET:
 *   - TC-A6-6-1: no 429s  → all N closed, no leaks, no duplicates
 *   - TC-A6-6-2: 429 on 7/20 topics, retry succeeds → all N closed, retries counted
 *   - Both green → CLOSED (safe at N=20+)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDaemon } from '../helpers/FakeDaemon.js';
import { FakeExtensionClient } from '../helpers/FakeExtensionClient.js';
import {
  ADR11_TIMESTAMP,
  CHAT_ID,
  MemoryAfkRegistry,
  RelayTargetSpy,
  loadAllowAllAfkContractDriver,
  makeMockTelegramBot,
  makeSessionEntry,
} from '../helpers/afkContract.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FLEET_SIZE = 20;

/**
 * Topics are assigned sequentially starting at 9001 by makeMockTelegramBot.
 * For FLEET_SIZE=20, topics will be 9001–9020.
 * Every 3rd topic (indices 0, 3, 6, 9, 12, 15, 18) = 7 topics for 429 testing.
 */
const FIRST_TOPIC_ID = 9001;
const TOPICS_TO_429 = new Set(
  Array.from({ length: FLEET_SIZE }, (_, i) => FIRST_TOPIC_ID + i).filter((_, i) => i % 3 === 0),
);
const EXPECTED_429_COUNT = TOPICS_TO_429.size; // 7

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

/** Drain async chains; a single flush usually drains all microtasks, but
 *  extra iterations guard against edge cases in long mock chains. */
async function drainAsync(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) await flush();
}

/** Builds an Error shaped like a Telegram 429 response so retryAfterMs() detects it. */
function make429(retryAfterSec = 1): Error {
  return Object.assign(new Error('Too Many Requests: retry after 1'), {
    error_code: 429,
    parameters: { retry_after: retryAfterSec },
  });
}

// ─── Fleet harness ────────────────────────────────────────────────────────────

async function makeFleetHarness(fleetSize = FLEET_SIZE) {
  const sessionDefs = Array.from({ length: fleetSize }, (_, i) => ({
    sessionId: `fleet-${i + 1}`,
    sessionName: `reach-fleet-${String(i + 1).padStart(2, '0')}`,
  }));

  const daemon = new FakeDaemon();
  const clients = sessionDefs.map(({ sessionId, sessionName }) =>
    new FakeExtensionClient(sessionId, sessionName),
  );
  for (const client of clients) {
    client.connect(daemon);
    client.sendHello();
  }
  // Drain readline's line events so all 20 hellos are processed and sessions are registered.
  await flush();

  const telegram = makeMockTelegramBot();
  const entries = sessionDefs.map(({ sessionId, sessionName }) =>
    makeSessionEntry({ sessionId, sessionName }),
  );
  const registry = new MemoryAfkRegistry(entries);
  const relayTargets = new RelayTargetSpy();
  const showCliMessage = vi.fn();

  const driver = loadAllowAllAfkContractDriver({
    daemon,
    clients,
    telegram,
    registry,
    relayTargets,
    chatId: CHAT_ID,
    now: () => ADR11_TIMESTAMP,
    showCliMessage,
  });

  return { clients, telegram, registry, relayTargets, driver, sessionDefs };
}

/**
 * Mocks telegram.api.sendMessage so that:
 *   - Per-topic sendMessage calls (with message_thread_id) succeed.
 *   - The postGeneralSummary sendMessage call (with parse_mode: 'MarkdownV2') throws,
 *     which propagates up through activateAllSessions and triggers compensation.
 *
 * This ensures failure fires AFTER all N topics are created and all N sessions are
 * in notified[], so compensatePartialActivation receives the full fleet.
 */
function injectPostGeneralSummaryFailure(telegram: ReturnType<typeof makeMockTelegramBot>): void {
  telegram.api.sendMessage.mockImplementation(
    async (_chatId: unknown, _text: unknown, options: Record<string, unknown> | undefined) => {
      if (options?.['parse_mode'] === 'MarkdownV2') {
        throw new Error('postGeneralSummary failure — injected by A6-6 fleet test');
      }
      return { message_id: 100, chat: { id: CHAT_ID }, text: _text };
    },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('A6-6 — fleet compensation close burst', () => {
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

  it('TC-A6-6-1 — all N=20 topics closed via compensation with no 429s: no leaks, no duplicates', async () => {
    const { telegram, driver, sessionDefs } = await makeFleetHarness();
    injectPostGeneralSummaryFailure(telegram);

    // Trigger activation with the first fleet session; activate() runs for all sessions
    // because bridge.listSessions() returns all 20 connected clients.
    await driver.handleAfkRequest(sessionDefs[0]!.sessionId);
    // One flush is usually sufficient (all microtasks drain before setImmediate in
    // handleAfkRequest fires), but drainAsync guards against edge cases.
    await drainAsync();

    // All 20 topics were created before the postGeneralSummary failure.
    expect(telegram.api.createForumTopic).toHaveBeenCalledTimes(FLEET_SIZE);

    // Compensation must close every created topic exactly once — no leaks, no duplicates.
    expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(FLEET_SIZE);

    const closedTopicIds = telegram.api.closeForumTopic.mock.calls.map(
      (call) => call[1] as number,
    );
    // No duplicate closes (each topicId appears exactly once).
    expect(new Set(closedTopicIds).size).toBe(FLEET_SIZE);

    // Every created topic ID appears in the close calls (no leaks).
    for (const topicId of telegram.createdTopicIds) {
      expect(closedTopicIds).toContain(topicId);
    }

    // Compensation timeout timers are all still pending (none fired), confirming
    // all 20 closes completed via the close-result path — not the 7 s cap.
    expect(vi.getTimerCount()).toBe(FLEET_SIZE);
  });

  it('TC-A6-6-2 — all N=20 topics closed via compensation under 429 pressure: retries succeed, no leaks', async () => {
    const { telegram, driver, sessionDefs } = await makeFleetHarness();
    injectPostGeneralSummaryFailure(telegram);

    // Mock closeForumTopic: first call for every-3rd topic (7 total) returns 429;
    // second call (retry) always succeeds. Topics are pre-calculated since
    // makeMockTelegramBot assigns IDs sequentially starting at 9001.
    const already429d = new Set<number>();
    telegram.api.closeForumTopic.mockImplementation(
      async (_chatId: unknown, topicId: unknown) => {
        const id = topicId as number;
        if (TOPICS_TO_429.has(id) && !already429d.has(id)) {
          already429d.add(id);
          throw make429(1);
        }
        return true;
      },
    );

    await driver.handleAfkRequest(sessionDefs[0]!.sessionId);
    await drainAsync();

    // All 20 topics created before the failure.
    expect(telegram.api.createForumTopic).toHaveBeenCalledTimes(FLEET_SIZE);

    // Every topic was closed (retries succeeded for the 429'd subset).
    const allCloseArgs = telegram.api.closeForumTopic.mock.calls.map(
      (call) => call[1] as number,
    );
    const uniqueClosedTopics = new Set(allCloseArgs);
    expect(uniqueClosedTopics.size).toBe(FLEET_SIZE);
    for (const topicId of telegram.createdTopicIds) {
      expect(allCloseArgs).toContain(topicId);
    }

    // Total calls = N successful + N_429 retries (one retry per 429'd topic).
    expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(
      FLEET_SIZE + EXPECTED_429_COUNT,
    );

    // All 7 429 mock calls were actually triggered (confirms retry path was exercised).
    expect(already429d.size).toBe(EXPECTED_429_COUNT);

    // Compensation timeouts all still pending — no close needed the 7 s timeout cap.
    expect(vi.getTimerCount()).toBe(FLEET_SIZE);
  });
});
