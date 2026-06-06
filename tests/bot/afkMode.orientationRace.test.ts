/**
 * AfkModeController — orientation race guard (T1, PR #10 Cycle 6).
 *
 * Verifies that two concurrent sendOrientationMessage() calls on the same
 * binding result in exactly ONE safeSendMessage invocation, because the flag
 * is now set BEFORE awaiting the send.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { AfkModeController } from '../../src/bot/afkMode.js';
import type { AfkBridgePort, AfkBridgeEvents } from '../../src/bot/afkBridgePort.js';
import type { OutboundMessage } from '../../src/bridge/protocol.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ── constants ────────────────────────────────────────────────────────────────

const CHAT_ID   = -1001234567890;
const TOPIC_ID  = 55;
const SESSION_ID = 'race-session';

// ── test doubles ─────────────────────────────────────────────────────────────

class TestBridge implements AfkBridgePort {
  private readonly _emitter = new EventEmitter();

  readonly sendToSession           = vi.fn();
  readonly broadcastToSessions     = vi.fn();
  readonly listSessions            = vi.fn(() => []);
  readonly setRegistrationAugmenter = vi.fn();

  on<K extends keyof AfkBridgeEvents>(event: K, listener: (...args: AfkBridgeEvents[K]) => void): void {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
  }

  getSessionInfo(sessionId: string) {
    if (sessionId === SESSION_ID) {
      return { sessionId: SESSION_ID, sessionName: 'reach-racetest', cwd: 'D:\\git\\verbose-invention' };
    }
    return undefined;
  }

  sendToSessionImpl(_sessionId: string, _msg: OutboundMessage): void { /* no-op */ }
}

describe('AfkModeController — orientation race guard', () => {
  it('OR1 flag-first: second caller skips because orientationSent is true before first send resolves', async () => {
    let resolveSlowSend!: () => void;
    const slowSend = new Promise<void>((res) => { resolveSlowSend = res; });

    const bot = {
      api: {
        sendMessage: vi.fn().mockReturnValue(slowSend.then(() => ({ message_id: 1 }))),
        editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const bridge  = new TestBridge();
    const controller = AfkModeController.forTesting(
      {
        bot: bot as never,
        bridge,
        registry: makeStubRegistry(),
        chatId: CHAT_ID,
        delay: async () => undefined,
        options: {},
      },
      {
        mode: { active: true, since: '2026-01-01T00:00:00Z' },
        sessions: [{ sessionId: SESSION_ID, topicId: TOPIC_ID }],
      },
    );

    const binding = (controller as any).sessionTopics.get(SESSION_ID);
    expect(binding).toBeDefined();
    expect(binding.orientationSent).toBeFalsy();

    // Caller 1: guard check passes → enters sendOrientationMessage (slow send in flight).
    // The async IIFE runs synchronously until its first internal await (inside safeSendMessage),
    // so the flag is set before this line returns.
    const p1 = (async () => {
      if (!binding.orientationSent) {
        await (controller as any).sendOrientationMessage(binding);
      }
    })();

    // At this point sendOrientationMessage has executed its synchronous preamble:
    //   binding.orientationSent = true  ← done
    //   await safeSendMessage(...)      ← still in flight
    expect(binding.orientationSent).toBe(true);

    // Caller 2: guard check should now be false → skips the send entirely.
    let caller2Sent = false;
    if (!binding.orientationSent) {
      caller2Sent = true;
      await (controller as any).sendOrientationMessage(binding);
    }

    // Unblock the slow send and wait for caller 1 to finish.
    resolveSlowSend();
    await p1;

    expect(caller2Sent).toBe(false);
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(binding.orientationSent).toBe(true);
  });

  it('OR2 orientationSent remains true even if safeSendMessage throws', async () => {
    const bot = {
      api: {
        sendMessage: vi.fn().mockRejectedValue(new Error('Telegram error')),
        editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const bridge  = new TestBridge();
    const controller = AfkModeController.forTesting(
      {
        bot: bot as never,
        bridge,
        registry: makeStubRegistry(),
        chatId: CHAT_ID,
        delay: async () => undefined,
        options: {},
      },
      {
        mode: { active: true, since: '2026-01-01T00:00:00Z' },
        sessions: [{ sessionId: SESSION_ID, topicId: TOPIC_ID }],
      },
    );

    const binding = (controller as any).sessionTopics.get(SESSION_ID);
    expect(binding).toBeDefined();

    // safeSendMessage swallows errors — sendOrientationMessage always resolves.
    await expect((controller as any).sendOrientationMessage(binding)).resolves.toBeUndefined();
    // Flag kept true even on failure (Option A: no rollback, avoids retry spam).
    expect(binding.orientationSent).toBe(true);
  });
});
