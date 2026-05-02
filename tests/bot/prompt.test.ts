import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptUserForPermission } from '../../src/bot/prompt.js';

type PromptOverrides = {
  chatId?: number;
  topicId?: number;
  toolName?: string;
  args?: string;
  timeoutMs?: number;
};

type CallbackHandler = (ctx: any) => unknown;

function matchesPattern(pattern: RegExp | string | undefined, data: string): boolean {
  if (!pattern) return true;
  if (typeof pattern === 'string') return pattern === data;
  return pattern.test(data);
}

function makeMockBot() {
  const callbackHandlers: Array<{ pattern?: RegExp | string; handler: CallbackHandler }> = [];
  let sentMessage: { message_id: number; chat: { id: number }; message_thread_id?: number } | null = null;

  const sendMessage = vi.fn(async (chatId: number, _text: string, options?: Record<string, any>) => {
    sentMessage = {
      message_id: 777,
      chat: { id: chatId },
      ...(options?.message_thread_id !== undefined
        ? { message_thread_id: options.message_thread_id as number }
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
  };

  async function click(data: string) {
    const entry = callbackHandlers.find((candidate) => matchesPattern(candidate.pattern, data));
    if (!entry) {
      throw new Error(`No callback handler registered for ${data}`);
    }

    const callbackCtx: any = {
      callbackQuery: {
        data,
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
      update: {
        callback_query: {
          data,
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
      },
      chat: sentMessage?.chat,
      msg: sentMessage
        ? {
            message_id: sentMessage.message_id,
            chat: sentMessage.chat,
            ...(sentMessage.message_thread_id !== undefined
              ? { message_thread_id: sentMessage.message_thread_id }
              : {}),
          }
        : undefined,
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      api: { editMessageText },
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    };

    if (entry.pattern instanceof RegExp) {
      callbackCtx.match = data.match(entry.pattern);
    }

    await entry.handler(callbackCtx);
    return callbackCtx;
  }

  return { bot, sendMessage, editMessageText, callbackHandlers, click };
}

function getKeyboardRows(sendMessage: ReturnType<typeof vi.fn>) {
  const options = sendMessage.mock.calls[0]?.[2] as Record<string, any> | undefined;
  const replyMarkup = options?.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined;
  return replyMarkup?.inline_keyboard ?? [];
}

function getButtonData(sendMessage: ReturnType<typeof vi.fn>) {
  return getKeyboardRows(sendMessage)
    .flat()
    .map((button) => button.callback_data);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function invokePrompt(bot: any, overrides: PromptOverrides = {}) {
  const args = {
    chatId: -1001234567890,
    topicId: 42,
    toolName: 'powershell',
    args: 'Get-ChildItem src',
    timeoutMs: 30_000,
    ...overrides,
  };

  return promptUserForPermission(
    bot,
    args.chatId,
    args.topicId,
    args.toolName,
    args.args,
    args.timeoutMs,
  );
}

describe('promptUserForPermission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns true when the user approves the prompt', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const decision = invokePrompt(bot);
    await flushMicrotasks();

    expect(sendMessage).toHaveBeenCalledOnce();

    const approveData = getButtonData(sendMessage).find((value) => /^perm:approve:/.test(value));
    expect(approveData).toBeTruthy();

    await click(approveData!);
    await expect(decision).resolves.toBe(true);
  });

  it('returns false when the user denies the prompt', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const decision = invokePrompt(bot);
    await flushMicrotasks();

    const denyData = getButtonData(sendMessage).find((value) => /^perm:deny:/.test(value));
    expect(denyData).toBeTruthy();

    await click(denyData!);
    await expect(decision).resolves.toBe(false);
  });

  it('times out to false and updates the message', async () => {
    const { bot, editMessageText } = makeMockBot();
    const decision = invokePrompt(bot, { timeoutMs: 5_000 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(decision).resolves.toBe(false);
    expect(editMessageText).toHaveBeenCalled();
    expect(String(editMessageText.mock.calls.at(-1)?.[2] ?? '')).toMatch(/timed?\s*out|timeout/i);
  });

  it('truncates long args in the prompt message', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const longArgs = 'x'.repeat(260);
    const decision = invokePrompt(bot, { args: longArgs });
    await flushMicrotasks();

    const promptText = String(sendMessage.mock.calls[0]?.[1] ?? '');
    expect(promptText).toContain('Tool: powershell');
    expect(promptText).toContain(longArgs.slice(0, 197));
    expect(promptText).not.toContain(longArgs);

    const denyData = getButtonData(sendMessage).find((value) => /^perm:deny:/.test(value));
    await click(denyData!);
    await expect(decision).resolves.toBe(false);
  });

  it('sends the prompt to the requested Telegram topic', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const decision = invokePrompt(bot, { topicId: 99 });
    await flushMicrotasks();

    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );

    const denyData = getButtonData(sendMessage).find((value) => /^perm:deny:/.test(value));
    await click(denyData!);
    await expect(decision).resolves.toBe(false);
  });

  it('uses perm:approve:{id} and perm:deny:{id} callback_data values', async () => {
    const { bot, sendMessage, click } = makeMockBot();
    const decision = invokePrompt(bot);
    await flushMicrotasks();

    const callbackData = getButtonData(sendMessage);
    expect(callbackData).toHaveLength(2);

    const approveData = callbackData.find((value) => /^perm:approve:/.test(value));
    const denyData = callbackData.find((value) => /^perm:deny:/.test(value));
    expect(approveData).toBeTruthy();
    expect(denyData).toBeTruthy();
    expect(approveData?.split(':')[2]).toBeTruthy();
    expect(denyData?.split(':')[2]).toBe(approveData?.split(':')[2]);

    await click(denyData!);
    await expect(decision).resolves.toBe(false);
  });
});
