/**
 * Relay-layer ports — minimal interfaces for outbound dependencies.
 *
 * The relay layer must not import from `../bot/` or `../sessions/`.
 * Consumers wire in concrete implementations at the composition root.
 * See src/bot/handlers.ts for the concrete adapters.
 */

/** Minimal session record that relay needs — only the fields it uses. */
export interface ResolvedSession {
  sessionName: string;
  model?: string;
}

/** Port: resolves a Telegram topic ID to its linked session entry. */
export interface SessionLookup {
  resolve(topicId: number): ResolvedSession | undefined;
}

/**
 * Port: prompts the user interactively to approve or deny a destructive tool
 * execution. Relay calls this when a permissionPrompter is injected.
 * Returns true = approved, false = denied or aborted.
 *
 * @param signal - Optional AbortSignal; when fired the prompt resolves false
 *   immediately (e.g., on session disconnect). K1 / ADR-9 §6.
 */
export interface PermissionPrompter {
  prompt(chatId: number, topicId: number, toolName: string, args: string, signal?: AbortSignal): Promise<boolean>;
}
