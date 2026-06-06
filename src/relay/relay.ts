import type {
  CopilotSessionFactory,
  CopilotSession,
  PermissionPromptCallback,
} from '../copilot/factory.js';
import type { SessionLookup } from './ports.js';
import type { ChannelPort, ChannelContext, MessageRef } from '../channel/port.js';
import type { TelegramChannel } from '../channel/telegram/index.js';
import { IdleMonitor } from '../idleMonitor.js';
import { StreamTimeoutError } from '../copilot/impl.js';

const CHUNK_SEND_DELAY_MS = 100;

/** DoS guard: cap streamed response to avoid O(n²) concat and Telegram 429 lockout. */
const MAX_ACCUMULATED_BYTES = 100_000;

/** Throttle channel message edits to stay within ~1/s rate limit. */
const STREAM_EDIT_THROTTLE_MS = 800;

export class Relay {
  /** In-memory cache of live SDK session handles, keyed by threadId. */
  private activeSessions = new Map<string, { sessionName: string; session: CopilotSession }>();
  private idleMonitor = new IdleMonitor();

  constructor(
    private readonly channel: ChannelPort,
    private readonly sessionLookup: SessionLookup,
    private readonly factory: CopilotSessionFactory,
    private readonly globalModel: string,
    private readonly enablePermissionPrompts = false,
  ) {}

  async relay(channelCtx: ChannelContext, userText: string): Promise<void> {
    const { threadId } = channelCtx;

    const entry = this.sessionLookup.resolve(threadId);
    if (!entry) {
      await this.channel.sendMessage(channelCtx, '⚠️ No session linked to this topic. Use /new <name> to create one.');
      return;
    }

    const cached = this.activeSessions.get(threadId);
    let session = cached?.session;

    // Evict stale cache: if the thread was re-linked to a different session name
    // (e.g. /remove then /new), the cached handle is for the wrong session.
    if (cached && cached.sessionName !== entry.sessionName) {
      cached.session.dispose?.();
      this.activeSessions.delete(threadId);
      session = undefined;
    }

    if (!session) {
      try {
        let permissionCallback: PermissionPromptCallback | undefined;
        if (this.enablePermissionPrompts) {
          const capturedCtx = channelCtx;
          permissionCallback = async (toolName: string, args: string, signal?: AbortSignal) => {
            const result = await this.channel.promptUser(
              capturedCtx,
              `⚠️ Tool approval needed\n\nTool: ${toolName}\nArgs: ${args.length > 200 ? args.slice(0, 197) + '...' : args}\n\nApprove or deny — waiting for your decision.`,
              [
                { value: 'approve', label: '✅ Approve' },
                { value: 'deny', label: '❌ Deny' },
              ],
              signal,
            );
            return result === 'approve';
          };
        }

        session = await this.factory.resume(entry.sessionName, entry.model, permissionCallback)
          ?? await this.factory.create(entry.sessionName, entry.model, permissionCallback);

        this.activeSessions.set(threadId, { sessionName: entry.sessionName, session });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.channel.sendMessage(channelCtx, `❌ Could not open session "${entry.sessionName}": ${msg}`);
        return;
      }
    }

    // Reset idle timer — evict cached session handle on inactivity.
    const scheduleIdle = (): void => {
      this.idleMonitor.reset(threadId, () => {
        const evicted = this.activeSessions.get(threadId);
        if (!evicted) return;
        if (evicted.session.isBusy?.()) {
          console.log(`[relay] Session busy (pending permission), deferring idle eviction: thread ${threadId} → "${evicted.sessionName}"`);
          scheduleIdle();
          return;
        }
        evicted.session.dispose?.();
        this.activeSessions.delete(threadId);
        console.log(`[relay] Session handle evicted (idle): thread ${threadId} → "${evicted.sessionName}"`);
      });
    };
    scheduleIdle();

    const { supportsStreaming, supportsMessageEdit } = this.channel.capabilities;

    if (supportsStreaming && supportsMessageEdit) {
      // ── Case A: live streaming with throttled edits ────────────────────────
      // Both flags true (e.g. Telegram). Behavior is byte-identical to the
      // original code: send "…" placeholder, stream-edit every 800ms, final edit.
      const placeholderRef = await this.channel.sendMessage(channelCtx, '…');

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
            try {
              await this.channel.editMessage(channelCtx, placeholderRef, accumulated);
            } catch {
              // best-effort throttle edit — ignore failures during streaming
            }
            lastEditAt = now;
          }
        }

        // Final edit: full response with Markdown and optional extra chunks
        const modelStr = String(entry.model ?? this.globalModel);
        const footer = `📎 ${entry.sessionName} · ${modelStr}`;
        const body = accumulated || '_(empty response)_';
        const chunks = this.channel.splitMessage(body, footer);

        const firstOk = await this.safeEditFormatted(channelCtx, placeholderRef, chunks[0] ?? '', entry.sessionName);

        if (!firstOk) {
          console.error(
            `[relay] First-chunk edit failed — aborting follow-up chunks for thread ${threadId}; updating placeholder`,
          );
          try {
            await this.channel.editMessage(channelCtx, placeholderRef, '_(failed to render reply — see logs)_');
          } catch {
            // best-effort: ignore failure to update placeholder
          }
          return;
        }

        const totalChunks = chunks.length;
        let failedChunks = 0;
        for (let i = 1; i < chunks.length; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_SEND_DELAY_MS));
          const ok = await this.safeSendFormatted(channelCtx, chunks[i] ?? '', entry.sessionName, i + 1, totalChunks);
          if (!ok) failedChunks++;
        }
        if (failedChunks > 0) {
          console.warn(`[relay] ${failedChunks} of ${totalChunks} chunks failed — response may be truncated for thread ${threadId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[relay] Stream error on thread ${threadId}:`, err);

        const isTimeout = err instanceof StreamTimeoutError;
        if (!isTimeout && this.factory.resetForRestart) {
          this.idleMonitor.cancelAll();
          for (const { session: s } of this.activeSessions.values()) s.dispose?.();
          this.activeSessions.clear();
          this.factory.resetForRestart();
          console.log(`[relay] SDK error detected — factory marked for restart; cleared cached sessions`);
        } else {
          const evicted = this.activeSessions.get(threadId);
          evicted?.session.dispose?.();
          this.activeSessions.delete(threadId);
        }

        try {
          await this.channel.editMessage(channelCtx, placeholderRef, `❌ Error: ${msg}`);
        } catch {
          // best-effort: ignore failure to update placeholder with error
        }
      }
    } else if (!supportsMessageEdit) {
      // ── Case B: no edit support — accumulate silently, send one final message ─
      // supportsMessageEdit=false: core MUST NOT call editMessage(). No placeholder.
      // Stream is consumed; one sendMessage with the complete response when done.
      let accumulated = '';

      try {
        for await (const chunk of session.send(userText)) {
          accumulated += chunk;
          if (accumulated.length > MAX_ACCUMULATED_BYTES) {
            accumulated = accumulated.slice(0, MAX_ACCUMULATED_BYTES) + '\n\n_(response truncated at 100KB)_';
            break;
          }
        }

        const modelStr = String(entry.model ?? this.globalModel);
        const footer = `📎 ${entry.sessionName} · ${modelStr}`;
        const body = accumulated || '_(empty response)_';
        const chunks = this.channel.splitMessage(body, footer);

        const firstOk = await this.safeSendFormatted(channelCtx, chunks[0] ?? '', entry.sessionName);
        if (!firstOk) {
          console.error(`[relay] First-chunk send failed — aborting follow-up chunks for thread ${threadId}`);
          return;
        }

        const totalChunks = chunks.length;
        let failedChunks = 0;
        for (let i = 1; i < chunks.length; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_SEND_DELAY_MS));
          const ok = await this.safeSendFormatted(channelCtx, chunks[i] ?? '', entry.sessionName, i + 1, totalChunks);
          if (!ok) failedChunks++;
        }
        if (failedChunks > 0) {
          console.warn(`[relay] ${failedChunks} of ${totalChunks} chunks failed — response may be truncated for thread ${threadId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[relay] Stream error on thread ${threadId}:`, err);

        const isTimeout = err instanceof StreamTimeoutError;
        if (!isTimeout && this.factory.resetForRestart) {
          this.idleMonitor.cancelAll();
          for (const { session: s } of this.activeSessions.values()) s.dispose?.();
          this.activeSessions.clear();
          this.factory.resetForRestart();
          console.log(`[relay] SDK error detected — factory marked for restart; cleared cached sessions`);
        } else {
          const evicted = this.activeSessions.get(threadId);
          evicted?.session.dispose?.();
          this.activeSessions.delete(threadId);
        }

        try {
          // No placeholder to edit — send error as a new message
          await this.channel.sendMessage(channelCtx, `❌ Error: ${msg}`);
        } catch {
          // best-effort: ignore failure to send error message
        }
      }
    } else {
      // ── Case C: supportsStreaming=false, supportsMessageEdit=true ──────────────
      // Send "thinking…" placeholder, consume the full stream without intermediate
      // edits, then replace the placeholder with the complete response in one edit.
      const placeholderRef = await this.channel.sendMessage(channelCtx, 'thinking…');

      let accumulated = '';

      try {
        for await (const chunk of session.send(userText)) {
          accumulated += chunk;
          if (accumulated.length > MAX_ACCUMULATED_BYTES) {
            accumulated = accumulated.slice(0, MAX_ACCUMULATED_BYTES) + '\n\n_(response truncated at 100KB)_';
            break;
          }
          // No intermediate stream edits — supportsStreaming is false
        }

        const modelStr = String(entry.model ?? this.globalModel);
        const footer = `📎 ${entry.sessionName} · ${modelStr}`;
        const body = accumulated || '_(empty response)_';
        const chunks = this.channel.splitMessage(body, footer);

        const firstOk = await this.safeEditFormatted(channelCtx, placeholderRef, chunks[0] ?? '', entry.sessionName);
        if (!firstOk) {
          console.error(
            `[relay] First-chunk edit failed — aborting follow-up chunks for thread ${threadId}; updating placeholder`,
          );
          try {
            await this.channel.editMessage(channelCtx, placeholderRef, '_(failed to render reply — see logs)_');
          } catch {
            // best-effort: ignore failure to update placeholder
          }
          return;
        }

        const totalChunks = chunks.length;
        let failedChunks = 0;
        for (let i = 1; i < chunks.length; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_SEND_DELAY_MS));
          const ok = await this.safeSendFormatted(channelCtx, chunks[i] ?? '', entry.sessionName, i + 1, totalChunks);
          if (!ok) failedChunks++;
        }
        if (failedChunks > 0) {
          console.warn(`[relay] ${failedChunks} of ${totalChunks} chunks failed — response may be truncated for thread ${threadId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[relay] Stream error on thread ${threadId}:`, err);

        const isTimeout = err instanceof StreamTimeoutError;
        if (!isTimeout && this.factory.resetForRestart) {
          this.idleMonitor.cancelAll();
          for (const { session: s } of this.activeSessions.values()) s.dispose?.();
          this.activeSessions.clear();
          this.factory.resetForRestart();
          console.log(`[relay] SDK error detected — factory marked for restart; cleared cached sessions`);
        } else {
          const evicted = this.activeSessions.get(threadId);
          evicted?.session.dispose?.();
          this.activeSessions.delete(threadId);
        }

        try {
          await this.channel.editMessage(channelCtx, placeholderRef, `❌ Error: ${msg}`);
        } catch {
          // best-effort: ignore failure to update placeholder with error
        }
      }
    }
  }

  /**
   * Edit a message with MarkdownV2 formatting if the channel is a TelegramChannel,
   * otherwise fall back to plain editMessage.
   */
  private async safeEditFormatted(
    ctx: ChannelContext,
    ref: MessageRef,
    text: string,
    sessionLabel = '',
  ): Promise<boolean> {
    const tg = this.asTelegramChannel();
    if (tg) {
      return tg.editMessageWithMarkdown(ctx, ref, text, sessionLabel);
    }
    try {
      await this.channel.editMessage(ctx, ref, this.channel.formatForTransport(text));
      return true;
    } catch (editErr) {
      console.warn(`[relay] editMessage failed (thread=${ctx.threadId}):`, editErr);
      return false;
    }
  }

  /**
   * Send a message with MarkdownV2 formatting if the channel is a TelegramChannel,
   * otherwise fall back to plain sendMessage.
   */
  private async safeSendFormatted(
    ctx: ChannelContext,
    text: string,
    sessionLabel = '',
    chunkNumber?: number,
    totalChunks?: number,
  ): Promise<boolean> {
    const tg = this.asTelegramChannel();
    if (tg) {
      const ref = await tg.sendMessageWithMarkdown(ctx, text, sessionLabel);
      if (!ref) {
        if (chunkNumber !== undefined) {
          console.warn(`[relay] send failed (thread=${ctx.threadId}, chunk=${chunkNumber}/${totalChunks})`);
        } else {
          console.warn(`[relay] send failed (thread=${ctx.threadId})`);
        }
        return false;
      }
      return true;
    }
    try {
      await this.channel.sendMessage(ctx, this.channel.formatForTransport(text));
      return true;
    } catch (sendErr) {
      console.warn(`[relay] send failed (thread=${ctx.threadId}):`, sendErr);
      return false;
    }
  }

  /** Return the channel cast as TelegramChannel if it supports the markdown edit helper. */
  private asTelegramChannel(): TelegramChannel | null {
    const ch = this.channel as unknown as TelegramChannel;
    return typeof ch.editMessageWithMarkdown === 'function' ? ch : null;
  }

  /**
   * Migrates the in-memory SDK session cache from fromThreadId to toThreadId.
   * Called by the /resume handler after a successful registry.move() so the
   * live session handle travels with the binding instead of sitting stale under
   * the old thread key until idle eviction.
   */
  rekeySession(fromThreadId: string, toThreadId: string): void {
    const cached = this.activeSessions.get(fromThreadId);
    if (!cached) return;
    if (this.activeSessions.has(toThreadId)) {
      this.idleMonitor.cancel(toThreadId);
      this.activeSessions.delete(toThreadId);
    }
    this.activeSessions.delete(fromThreadId);
    this.activeSessions.set(toThreadId, cached);
    this.idleMonitor.cancel(fromThreadId);
  }

  /** Tear down all active sessions and timers (call on graceful shutdown). */
  dispose(): void {
    this.idleMonitor.cancelAll();
    for (const { session } of this.activeSessions.values()) session.dispose?.();
    this.activeSessions.clear();
  }
}
