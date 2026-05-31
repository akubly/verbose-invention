/**
 * AfkModeController — slash guard behaviour (Phase 9 Item 2).
 *
 * Anticipatory tests for the guard change in src/bot/afkMode.ts:
 *   BEFORE Carter:  if (text.startsWith('/')) return false;
 *   AFTER Carter:   if (isBotCommand(text)) return false;
 *
 * RED tests (awaiting Carter):
 *   - CLI commands (/clear, /agent, /model) currently return false;
 *     after Carter they must return true and reach mirror.input.
 *   - /unknowncommand currently returns false; after Carter it must pass through.
 *
 * GREEN tests (stable before and after Carter):
 *   - Bot commands (/new, /list, /help) must always return false.
 *   - Plain text must always reach mirror.input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AfkModeController } from '../../src/bot/afkMode.js';
import type { AfkBridgePort } from '../../src/bot/afkBridgePort.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ── constants ────────────────────────────────────────────────────────────────

const CHAT_ID = -1001234567890;
const TOPIC_ID = 42;
const SESSION_ID = 'sess-1';
const USER_ID = 99;

// ── minimal test doubles ─────────────────────────────────────────────────────

function makeMockBridge(): AfkBridgePort {
  return {
    on: vi.fn(),
    sendToSession: vi.fn(),
    broadcastToSessions: vi.fn(),
    listSessions: vi.fn(() => []),
    getSessionInfo: vi.fn((sessionId: string) => {
      if (sessionId === SESSION_ID) {
        return { sessionId: SESSION_ID, sessionName: 'reach-myapp', cwd: 'D:\\git\\verbose-invention' };
      }
      return undefined;
    }),
    setRegistrationAugmenter: vi.fn(),
  } as unknown as AfkBridgePort;
}

function makeMockBot() {
  return {
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    },
  };
}

/**
 * Builds an AfkModeController already in active mode with SESSION_ID bound to TOPIC_ID.
 * Uses forTesting() to seed state without going through the full activation flow.
 */
function makeActiveController(bridge: AfkBridgePort, registry: ISessionRegistry): AfkModeController {
  return AfkModeController.forTesting(
    {
      bot: makeMockBot() as any,
      bridge,
      registry,
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

/** Builds a minimal grammY Context double for handleTelegramMessage. */
function makeCtx(text: string, topicId = TOPIC_ID, chatId = CHAT_ID, fromId = USER_ID) {
  return {
    message: { message_thread_id: topicId, text },
    chat: { id: chatId },
    from: { id: fromId },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AfkModeController.handleTelegramMessage — slash guard', () => {
  let bridge: ReturnType<typeof makeMockBridge>;
  let registry: ISessionRegistry;
  let controller: AfkModeController;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = makeMockBridge();
    registry = makeStubRegistry();
    controller = makeActiveController(bridge, registry);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── bot commands → return false (AFK does NOT consume; bot handler gets it) ──

  it('bot command /new → returns false (falls through to bot handler)', async () => {
    // Stable: returns false before Carter (blanket /) and after (isBotCommand)
    const result = await controller.handleTelegramMessage(makeCtx('/new') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  it('bot command /list → returns false', async () => {
    const result = await controller.handleTelegramMessage(makeCtx('/list') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  it('bot command /help → returns false', async () => {
    const result = await controller.handleTelegramMessage(makeCtx('/help') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  it('bot command /remove → returns false', async () => {
    const result = await controller.handleTelegramMessage(makeCtx('/remove') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  it('bot command /resume → returns false', async () => {
    const result = await controller.handleTelegramMessage(makeCtx('/resume') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  // ── CLI commands → return true and forward via mirror.input (RED until Carter) ──

  it('CLI command /clear → AFK handler consumes and returns true', async () => {
    // RED until Carter: currently the blanket / guard returns false for /clear.
    // After Carter: isBotCommand('/clear') = false → does NOT return false → processes → returns true.
    const result = await controller.handleTelegramMessage(makeCtx('/clear') as any);
    expect(result).toBe(true);
  });

  it('/clear is forwarded verbatim as mirror.input text', async () => {
    // RED until Carter.
    await controller.handleTelegramMessage(makeCtx('/clear') as any);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        type: 'mirror.input',
        text: '/clear',
        sessionId: SESSION_ID,
        topicId: TOPIC_ID,
      }),
    );
  });

  it('CLI command /agent → consumes and returns true', async () => {
    // RED until Carter.
    const result = await controller.handleTelegramMessage(makeCtx('/agent') as any);
    expect(result).toBe(true);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: '/agent' }),
    );
  });

  it('CLI command /model → consumes and returns true', async () => {
    // RED until Carter.
    const result = await controller.handleTelegramMessage(makeCtx('/model') as any);
    expect(result).toBe(true);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: '/model' }),
    );
  });

  it('/unknowncommand → consumed and forwarded (unknown = not a bot command = CLI)', async () => {
    // RED until Carter: currently blocked by blanket /; after Carter passes through.
    const result = await controller.handleTelegramMessage(makeCtx('/unknowncommand') as any);
    expect(result).toBe(true);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: '/unknowncommand' }),
    );
  });

  // ── spoofed bot-looking commands → pass through (not exact matches) ─────────

  it('/newxyz → consumed and forwarded (not exact match for /new)', async () => {
    // RED until Carter: currently blocked; after Carter "newxyz" ∉ BOT_COMMANDS → passes through.
    const result = await controller.handleTelegramMessage(makeCtx('/newxyz') as any);
    expect(result).toBe(true);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: '/newxyz' }),
    );
  });

  // ── plain text (regression: existing behavior must be preserved) ─────────────

  it('plain text in AFK topic → returns true and forwarded via mirror.input (regression)', async () => {
    // GREEN before and after Carter — plain text has never been blocked.
    const result = await controller.handleTelegramMessage(makeCtx('hello world') as any);
    expect(result).toBe(true);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: 'hello world', sessionId: SESSION_ID }),
    );
  });

  it('multi-word plain text → forwarded verbatim', async () => {
    await controller.handleTelegramMessage(makeCtx('build the parser please') as any);
    expect(bridge.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'mirror.input', text: 'build the parser please' }),
    );
  });

  // ── inactive mode guard (unchanged) ─────────────────────────────────────────

  it('message while AFK inactive → returns false without touching bridge (regression)', async () => {
    const inactiveController = AfkModeController.forTesting(
      { bot: makeMockBot() as any, bridge, registry, chatId: CHAT_ID, delay: async () => undefined },
      { mode: { active: false, since: '' } },
    );
    const result = await inactiveController.handleTelegramMessage(makeCtx('hello') as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });

  // ── wrong chat ID guard (unchanged) ─────────────────────────────────────────

  it('message from wrong chatId → returns false (security guard regression)', async () => {
    const result = await controller.handleTelegramMessage(makeCtx('hello', TOPIC_ID, -9999999) as any);
    expect(result).toBe(false);
    expect(bridge.sendToSession).not.toHaveBeenCalled();
  });
});
