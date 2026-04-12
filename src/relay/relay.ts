import type { Context } from 'grammy';
import type { CopilotClient, CopilotSession } from '../types.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import { IdleMonitor } from '../idleMonitor.js';

/** Throttle Telegram message edits to stay within ~1/s rate limit. */
const STREAM_EDIT_THROTTLE_MS = 800;

export class Relay {
  /** In-memory cache of live SDK session handles, keyed by forum topic ID. */
  private activeSessions = new Map<number, CopilotSession>();
  private idleMonitor = new IdleMonitor();

  constructor(
    private readonly registry: ISessionRegistry,
    private readonly client: CopilotClient,
  ) {}

  async relay(ctx: Context): Promise<void> {
    const topicId = ctx.message?.message_thread_id;
    const userText = ctx.message?.text;

    if (!topicId || !userText) return;

    const entry = this.registry.resolve(topicId);
    if (!entry) {
      await ctx.reply(
        '⚠️ No session linked to this topic. Use /new <name> to create one.',
        { message_thread_id: topicId },
      );
      return;
    }

    let session = this.activeSessions.get(topicId);
    if (!session) {
      try {
        session = await this.client.resumeSession(entry.copilotSessionId);
        this.activeSessions.set(topicId, session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Could not resume session "${entry.name}": ${msg}`, {
          message_thread_id: topicId,
        });
        return;
      }
    }

    // Reset idle timer — evict cached session handle on inactivity
    this.idleMonitor.reset(topicId, () => {
      this.activeSessions.delete(topicId);
      console.log(`[relay] Session handle evicted (idle): topic ${topicId} → "${entry.name}"`);
    });

    const placeholder = await ctx.reply('…', { message_thread_id: topicId });

    let accumulated = '';
    let lastEditAt = 0;

    try {
      for await (const chunk of session.send(userText)) {
        accumulated += chunk.text;
        const now = Date.now();
        if (now - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
          await this.safeEdit(ctx, placeholder.chat.id, placeholder.message_id, accumulated);
          lastEditAt = now;
        }
      }

      // Final edit: full response with Markdown, fallback to plain text
      await this.safeEdit(
        ctx,
        placeholder.chat.id,
        placeholder.message_id,
        accumulated || '_(empty response)_',
        true,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Stream error on topic ${topicId}:`, err);
      this.activeSessions.delete(topicId); // evict — session may be stale
      await this.safeEdit(ctx, placeholder.chat.id, placeholder.message_id, `❌ Error: ${msg}`);
    }
  }

  private async safeEdit(
    ctx: Context,
    chatId: number,
    messageId: number,
    text: string,
    tryMarkdown = false,
  ): Promise<void> {
    try {
      if (tryMarkdown) {
        try {
          await ctx.api.editMessageText(chatId, messageId, text, { parse_mode: 'Markdown' });
          return;
        } catch {
          // Markdown rejected (likely malformed model output) — fall through to plain text
        }
      }
      await ctx.api.editMessageText(chatId, messageId, text);
    } catch (editErr) {
      console.warn(`[relay] editMessageText failed (chat=${chatId}, msg=${messageId}):`, editErr);
    }
  }

  /** Tear down all active sessions and timers (call on graceful shutdown). */
  dispose(): void {
    this.idleMonitor.cancelAll();
    this.activeSessions.clear();
  }
}
