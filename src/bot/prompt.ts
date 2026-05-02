import { randomUUID } from 'node:crypto';
import type { Bot, Context } from 'grammy';

type PromptAction = 'approve' | 'deny';
type PromptOutcome = PromptAction | 'timeout';

interface PendingPrompt {
  chatId: number;
  messageId: number;
  complete: (outcome: PromptOutcome, ctx?: Context) => Promise<void>;
}

interface PromptRegistry {
  pendingByRequestId: Map<string, PendingPrompt>;
}

const promptRegistries = new WeakMap<Bot<Context>, PromptRegistry>();

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

  return `⏰ Timed out: ${toolName} (denied)`;
}

function ensurePromptRegistry(bot: Bot<Context>): PromptRegistry {
  const existing = promptRegistries.get(bot);
  if (existing) {
    return existing;
  }

  const registry: PromptRegistry = {
    pendingByRequestId: new Map(),
  };

  promptRegistries.set(bot, registry);

  // One callback middleware per bot; individual prompts clean themselves up via the pending map.
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

    const pending = registry.pendingByRequestId.get(requestId);
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

  return registry;
}

/**
 * Send an inline keyboard prompt to approve/deny a tool execution.
 * Returns true if approved, false if denied or timed out.
 */
export async function promptUserForPermission(
  bot: Bot<Context>,
  chatId: number,
  topicId: number,
  toolName: string,
  args: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const registry = ensurePromptRegistry(bot);
  const requestId = randomUUID();
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const promptText = `⚠️ Tool approval needed\n\nTool: ${toolName}\nArgs: ${truncateArgs(args)}\n\nApprove or deny within ${timeoutSeconds} seconds.`;

  const promptMessage = await bot.api.sendMessage(chatId, promptText, {
    message_thread_id: topicId,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `perm:approve:${requestId}` },
        { text: '❌ Deny', callback_data: `perm:deny:${requestId}` },
      ]],
    },
  });

  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: ((approved: boolean) => void) | undefined;

  const resultPromise = new Promise<boolean>((resolve) => {
    resolveResult = resolve;
  });

  const complete = async (outcome: PromptOutcome, ctx?: Context): Promise<void> => {
    if (settled) {
      return;
    }

    settled = true;
    registry.pendingByRequestId.delete(requestId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
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
    complete,
  });

  const timeoutPromise = new Promise<boolean>((resolve) => {
    timeoutHandle = setTimeout(() => {
      void complete('timeout').then(() => resolve(false)).catch(() => {});
    }, timeoutMs);
  });

  return Promise.race([resultPromise, timeoutPromise]);
}
