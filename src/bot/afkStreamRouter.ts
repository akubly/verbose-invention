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

    let state = this.streamStates.get(key);
    if (!state) {
      state = { topicId, text: '', lastEditAt: 0 };
      this.streamStates.set(key, state);
      const placeholder = await this.deps.bot.api.sendMessage(this.deps.chatId, '…', { message_thread_id: topicId });
      state.messageId = placeholder.message_id;
    }

    try {
      state.text += chunk;
      const now = Date.now();
      if (state.messageId !== undefined && (done || now - state.lastEditAt >= STREAM_EDIT_THROTTLE_MS)) {
        await this.deps.bot.api.editMessageText(this.deps.chatId, state.messageId, state.text || '_(empty response)_');
        state.lastEditAt = now;
      }
    } finally {
      if (done) this.streamStates.delete(key);
    }
  }

  private async handleError(sessionId: string, requestId: string, error: string): Promise<void> {
    const key = `${sessionId}:${requestId}`;
    const state = this.streamStates.get(key);
    this.streamStates.delete(key);
    const topicId = state?.topicId ?? this.deps.getTopicId(sessionId);
    if (topicId === undefined) return;
    if (state?.messageId !== undefined) {
      await this.deps.bot.api.editMessageText(this.deps.chatId, state.messageId, `❌ Error: ${error}`);
    } else {
      await this.deps.bot.api.sendMessage(this.deps.chatId, `❌ Error: ${error}`, { message_thread_id: topicId });
    }
  }
}
