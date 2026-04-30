/**
 * Shared domain types for Reach.
 */

export interface SessionEntry {
  /** Human-readable session name set by /new. */
  sessionName: string;
  /** Telegram forum topic ID that maps to this session. */
  topicId: number;
  /** Telegram supergroup chat ID. */
  chatId: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Per-session model override (falls back to global REACH_MODEL). */
  model?: string;
}
