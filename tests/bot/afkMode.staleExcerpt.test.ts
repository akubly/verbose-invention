/**
 * AfkModeController — lastKnownExcerpts stale-value clearing.
 *
 * Verifies that an afk.request with no excerpt (or an empty-string excerpt)
 * clears any previously cached excerpt so that /status never shows stale
 * context from a prior activation.
 *
 * Addresses the PR #10 review comment on src/bot/afkMode.ts:119-123.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { AfkModeController } from '../../src/bot/afkMode.js';
import type { AfkBridgePort, AfkBridgeEvents } from '../../src/bot/afkBridgePort.js';
import type { OutboundMessage } from '../../src/bridge/protocol.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ── constants ────────────────────────────────────────────────────────────────

const CHAT_ID = -1001234567890;
const TOPIC_ID = 42;
const SESSION_ID = 'sess-1';

// ── minimal test doubles ─────────────────────────────────────────────────────

/**
 * EventEmitter-backed bridge that satisfies AfkBridgePort.
 * Unlike the vi.fn()-based bridge used in slash guard tests, this one
 * actually fires registered listeners so the afk.request handler in
 * AfkModeController picks up the excerpt argument.
 */
class TestBridge implements AfkBridgePort {
  private readonly _emitter = new EventEmitter();

  readonly sendToSession = vi.fn();
  readonly broadcastToSessions = vi.fn();
  readonly listSessions = vi.fn(() => []);
  readonly setRegistrationAugmenter = vi.fn();

  on<K extends keyof AfkBridgeEvents>(event: K, listener: (...args: AfkBridgeEvents[K]) => void): void {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
  }

  getSessionInfo(sessionId: string) {
    if (sessionId === SESSION_ID) {
      return { sessionId: SESSION_ID, sessionName: 'reach-myapp', cwd: 'D:\\git\\verbose-invention' };
    }
    return undefined;
  }

  sendToSessionImpl(_sessionId: string, _msg: OutboundMessage): void { /* no-op */ }

  emitAfkRequest(sessionId: string, excerpt?: string): void {
    this._emitter.emit('afk.request', sessionId, excerpt);
  }
}

function makeMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

/** Seeds a controller with mode=active and SESSION_ID already bound to TOPIC_ID. */
function makeActiveController(bridge: TestBridge, bot = makeMockBot()): AfkModeController {
  return AfkModeController.forTesting(
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
}

/** Minimal Context double for handleStatusCommand. */
function makeStatusCtx(topicId = TOPIC_ID) {
  return {
    message: { message_thread_id: topicId },
    chat: { id: CHAT_ID },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AfkModeController — lastKnownExcerpts stale-value clearing', () => {
  it('afk.request with excerpt → /status reply includes that excerpt', async () => {
    const bridge = new TestBridge();
    const bot = makeMockBot();
    const controller = makeActiveController(bridge, bot);

    bridge.emitAfkRequest(SESSION_ID, 'Hello from assistant');
    await flush();

    await controller.handleStatusCommand(makeStatusCtx() as never);

    const [[, statusText]] = bot.api.sendMessage.mock.calls as [[number, string, unknown]];
    expect(statusText).toContain('Hello from assistant');
    expect(statusText).toContain('💬');
  });

  it('afk.request omitting excerpt after prior activation stored one → /status omits stale excerpt', async () => {
    const bridge = new TestBridge();
    const bot = makeMockBot();
    const controller = makeActiveController(bridge, bot);

    // First activation stores an excerpt.
    bridge.emitAfkRequest(SESSION_ID, 'Stale excerpt from first activation');
    await flush();

    // Second activation omits the excerpt (e.g. no assistant turns yet, or older extension).
    bridge.emitAfkRequest(SESSION_ID);
    await flush();

    bot.api.sendMessage.mockClear();
    await controller.handleStatusCommand(makeStatusCtx() as never);

    const [[, statusText]] = bot.api.sendMessage.mock.calls as [[number, string, unknown]];
    expect(statusText).not.toContain('Stale excerpt from first activation');
    expect(statusText).not.toContain('💬');
  });

  it('afk.request with empty-string excerpt → treated as absent, clears any stored excerpt', async () => {
    const bridge = new TestBridge();
    const bot = makeMockBot();
    const controller = makeActiveController(bridge, bot);

    // First activation stores an excerpt.
    bridge.emitAfkRequest(SESSION_ID, 'Prior excerpt');
    await flush();

    // Second activation passes empty string (redaction can produce '').
    bridge.emitAfkRequest(SESSION_ID, '');
    await flush();

    bot.api.sendMessage.mockClear();
    await controller.handleStatusCommand(makeStatusCtx() as never);

    const [[, statusText]] = bot.api.sendMessage.mock.calls as [[number, string, unknown]];
    expect(statusText).not.toContain('Prior excerpt');
    expect(statusText).not.toContain('💬');
  });
});
