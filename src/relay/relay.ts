import type { Bot, Context } from 'grammy';
import type { CopilotSessionFactory, CopilotSession } from '../copilot/factory.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import { IdleMonitor } from '../idleMonitor.js';
import { StreamTimeoutError } from '../copilot/impl.js';

const PERMISSION_PROMPT_MODULE = '../bot/prompt.js';

type PermissionPolicy = 'approveAll' | 'denyAll' | 'interactiveDestructive';
type PermissionPromptCallback = (toolName: string, args: string) => Promise<boolean>;
type PermissionAwareFactory = CopilotSessionFactory & {
  resume(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null>;
  create(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession>;
};

/** Throttle Telegram message edits to stay within ~1/s rate limit. */
const STREAM_EDIT_THROTTLE_MS = 800;

export class Relay {
  /** In-memory cache of live SDK session handles, keyed by forum topic ID. */
  private activeSessions = new Map<number, { sessionName: string; session: CopilotSession }>();
  private idleMonitor = new IdleMonitor();

  constructor(
    private readonly registry: ISessionRegistry,
    private readonly factory: CopilotSessionFactory,
    private readonly globalModel: string,
    private readonly bot?: Bot,
    private readonly permissionPolicy?: PermissionPolicy,
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

    const cached = this.activeSessions.get(topicId);
    let session = cached?.session;

    // Evict stale cache: if the topic was re-linked to a different session name
    // (e.g. /remove then /new), the cached handle is for the wrong session.
    if (cached && cached.sessionName !== entry.sessionName) {
      this.activeSessions.delete(topicId);
      session = undefined;
    }

    if (!session) {
      try {
        let permissionCallback: PermissionPromptCallback | undefined;
        if (this.permissionPolicy === 'interactiveDestructive' && this.bot) {
          const chatId = ctx.chat!.id;
          const { promptUserForPermission } = await import(PERMISSION_PROMPT_MODULE);
          permissionCallback = (toolName: string, args: string) =>
            promptUserForPermission(this.bot!, chatId, topicId, toolName, args);
        }

        if (permissionCallback) {
          const permissionAwareFactory = this.factory as PermissionAwareFactory;
          session = await permissionAwareFactory.resume(entry.sessionName, entry.model, permissionCallback)
            ?? await permissionAwareFactory.create(entry.sessionName, entry.model, permissionCallback);
        } else {
          session = await this.factory.resume(entry.sessionName, entry.model)
            ?? await this.factory.create(entry.sessionName, entry.model);
        }

        this.activeSessions.set(topicId, { sessionName: entry.sessionName, session });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Could not open session "${entry.sessionName}": ${msg}`, {
          message_thread_id: topicId,
        });
        return;
      }
    }

    // Reset idle timer — evict cached session handle on inactivity
    this.idleMonitor.reset(topicId, () => {
      this.activeSessions.delete(topicId);
      console.log(`[relay] Session handle evicted (idle): topic ${topicId} → "${entry.sessionName}"`);
    });

    const placeholder = await ctx.reply('…', { message_thread_id: topicId });

    let accumulated = '';
    let lastEditAt = 0;

    try {
      for await (const chunk of session.send(userText)) {
        accumulated += chunk;
        const now = Date.now();
        if (now - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
          await this.safeEdit(ctx, placeholder.chat.id, placeholder.message_id, accumulated);
          lastEditAt = now;
        }
      }

      // Final edit: full response with Markdown, fallback to plain text
      const modelStr = String(entry.model ?? this.globalModel);
      // Session names are DNS-label constrained; model names are simple identifiers.
      // safeEdit falls back to plain text if Markdown is rejected.
      const footer = `\n\n📎 ${entry.sessionName} · ${modelStr}`;
      await this.safeEdit(
        ctx,
        placeholder.chat.id,
        placeholder.message_id,
        (accumulated || '_(empty response)_') + footer,
        true,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Stream error on topic ${topicId}:`, err);

      // If this looks like an SDK crash (not a timeout), trigger factory restart
      const isTimeout = err instanceof StreamTimeoutError;
      if (!isTimeout && this.factory.resetForRestart) {
        this.idleMonitor.cancelAll();
        this.activeSessions.clear();
        this.factory.resetForRestart();
        console.log(`[relay] SDK error detected — factory marked for restart; cleared cached sessions`);
      } else {
        this.activeSessions.delete(topicId); // Only evict current topic for timeouts
      }
      
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
