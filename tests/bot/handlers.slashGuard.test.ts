/**
 * registerHandlers — slash command guard behaviour (Phase 9 Item 2).
 *
 * Verifies that the message:text handler in src/bot/handlers.ts uses
 * isBotCommand() to distinguish bot commands from CLI pass-through commands:
 *
 *   - Bot commands (/new, /list, /help, …) → message:text exits early; grammY
 *     routes them to their dedicated command handlers. No relay is triggered.
 *   - CLI commands (/clear, /agent, /model, /unknowncommand, …) → isBotCommand()
 *     returns false → message:text proceeds to relay.relay(ctx).
 *   - Plain text → always reaches relay (regression coverage).
 *
 * The blanket `startsWith('/')` guard that blocked all slash messages was
 * replaced by `isBotCommand()` in this PR (Phase 9 Item 2). handlers.test.ts
 * was updated in the same PR to use a real bot command (/list) in the
 * "ignores command messages" test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';
import { makeMockBot, makeMockCtx } from '../helpers/botMocks.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  topicId: 42,
  chatId: -1001234567890,
  createdAt: '2024-01-01T00:00:00.000Z',
} as SessionEntry;

// ── tests ────────────────────────────────────────────────────────────────────

describe('registerHandlers message:text — slash command guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── bot commands → message:text handler exits early (no relay) ─────────────

  it('bot command /new in topic → message:text exits early, relay not triggered', async () => {
    // Stable: /new exits early both before Carter (blanket /) and after (isBotCommand)
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = onHandlers.get('message:text')!;
    // B2 FIX: capture ctx BEFORE invoking the handler and assert on the SAME object.
    // Previously a fresh makeMockCtx() was created for the assertion — that new object
    // was never passed to the handler, making the expect() vacuously true.
    const ctx = makeMockCtx('/new test-name');
    await handler(ctx);

    // relay does not run → no placeholder reply
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('bot command /list in topic → message:text exits early', async () => {
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/list');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('bot command /help in topic → message:text exits early', async () => {
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/help');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  // ── CLI commands → relay is triggered ────────────────────────────────────

  it('/clear in topic → relay triggered, placeholder reply sent', async () => {
    // isBotCommand('/clear') = false → relay.relay(ctx) called.
    const session = makeMockSession(['/clear applied']);
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(session);
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/clear');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    // Relay sends placeholder '…' — proves the guard let /clear through
    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  it('/agent in topic → relay triggered', async () => {
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['agent info']));
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/agent');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  it('/model in topic → relay triggered', async () => {
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['model switched']));
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/model');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  it('/unknowncommand in topic → relay triggered (unknown = not a bot command = CLI)', async () => {
    // isBotCommand('/unknowncommand') = false → relay proceeds.
    //
    // handlers.test.ts was updated in this PR to use '/list' (a real bot command)
    // in the "ignores command messages" test, resolving the former test conflict.
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['ok']));
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/unknowncommand');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  it('/clear with args in topic → relay triggered', async () => {
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['cleared']));
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('/clear some args');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  // ── regression: plain text behavior unchanged ──────────────────────────────

  it('plain text in topic → relay triggered (regression, unchanged)', async () => {
    // GREEN before and after Carter.
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory(makeMockSession(['Response from Copilot']));
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const ctx = makeMockCtx('Build the parser');
    const handler = onHandlers.get('message:text')!;
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
  });

  it('non-topic message → ignored (no message_thread_id, regression)', async () => {
    // GREEN before and after Carter.
    const { bot, onHandlers } = makeMockBot();
    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = onHandlers.get('message:text')!;
    const ctx = {
      message: { text: '/clear' }, // no message_thread_id
      chat: { id: -1001234567890 },
      reply: vi.fn(),
      api: { editMessageText: vi.fn() },
    };
    await handler(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
