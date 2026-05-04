import type { Context } from 'grammy';
import type {
  CopilotSessionFactory,
  CopilotSession,
  PermissionPromptCallback,
} from '../copilot/factory.js';
import type { SessionLookup, PermissionPrompter } from './ports.js';
import { IdleMonitor } from '../idleMonitor.js';
import { StreamTimeoutError } from '../copilot/impl.js';
import { escapeMarkdownV2 } from './markdownV2.js';
import { splitForTelegram } from './messageSplitter.js';

const CHUNK_SEND_DELAY_MS = 100;

/** DoS guard: cap streamed response to avoid O(n²) concat and Telegram 429 lockout. */
const MAX_ACCUMULATED_BYTES = 100_000;
/** DoS guard: cap split chunk array to avoid flooding Telegram with hundreds of messages. */
const MAX_CHUNKS = 25;
/**
 * Worst-case MarkdownV2 escape budget: a chunk made entirely of special chars
 * doubles in size after escaping. Using half of Telegram's 4096-char limit (≈ 2048)
 * as the effective max guarantees even 100%-special-char content stays under 4096.
 */
const MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048;

/** Throttle Telegram message edits to stay within ~1/s rate limit. */
const STREAM_EDIT_THROTTLE_MS = 800;

/**
 * F6: Returns true only for Telegram parse-mode 400 errors ("can't parse entities").
 * Network errors, 429 rate limits, and permission errors are NOT parse errors.
 */
function isParseEntitiesError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't parse entities") || msg.includes('parse entities');
}

export class Relay {
  /** In-memory cache of live SDK session handles, keyed by forum topic ID. */
  private activeSessions = new Map<number, { sessionName: string; session: CopilotSession }>();
  private idleMonitor = new IdleMonitor();
  /** Sessions that have already logged a MarkdownV2 rejection (log once per session). */
  private md2WarnedSessions = new Set<string>();

  constructor(
    private readonly sessionLookup: SessionLookup,
    private readonly factory: CopilotSessionFactory,
    private readonly globalModel: string,
    private readonly permissionPrompter?: PermissionPrompter,
  ) {}

  async relay(ctx: Context): Promise<void> {
    const topicId = ctx.message?.message_thread_id;
    const userText = ctx.message?.text;

    if (!topicId || !userText) return;

    const entry = this.sessionLookup.resolve(topicId);
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
        if (this.permissionPrompter !== undefined) {
          const chatId = ctx.chat?.id;
          if (chatId === undefined) {
            const message = '⚠️ permission prompting requires chat context — cannot prompt';
            console.warn('[relay] permission prompting requires chat context — cannot prompt');
            await ctx.reply(message, { message_thread_id: topicId });
            return;
          }

          const prompter = this.permissionPrompter;
          permissionCallback = (toolName: string, args: string) =>
            prompter.prompt(chatId, topicId, toolName, args);
        }

        session = await this.factory.resume(entry.sessionName, entry.model, permissionCallback)
          ?? await this.factory.create(entry.sessionName, entry.model, permissionCallback);

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
        if (accumulated.length > MAX_ACCUMULATED_BYTES) {
          accumulated = accumulated.slice(0, MAX_ACCUMULATED_BYTES) + '\n\n_(response truncated at 100KB)_';
          break;
        }
        const now = Date.now();
        if (now - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
          await this.safeEdit(ctx, placeholder.chat.id, placeholder.message_id, accumulated);
          lastEditAt = now;
        }
      }

      // Final edit: full response with Markdown and optional extra chunks
      const modelStr = String(entry.model ?? this.globalModel);
      const footer = `📎 ${entry.sessionName} · ${modelStr}`;
      const body = accumulated || '_(empty response)_';
      const chunks = splitForTelegram(body, {
        footer,
        numbering: true,
        effectiveMaxLen: MARKDOWN_ESCAPE_EFFECTIVE_MAX,
        maxChunks: MAX_CHUNKS,
      });

      // Truncation (if any) is handled inside splitForTelegram: when chunk count
      // exceeds MAX_CHUNKS the splitter replaces the last slot with a truncation
      // marker BEFORE numbering/footer composition, so every delivered chunk
      // carries consistent [n/MAX_CHUNKS] totals and the marker gets the HUD footer.

      const firstOk = await this.safeEdit(
        ctx,
        placeholder.chat.id,
        placeholder.message_id,
        chunks[0] ?? '',
        true,
        entry.sessionName,
      );

      if (!firstOk) {
        console.error(
          `[relay] First-chunk edit failed — aborting follow-up chunks for topic ${topicId}; updating placeholder`,
        );
        // Best-effort: replace "…" with a brief error so the user isn't left at the placeholder.
        await this.safeEdit(ctx, placeholder.chat.id, placeholder.message_id, '_(failed to render reply — see logs)_');
        return;
      }

      // F9: track failures per chunk for log fidelity.
      const totalChunks = chunks.length;
      let failedChunks = 0;
      for (let i = 1; i < chunks.length; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_SEND_DELAY_MS));
        const ok = await this.safeSend(ctx, topicId, chunks[i] ?? '', true, entry.sessionName, i + 1, totalChunks);
        if (!ok) failedChunks++;
      }
      if (failedChunks > 0) {
        console.warn(`[relay] ${failedChunks} of ${totalChunks} chunks failed — response may be truncated for topic ${topicId}`);
      }
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

  /**
   * F6+F8: Shared MarkdownV2 fallback logic.
   * Attempts tryMd(); on parse-entities error falls back to fallback().
   * Non-parse errors (network, 429, permission) are rethrown to the caller.
   */
  private async withMarkdownFallback(
    sessionLabel: string,
    tryMd: () => Promise<unknown>,
    fallback: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await tryMd();
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err;
      if (sessionLabel && !this.md2WarnedSessions.has(sessionLabel)) {
        this.md2WarnedSessions.add(sessionLabel);
        console.warn(`[relay] MarkdownV2 rejected for session "${sessionLabel}" — falling back to plain text`);
      }
      await fallback();
    }
  }

  private async safeEdit(
    ctx: Context,
    chatId: number,
    messageId: number,
    text: string,
    tryMarkdown = false,
    sessionLabel = '',
  ): Promise<boolean> {
    try {
      if (tryMarkdown) {
        await this.withMarkdownFallback(
          sessionLabel,
          () => ctx.api.editMessageText(chatId, messageId, escapeMarkdownV2(text), { parse_mode: 'MarkdownV2' }),
          () => ctx.api.editMessageText(chatId, messageId, text),
        );
      } else {
        await ctx.api.editMessageText(chatId, messageId, text);
      }
      return true;
    } catch (editErr) {
      console.warn(`[relay] editMessageText failed (chat=${chatId}, msg=${messageId}):`, editErr);
      return false;
    }
  }

  private async safeSend(
    ctx: Context,
    topicId: number,
    text: string,
    tryMarkdown = false,
    sessionLabel = '',
    chunkNumber?: number,
    totalChunks?: number,
  ): Promise<boolean> {
    try {
      if (tryMarkdown) {
        await this.withMarkdownFallback(
          sessionLabel,
          () => ctx.reply(escapeMarkdownV2(text), { message_thread_id: topicId, parse_mode: 'MarkdownV2' }),
          () => ctx.reply(text, { message_thread_id: topicId }),
        );
      } else {
        await ctx.reply(text, { message_thread_id: topicId });
      }
      return true;
    } catch (sendErr) {
      if (chunkNumber !== undefined) {
        console.warn(`[relay] reply failed (topic=${topicId}, chunk=${chunkNumber}/${totalChunks})`, sendErr);
      } else {
        console.warn(`[relay] reply failed (topic=${topicId})`, sendErr);
      }
      return false;
    }
  }

  /**
   * Migrates the in-memory SDK session cache from oldTopicId to newTopicId.
   * Called by the /resume handler after a successful registry.move() so the
   * live session handle travels with the binding instead of sitting stale under
   * the old topic key until idle eviction.
   * If no cache entry exists for oldTopicId this is a no-op (safe to call
   * speculatively — first relay after /resume will create a fresh session).
   */
  rekeySession(fromTopicId: number, toTopicId: number): void {
    const cached = this.activeSessions.get(fromTopicId);
    if (!cached) return;
    this.activeSessions.delete(fromTopicId);
    this.activeSessions.set(toTopicId, cached);
    // Cancel the old idle timer — its closure references fromTopicId and would
    // evict the wrong key.  The next message in toTopicId resets a fresh timer.
    this.idleMonitor.cancel(fromTopicId);
  }

  /** Tear down all active sessions and timers (call on graceful shutdown). */
  dispose(): void {
    this.idleMonitor.cancelAll();
    this.activeSessions.clear();
  }
}
