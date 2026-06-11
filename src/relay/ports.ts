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

/** Port: resolves a thread ID to its linked session entry. */
export interface SessionLookup {
  resolve(threadId: string): ResolvedSession | undefined;
}
