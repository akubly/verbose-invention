/**
 * AfkModeController — non-numeric lastTopicId treated as absent.
 *
 * Regression guard for PR #11 round-2 Thread 4:
 * Number('abc') is NaN, which is not undefined, so the un-guarded code would
 * attempt reopenForumTopic(NaN) and build a malformed topicUrl. The fix uses
 * Number.isFinite() to reject non-finite values and fall through to the
 * createForumTopic path instead.
 *
 * Addresses: src/bot/afkMode.ts ~lines 468-470.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { AfkModeController } from '../../src/bot/afkMode.js';
import type { AfkBridgePort, AfkBridgeEvents } from '../../src/bot/afkBridgePort.js';
import type { OutboundMessage } from '../../src/bridge/protocol.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/types.js';

// ── constants ────────────────────────────────────────────────────────────────

const CHAT_ID = -1001234567890;
const SESSION_ID = 'sess-nan';
const SESSION_NAME = 'reach-nantest';
const NEW_TOPIC_ID = 9001;

// ── minimal doubles ───────────────────────────────────────────────────────────

class TestBridge implements AfkBridgePort {
  private readonly _emitter = new EventEmitter();

  readonly sendToSession = vi.fn();
  readonly broadcastToSessions = vi.fn();
  readonly listSessions = vi.fn(() => [{ sessionId: SESSION_ID, sessionName: SESSION_NAME, cwd: '' }]);
  readonly setRegistrationAugmenter = vi.fn();

  on<K extends keyof AfkBridgeEvents>(event: K, listener: (...args: AfkBridgeEvents[K]) => void): void {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
  }

  getSessionInfo(sessionId: string) {
    if (sessionId === SESSION_ID) {
      return { sessionId: SESSION_ID, sessionName: SESSION_NAME, cwd: '' };
    }
    return undefined;
  }

  sendToSessionImpl(_sessionId: string, _msg: OutboundMessage): void { /* no-op */ }

  emitAfkRequest(sessionId: string): void {
    this._emitter.emit('afk.request', sessionId, undefined);
  }
}

/**
 * Registry stub that returns an entry with a non-numeric lastTopicId ('abc')
 * to simulate a corrupt or hand-edited registry.
 */
function makeRegistryWithNonNumericLastTopicId(): ISessionRegistry {
  const entry: SessionEntry = {
    sessionName: SESSION_NAME,
    threadId: '111',
    channelId: String(CHAT_ID),
    createdAt: '2026-01-01T00:00:00Z',
    cwd: '',
    mode: 'back',
    lastTopicId: 'abc', // non-numeric — Number('abc') === NaN
  };
  return {
    load: vi.fn(),
    register: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn(),
    findByName: vi.fn(() => entry),
    findAllByName: vi.fn((name: string) => name === SESSION_NAME ? [entry] : []),
    list: vi.fn(() => [entry]),
    remove: vi.fn().mockResolvedValue(true),
    move: vi.fn(),
  } as unknown as ISessionRegistry;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AfkModeController — non-numeric lastTopicId treated as absent', () => {
  it('NAN1: does not call reopenForumTopic when lastTopicId is non-numeric; creates a fresh topic instead', async () => {
    const reopenForumTopic = vi.fn().mockResolvedValue(true);
    const createForumTopic = vi.fn().mockResolvedValue({ message_thread_id: NEW_TOPIC_ID });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

    const bot = {
      api: { reopenForumTopic, createForumTopic, sendMessage, editMessageText: vi.fn().mockResolvedValue({}) },
    };

    const bridge = new TestBridge();
    const registry = makeRegistryWithNonNumericLastTopicId();

    const controller = AfkModeController.forTesting(
      {
        bot: bot as never,
        bridge,
        registry,
        chatId: CHAT_ID,
        delay: async () => undefined,
        options: {},
      },
      // Start with mode inactive so activate() will run the full create path.
      {},
    );

    bridge.emitAfkRequest(SESSION_ID);
    await flush();
    await flush();

    // A fresh topic should have been created.
    expect(createForumTopic).toHaveBeenCalled();
    // reopenForumTopic must NOT have been attempted with NaN.
    expect(reopenForumTopic).not.toHaveBeenCalled();
  });
});
