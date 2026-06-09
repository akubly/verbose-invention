/**
 * TelegramChannel.promptUser — permission-prompt rendering regression tests.
 *
 * REGRESSION: Before this fix (PR #11 round-2), promptUser passed the entire
 * pre-formatted `question` string (already containing "Tool: …\nArgs: …") as the
 * `args` parameter to promptUserForPermission(). That function then re-wrapped it
 * inside another "Tool: …\nArgs: …" template, so users saw doubled headers:
 *
 *   ⚠️ Tool approval needed
 *   Tool: read_file
 *   Args: ⚠️ Tool approval needed        ← doubled!
 *   Tool: read_file                       ← doubled!
 *   Args: src/foo.ts
 *   Approve or deny…
 *   Approve or deny…                      ← doubled!
 *
 * Fix: promptUser now calls promptUserVerbatim(), which sends question verbatim
 * without any re-templating. The message body the user sees is exactly the string
 * Relay constructed — no duplication.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../../../src/channel/telegram/index.js';
import { disposePromptRegistry } from '../../../src/bot/prompt.js';
import type { ChannelContext, PromptOption } from '../../../src/channel/port.js';

// ── Mock grammY Bot ──────────────────────────────────────────────────────────
// Mirrors the mock in tests/bot/prompt.test.ts so the callback routing is
// identical (same bot.on / callbackHandlers dispatch mechanism).

type CallbackHandler = (ctx: any) => unknown;

function matchesPattern(pattern: RegExp | string | undefined, data: string): boolean {
  if (!pattern) return true;
  if (typeof pattern === 'string') return pattern === data;
  return pattern.test(data);
}

function makeMockBot() {
  const callbackHandlers: Array<{ pattern?: RegExp | string; handler: CallbackHandler }> = [];
  let sentMessage: { message_id: number; chat: { id: number }; message_thread_id?: number } | null = null;

  const sendMessage = vi.fn(async (chatId: number, _text: string, opts?: Record<string, any>) => {
    sentMessage = {
      message_id: 777,
      chat: { id: chatId },
      ...(opts?.message_thread_id !== undefined
        ? { message_thread_id: opts.message_thread_id as number }
        : {}),
    };
    return sentMessage;
  });

  const editMessageText = vi.fn().mockResolvedValue({ ok: true });

  const bot: any = {
    api: { sendMessage, editMessageText },
    callbackQuery: vi.fn((patternOrHandler: RegExp | string | CallbackHandler, maybeHandler?: CallbackHandler) => {
      if (typeof maybeHandler === 'function') {
        callbackHandlers.push({ pattern: patternOrHandler as RegExp | string, handler: maybeHandler });
      } else {
        callbackHandlers.push({ handler: patternOrHandler as CallbackHandler });
      }
    }),
    on: vi.fn((event: string, handler: CallbackHandler) => {
      if (event === 'callback_query:data') {
        callbackHandlers.push({ handler });
      }
    }),
    use: vi.fn(),
    command: vi.fn(),
    catch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  async function click(data: string) {
    const entry = callbackHandlers.find((candidate) => matchesPattern(candidate.pattern, data));
    if (!entry) throw new Error(`No callback handler registered for ${data}`);

    const callbackCtx: any = {
      callbackQuery: {
        data,
        // Note: callbackQuery.id is deliberately omitted so complete() skips
        // answerCallbackQuery — matches prompt.test.ts convention.
        message: sentMessage
          ? {
              message_id: sentMessage.message_id,
              chat: sentMessage.chat,
              ...(sentMessage.message_thread_id !== undefined
                ? { message_thread_id: sentMessage.message_thread_id }
                : {}),
            }
          : undefined,
      },
      chat: sentMessage?.chat,
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    await entry.handler(callbackCtx);
    return callbackCtx;
  }

  return { bot, sendMessage, editMessageText, callbackHandlers, click };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function getButtonData(sendMessage: ReturnType<typeof vi.fn>) {
  const opts = sendMessage.mock.calls[0]?.[2] as Record<string, any> | undefined;
  const kb = opts?.reply_markup?.inline_keyboard as Array<Array<{ callback_data: string }>> | undefined;
  return (kb ?? []).flat().map((b) => b.callback_data);
}

const CHAT_ID = -1001234567890;

const DEFAULT_OPTIONS: readonly PromptOption[] = [
  { value: 'approve', label: '✅ Approve' },
  { value: 'deny', label: '❌ Deny' },
];

/** The pre-formatted question string that Relay passes to channel.promptUser. */
const RELAY_QUESTION =
  '⚠️ Tool approval needed\n\nTool: read_file\nArgs: src/foo.ts\n\nApprove or deny — waiting for your decision.';

function makeCtx(threadId = '42'): ChannelContext {
  return { threadId, channelId: String(CHAT_ID) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TelegramChannel.promptUser — verbatim rendering (PR #11 round-2 regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the question verbatim — does NOT re-wrap it inside a second "Args:" header', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx(), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    expect(sendMessage).toHaveBeenCalledOnce();
    const sentText = String(sendMessage.mock.calls[0]?.[1] ?? '');

    // The verbatim question must be the message body — no doubled headers.
    expect(sentText).toBe(RELAY_QUESTION);

    // "Args:" must appear exactly once (from the Relay-formatted question only).
    const argsCount = (sentText.match(/Args:/g) ?? []).length;
    expect(argsCount).toBe(1);

    // Settle the prompt.
    const denyData = getButtonData(sendMessage).find((d) => /^perm:deny:/.test(d))!;
    expect(denyData).toBeTruthy();
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });

  it('returns "approve" when the user taps ✅ Approve', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx(), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    const approveData = getButtonData(sendMessage).find((d) => /^perm:approve:/.test(d))!;
    expect(approveData).toBeTruthy();
    await click(approveData);
    await expect(promptPromise).resolves.toBe('approve');

    disposePromptRegistry(bot);
  });

  it('returns "deny" when the user taps ❌ Deny', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx(), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    const denyData = getButtonData(sendMessage).find((d) => /^perm:deny:/.test(d))!;
    expect(denyData).toBeTruthy();
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });

  it('returns "deny" (not throw) when AbortSignal fires before user taps', async () => {
    const { bot, editMessageText } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);
    const ac = new AbortController();

    const promptPromise = ch.promptUser(makeCtx(), RELAY_QUESTION, DEFAULT_OPTIONS, ac.signal);
    await flushMicrotasks();

    ac.abort();
    await flushMicrotasks();

    await expect(promptPromise).resolves.toBe('deny');
    expect(editMessageText).toHaveBeenCalled();
    expect(String(editMessageText.mock.calls.at(-1)?.[2] ?? '')).toMatch(/aborted/i);

    disposePromptRegistry(bot);
  });

  it('sends to the correct Telegram topic (message_thread_id) when threadId is set', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx('99'), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );

    const denyData = getButtonData(sendMessage).find((d) => /^perm:deny:/.test(d))!;
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });

  it('omits message_thread_id when threadId is empty (General Topic)', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx(''), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    const opts = sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(opts?.['message_thread_id']).toBeUndefined();

    const denyData = getButtonData(sendMessage).find((d) => /^perm:deny:/.test(d))!;
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });

  it('omits message_thread_id when threadId is non-numeric (NaN guard)', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx('not-a-number'), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    const opts = sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    // NaN must be coerced to undefined — message_thread_id must be absent, not NaN.
    expect(opts?.['message_thread_id']).toBeUndefined();

    const denyData = getButtonData(sendMessage).find((d) => /^perm:deny:/.test(d))!;
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });

  it('inline keyboard has exactly perm:approve:{id} and perm:deny:{id} buttons', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const ch = new TelegramChannel(bot, CHAT_ID);

    const promptPromise = ch.promptUser(makeCtx(), RELAY_QUESTION, DEFAULT_OPTIONS);
    await flushMicrotasks();

    const buttonData = getButtonData(sendMessage);
    expect(buttonData).toHaveLength(2);
    expect(buttonData.some((d) => /^perm:approve:/.test(d))).toBe(true);
    expect(buttonData.some((d) => /^perm:deny:/.test(d))).toBe(true);

    // Both buttons share the same requestId (UUID).
    const approveId = buttonData.find((d) => /^perm:approve:/.test(d))?.split(':')[2];
    const denyId = buttonData.find((d) => /^perm:deny:/.test(d))?.split(':')[2];
    expect(approveId).toBeTruthy();
    expect(denyId).toBe(approveId);

    const denyData = buttonData.find((d) => /^perm:deny:/.test(d))!;
    await click(denyData);
    await expect(promptPromise).resolves.toBe('deny');

    disposePromptRegistry(bot);
  });
});
