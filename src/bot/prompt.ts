import { randomUUID } from 'node:crypto';
import type { Bot, Context } from 'grammy';

type PromptAction = 'approve' | 'deny';
/** ADR-9: 'timeout' renamed to 'aborted' — automatic resolution is disconnect-driven, not timer-driven. */
type PromptOutcome = PromptAction | 'aborted';

const TEN_MINUTES_MS = 10 * 60 * 1000;

interface PendingPrompt {
  chatId: number;
  messageId: number;
  /** Unix ms when this prompt was registered — used by the passive stale-prompt scanner. */
  createdAt: number;
  complete: (outcome: PromptOutcome, ctx?: Context) => Promise<void>;
}

interface PromptRegistry {
  pendingByRequestId: Map<string, PendingPrompt>;
  scanHandle: ReturnType<typeof setInterval>;
}

const promptRegistries = new WeakMap<Bot<Context>, PromptRegistry>();
/**
 * Tracks bots that already have the `callback_query:data` listener attached.
 * The listener is installed at most once per bot lifetime and looks up the
 * current registry via `promptRegistries.get(bot)` at callback time, so
 * disposing and recreating a registry does NOT add a second listener.
 */
const handlerInstalled = new WeakSet<Bot<Context>>();

function truncateArgs(args: string, maxLength = 200): string {
  if (args.length <= maxLength) {
    return args;
  }

  return `${args.slice(0, maxLength - 3)}...`;
}

function formatOutcomeText(outcome: PromptOutcome, toolName: string): string {
  if (outcome === 'approve') {
    return `✅ Approved: ${toolName}`;
  }

  if (outcome === 'deny') {
    return `❌ Denied: ${toolName}`;
  }

  return `⚠️ Aborted: ${toolName}`;
}

export function ensurePromptRegistry(bot: Bot<Context>): PromptRegistry {
  const existing = promptRegistries.get(bot);
  if (existing) {
    return existing;
  }

  const pendingByRequestId = new Map<string, PendingPrompt>();

  // Passive stale-prompt warning scanner (ADR-9 observability).
  // Emits a warning for prompts open >10 minutes. Does NOT resolve them.
  const scanHandle = setInterval(() => {
    const now = Date.now();
    for (const [reqId, pending] of pendingByRequestId) {
      if (now - pending.createdAt > TEN_MINUTES_MS) {
        console.warn(`[prompt] Permission prompt ${reqId} has been open for >10 minutes`);
      }
    }
  }, TEN_MINUTES_MS);
  // Do not prevent process exit while waiting for user taps.
  scanHandle.unref();

  const registry: PromptRegistry = { pendingByRequestId, scanHandle };
  promptRegistries.set(bot, registry);

  // Install the callback_query:data listener at most once per bot lifetime.
  // The handler resolves the current registry via promptRegistries.get(bot)
  // on every callback, so a dispose-then-recreate cycle reuses the same
  // listener with the fresh registry — no duplicate handlers, no closure
  // over a stale registry.
  if (!handlerInstalled.has(bot)) {
    handlerInstalled.add(bot);
    bot.on('callback_query:data', async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('perm:')) {
        await next();
        return;
      }

      const match = /^perm:(approve|deny):(.+)$/.exec(data);
      const action = match?.[1];
      const requestId = match?.[2];
      if (!requestId || (action !== 'approve' && action !== 'deny')) {
        await next();
        return;
      }

      const currentRegistry = promptRegistries.get(bot);
      const pending = currentRegistry?.pendingByRequestId.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'This permission prompt is no longer active.' });
        return;
      }

      const callbackChatId = ctx.chat?.id;
      const callbackMessageId = ctx.callbackQuery.message?.message_id;
      if (callbackChatId !== pending.chatId || callbackMessageId !== pending.messageId) {
        await ctx.answerCallbackQuery({ text: 'This permission prompt is not active here.' });
        return;
      }

      await pending.complete(action, ctx);
    });
  }

  return registry;
}

/**
 * Clear the stale-prompt scanner and remove the registry for `bot`.
 * Call during bot shutdown or in test teardown to avoid timer accumulation.
 */
export function disposePromptRegistry(bot: Bot<Context>): void {
  const registry = promptRegistries.get(bot);
  if (registry) {
    clearInterval(registry.scanHandle);
    promptRegistries.delete(bot);
  }
}

/**
 * Send an inline keyboard prompt to approve/deny a tool execution.
 * Waits indefinitely for an explicit user decision (ADR-9 §7: no wall-clock timeout).
 * Returns true if approved, false if denied or aborted.
 *
 * @param signal - When fired (e.g., session disconnect), the prompt resolves false
 *   immediately without waiting for user input. ADR-9 Q3/Q4.
 */
export async function promptUserForPermission(
  bot: Bot<Context>,
  chatId: number,
  topicId: number | undefined,
  toolName: string,
  args: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const registry = ensurePromptRegistry(bot);
  const requestId = randomUUID();
  const promptText = `⚠️ Tool approval needed\n\nTool: ${toolName}\nArgs: ${truncateArgs(args)}\n\nApprove or deny — waiting for your decision.`;

  const promptMessage = await bot.api.sendMessage(chatId, promptText, {
    ...(topicId !== undefined && { message_thread_id: topicId }),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `perm:approve:${requestId}` },
        { text: '❌ Deny', callback_data: `perm:deny:${requestId}` },
      ]],
    },
  });

  let settled = false;
  let resolveResult: ((approved: boolean) => void) | undefined;
  let abortHandler: (() => void) | undefined;

  const resultPromise = new Promise<boolean>((resolve) => {
    resolveResult = resolve;
  });

  const complete = async (outcome: PromptOutcome, ctx?: Context): Promise<void> => {
    if (settled) {
      return;
    }

    settled = true;
    registry.pendingByRequestId.delete(requestId);

    // Remove the abort listener now that the prompt has settled (normal or abort path).
    // Prevents listener retention when the supplied signal outlives this prompt.
    if (abortHandler) {
      signal?.removeEventListener('abort', abortHandler);
      abortHandler = undefined;
    }

    const approved = outcome === 'approve';
    const statusText = formatOutcomeText(outcome, toolName);

    resolveResult?.(approved);

    const uiUpdates = [
      bot.api.editMessageText(chatId, promptMessage.message_id, statusText, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {}),
    ];

    const callbackQueryId = ctx?.callbackQuery?.id;
    if (callbackQueryId) {
      uiUpdates.unshift(bot.api.answerCallbackQuery(callbackQueryId).catch(() => {}));
    }

    void Promise.all(uiUpdates).catch(() => {});
  };

  registry.pendingByRequestId.set(requestId, {
    chatId,
    messageId: promptMessage.message_id,
    createdAt: Date.now(),
    complete,
  });

  // ADR-9 Q3: AbortSignal-driven abort on session disconnect (no setTimeout).
  if (signal) {
    if (signal.aborted) {
      void complete('aborted').catch(() => {});
    } else {
      abortHandler = () => {
        void complete('aborted').catch(() => {});
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // No timeout. No Promise.race. Just wait for user input (or abort signal).
  return resultPromise;
}

