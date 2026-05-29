/**
 * AfkStreamRouter — manages chain-serialized stream routing for AFK mode.
 *
 * Owns all stream state (per-key StreamState, per-key chain Promises,
 * per-session requestId index) and routes incoming stream/stream.error
 * events to the correct Telegram topic via throttled message edits.
 *
 * Responsibility boundary: reads session context via callbacks; does not
 * mutate any AfkModeController state.
 */

import type { Bot, Context } from 'grammy';

interface StreamState {
  topicId: number;
  text: string;
  messageId?: number;
  lastEditAt: number;
}

const STREAM_EDIT_THROTTLE_MS = 800;

/** Telegram's absolute message-length limit (characters). */
export const TELEGRAM_MAX_TEXT = 4096;
/** Safe display cap — leaves headroom for the truncation prefix. */
export const TELEGRAM_MAX_DISPLAY = 4000;
/** Prefix prepended when the buffer is truncated for display. */
const TRUNCATION_PREFIX = '…(truncated)\n';

/**
 * Returns a display-safe slice of `text`:
 *   - empty string  → '…' (never send empty to Telegram)
 *   - within cap    → text as-is
 *   - exceeds cap   → TRUNCATION_PREFIX + last N chars (last-N policy, shows most-recent output)
 */
function displayText(text: string): string {
  if (text.length === 0) return '…';
  if (text.length <= TELEGRAM_MAX_DISPLAY) return text;
  return TRUNCATION_PREFIX + text.slice(-(TELEGRAM_MAX_DISPLAY - TRUNCATION_PREFIX.length));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AfkStreamRouterDeps {
  /** Returns the Telegram topic ID bound to the given session, or undefined if unbound. */
  getTopicId: (sessionId: string) => number | undefined;
  /** Returns true when AFK mode is currently active. */
  isActive: () => boolean;
  bot: Bot<Context>;
  chatId: number;
}

export class AfkStreamRouter {
  private readonly streamStates = new Map<string, StreamState>();
  private readonly streamChains = new Map<string, Promise<void>>();
  /** Per-session index of active request IDs for O(1) disconnect cleanup. */
  private readonly sessionRequestIds = new Map<string, Set<string>>();

  constructor(private readonly deps: AfkStreamRouterDeps) {}

  enqueueChunk(sessionId: string, requestId: string, chunk: string, done: boolean): void {
    const key = `${sessionId}:${requestId}`;
    // Track request IDs per session for O(1) disconnect cleanup.
    let ids = this.sessionRequestIds.get(sessionId);
    if (!ids) { ids = new Set(); this.sessionRequestIds.set(sessionId, ids); }
    if (!ids.has(requestId)) ids.add(requestId);

    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleChunk(sessionId, requestId, chunk, done))
      .catch((err) => console.warn('[afk] Failed to route stream:', errorText(err)));
    this.streamChains.set(key, next);
    if (done) {
      next.finally(() => {
        this.streamChains.delete(key);
        this.removeRequestId(sessionId, requestId);
      });
    }
  }

  enqueueError(sessionId: string, requestId: string, error: string): void {
    const key = `${sessionId}:${requestId}`;
    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleError(sessionId, requestId, error))
      .catch((err) => console.warn('[afk] Failed to route stream error:', errorText(err)))
      .finally(() => {
        this.streamChains.delete(key);
        this.removeRequestId(sessionId, requestId);
      });
    this.streamChains.set(key, next);
  }

  /** Remove a requestId from the per-session index; deletes the sessionId entry when the Set empties. */
  private removeRequestId(sessionId: string, requestId: string): void {
    const ids = this.sessionRequestIds.get(sessionId);
    if (!ids) return;
    ids.delete(requestId);
    if (ids.size === 0) this.sessionRequestIds.delete(sessionId);
  }

  /** Remove all stream state for a disconnected session (O(1) via sessionRequestIds index). */
  cleanupSession(sessionId: string): void {
    const requestIds = this.sessionRequestIds.get(sessionId);
    if (requestIds) {
      for (const requestId of requestIds) {
        const key = `${sessionId}:${requestId}`;
        this.streamChains.delete(key);
        this.streamStates.delete(key);
      }
      this.sessionRequestIds.delete(sessionId);
    }
  }

  /** Clear all stream state on deactivation. */
  reset(): void {
    this.streamStates.clear();
    this.streamChains.clear();
    this.sessionRequestIds.clear();
  }

  private async handleChunk(sessionId: string, requestId: string, chunk: string, done: boolean): Promise<void> {
    if (!this.deps.isActive()) return;
    const key = `${sessionId}:${requestId}`;
    const topicId = this.streamStates.get(key)?.topicId ?? this.deps.getTopicId(sessionId);
    if (topicId === undefined) return;

    // Initialize state eagerly — ensures buffered text is preserved if placeholder send fails.
    let state = this.streamStates.get(key);
    if (!state) {
      state = { topicId, text: '', lastEditAt: 0 };
      this.streamStates.set(key, state);
    }

    // Buffer chunk before any network call so text is never lost on transient failure.
    state.text += chunk;

    try {
      if (state.messageId === undefined) {
        // No placeholder yet: either first chunk or a prior sendMessage threw.
        // Send the full accumulated buffer so no text is lost on retry.
        // displayText guarantees a non-empty string and caps at TELEGRAM_MAX_DISPLAY.
        try {
          const placeholder = await this.deps.bot.api.sendMessage(
            this.deps.chatId, displayText(state.text), { message_thread_id: topicId },
          );
          state.messageId = placeholder.message_id;
          state.lastEditAt = Date.now();
        } catch (err) {
          // Preserve state so the next chunk retries placeholder creation.
          console.warn('[afk] Failed to create stream placeholder:', errorText(err));
          return;
        }
      } else {
        const now = Date.now();
        if (done || now - state.lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
          await this.deps.bot.api.editMessageText(this.deps.chatId, state.messageId, displayText(state.text));
          state.lastEditAt = now;
        }
      }
    } finally {
      if (done) this.streamStates.delete(key);
    }
  }

  private async handleError(sessionId: string, requestId: string, error: string): Promise<void> {
    const key = `${sessionId}:${requestId}`;
    const state = this.streamStates.get(key);
    this.streamStates.delete(key); // Always clean up — cycle-1 invariant; must not be gated.
    if (!this.deps.isActive()) return; // Skip Telegram send when AFK is deactivated (race guard).
    const topicId = state?.topicId ?? this.deps.getTopicId(sessionId);
    if (topicId === undefined) return;
    if (state?.messageId !== undefined) {
      await this.deps.bot.api.editMessageText(this.deps.chatId, state.messageId, `❌ Error: ${error}`);
    } else {
      await this.deps.bot.api.sendMessage(this.deps.chatId, `❌ Error: ${error}`, { message_thread_id: topicId });
    }
  }
}
