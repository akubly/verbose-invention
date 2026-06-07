import { Bot, type Context } from 'grammy';
import type {
  ChannelPort,
  ChannelCapabilities,
  ChannelContext,
  MessageRef,
  PromptOption,
  MessageHandler,
  CommandHandler,
} from '../port.js';
import { registerChannel } from '../registry.js';
import { escapeMarkdownV2 } from '../../relay/markdownV2.js';
import { splitForTelegram } from '../../relay/messageSplitter.js';
import {
  promptUserForPermission,
  ensurePromptRegistry,
} from '../../bot/prompt.js';

// ── MarkdownV2 split budget ──────────────────────────────────────────────────
// Worst-case MarkdownV2 escape doubles size; 2048 effective max keeps chunks
// within Telegram's 4096-char limit even for 100%-special-char content.
const MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048;
const MAX_CHUNKS = 25;

// ── Parse-entities error detection ──────────────────────────────────────────
function isParseEntitiesError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't parse entities") || msg.includes('parse entities');
}

export class TelegramChannel implements ChannelPort {
  readonly name = 'telegram';

  readonly capabilities: ChannelCapabilities = {
    supportsMessageEdit: true,
    supportsThreadCreation: true,
    supportsInteractivePrompts: true,
    supportsStreaming: true,
    maxMessageLength: 4096,
  };

  private messageHandler: MessageHandler | undefined;
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private messageInterceptor?: (ctx: Context) => Promise<boolean>;
  /** Sessions that have already logged a MarkdownV2 rejection (log once per channel). */
  private readonly md2WarnedSessions = new Set<string>();

  constructor(
    readonly bot: Bot<Context>,
    private readonly allowedChatId: number,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Install prompt registry for interactive permission prompts.
    ensurePromptRegistry(this.bot);

    // Guard: ignore messages from groups other than the configured chat.
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.id !== this.allowedChatId) return;
      await next();
    });

    // Wire inbound text messages → onMessage handler.
    this.bot.on('message:text', async (ctx) => {
      if (this.messageInterceptor && await this.messageInterceptor(ctx)) return;
      const topicId = ctx.message.message_thread_id;
      const text = ctx.message.text;
      if (!topicId || !text) return;
      if (this.messageHandler) {
        const channelCtx: ChannelContext = {
          threadId: String(topicId),
          channelId: String(ctx.chat.id),
        };
        await this.messageHandler(channelCtx, text);
      }
    });

    // Wire inbound commands → onCommand handlers.
    for (const [cmd, handler] of this.commandHandlers) {
      this.bot.command(cmd, async (ctx) => {
        const topicId = ctx.message?.message_thread_id;
        const channelCtx: ChannelContext = {
          threadId: topicId !== undefined ? String(topicId) : '',
          channelId: String(ctx.chat?.id ?? this.allowedChatId),
        };
        await handler(channelCtx, (ctx.match as string | undefined)?.trim() ?? '');
      });
    }

    this.bot.catch((err) => {
      console.error('[bot] Unhandled error:', err.message, err.error);
    });

    await this.bot.start({ allowed_updates: ['message', 'edited_message', 'callback_query'] });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  async sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef> {
    const chatId = Number(ctx.channelId);
    const topicId = ctx.threadId ? Number(ctx.threadId) : undefined;
    const opts = topicId !== undefined ? { message_thread_id: topicId } : undefined;
    const sent = await this.bot.api.sendMessage(chatId, text, opts);
    return { id: String(sent.message_id) };
  }

  async editMessage(ctx: ChannelContext, ref: MessageRef, text: string): Promise<boolean> {
    const chatId = Number(ctx.channelId);
    const messageId = Number(ref.id);
    try {
      await this.bot.api.editMessageText(chatId, messageId, text);
      return true;
    } catch (err) {
      console.warn(`[telegram] editMessageText failed (chat=${chatId}, msg=${messageId}):`, err);
      return false;
    }
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /**
   * Convert raw text to Telegram MarkdownV2 format.
   * Delegates to the existing escapeMarkdownV2 utility (zero behavior change).
   */
  formatForTransport(markdown: string): string {
    return escapeMarkdownV2(markdown);
  }

  /**
   * Split a message into Telegram-safe MarkdownV2 chunks.
   * Uses effectiveMaxLen=2048 to account for worst-case escape expansion,
   * numbered chunks, and a 25-chunk cap — identical to the pre-refactor relay.
   */
  splitMessage(text: string, footer?: string): string[] {
    const opts = footer !== undefined
      ? { footer, numbering: true as const, effectiveMaxLen: MARKDOWN_ESCAPE_EFFECTIVE_MAX, maxChunks: MAX_CHUNKS }
      : { numbering: true as const, effectiveMaxLen: MARKDOWN_ESCAPE_EFFECTIVE_MAX, maxChunks: MAX_CHUNKS };
    return splitForTelegram(text, opts);
  }

  // ── Interactive Prompts ────────────────────────────────────────────────────

  /**
   * Prompt the user with an inline keyboard (approve/deny).
   * Delegates to the existing promptUserForPermission utility.
   * Returns 'approve' or 'deny'.
   */
  async promptUser(
    ctx: ChannelContext,
    question: string,
    options: readonly PromptOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    const chatId = Number(ctx.channelId);
    const topicId = Number(ctx.threadId);
    // Extract tool name from question for the result text (best-effort).
    const toolMatch = /Tool:\s*(\S+)/.exec(question);
    const toolName = toolMatch?.[1] ?? 'unknown';
    // Map options to approve/deny semantics expected by promptUserForPermission.
    const approved = await promptUserForPermission(
      this.bot,
      chatId,
      topicId,
      toolName,
      question,
      signal,
    );
    return approved ? (options.find((o) => o.value === 'approve')?.value ?? 'approve') : 'deny';
  }

  // ── Thread Management ──────────────────────────────────────────────────────

  /**
   * Create a new forum topic in the Telegram supergroup.
   */
  async createThread(channelId: string, title: string): Promise<ChannelContext> {
    const chatId = Number(channelId);
    const created = await this.bot.api.createForumTopic(chatId, title);
    return {
      threadId: String(created.message_thread_id),
      channelId,
    };
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  setMessageInterceptor(fn: (ctx: Context) => Promise<boolean>): void {
    this.messageInterceptor = fn;
  }

  // ── MarkdownV2 edit with plain-text fallback ───────────────────────────────

  /**
   * Edit a message, attempting MarkdownV2 first and falling back to plain text
   * on parse-entities errors. Used by the relay for final (formatted) edits.
   */
  async editMessageWithMarkdown(
    ctx: ChannelContext,
    ref: MessageRef,
    text: string,
    sessionLabel = '',
  ): Promise<boolean> {
    const chatId = Number(ctx.channelId);
    const messageId = Number(ref.id);
    try {
      try {
        await this.bot.api.editMessageText(chatId, messageId, escapeMarkdownV2(text), {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        if (!isParseEntitiesError(err)) throw err;
        if (sessionLabel && !this.md2WarnedSessions.has(sessionLabel)) {
          this.md2WarnedSessions.add(sessionLabel);
          console.warn(`[telegram] MarkdownV2 rejected for session "${sessionLabel}" — falling back to plain text`);
        }
        await this.bot.api.editMessageText(chatId, messageId, text);
      }
      return true;
    } catch (editErr) {
      console.warn(`[telegram] editMessageText failed (chat=${chatId}, msg=${messageId}):`, editErr);
      return false;
    }
  }

  /**
   * Send a message, attempting MarkdownV2 first and falling back to plain text
   * on parse-entities errors. Used by the relay for follow-up formatted chunks.
   */
  async sendMessageWithMarkdown(
    ctx: ChannelContext,
    text: string,
    sessionLabel = '',
  ): Promise<MessageRef | null> {
    const chatId = Number(ctx.channelId);
    const topicId = Number(ctx.threadId);
    try {
      let sent;
      try {
        sent = await this.bot.api.sendMessage(chatId, escapeMarkdownV2(text), {
          message_thread_id: topicId,
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        if (!isParseEntitiesError(err)) throw err;
        if (sessionLabel && !this.md2WarnedSessions.has(sessionLabel)) {
          this.md2WarnedSessions.add(sessionLabel);
          console.warn(`[telegram] MarkdownV2 rejected for session "${sessionLabel}" — falling back to plain text`);
        }
        sent = await this.bot.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
        });
      }
      return { id: String(sent.message_id) };
    } catch (sendErr) {
      console.warn(`[telegram] sendMessage failed (chat=${chatId}, topic=${topicId}):`, sendErr);
      return null;
    }
  }
}

// ── Self-registration ──────────────────────────────────────────────────────

registerChannel('telegram', () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('[telegram] TELEGRAM_BOT_TOKEN is required to create the telegram channel');
  }
  const rawChatId = process.env.TELEGRAM_CHAT_ID;
  const chatId = rawChatId ? Number(rawChatId) : 0;

  return new TelegramChannel(new Bot(token), chatId);
});
