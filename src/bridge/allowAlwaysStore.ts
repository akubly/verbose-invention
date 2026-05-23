/**
 * allowAlwaysStore.ts — Per-session allow-always policy for permission prompting.
 *
 * ADR-9 §Q2: Injectable interface (Phase 6 uses in-memory; Phase 7+ seam for
 * persisted implementation). The store is per-session — a fresh consent decision
 * is required for each new session. Inject via BridgeSessionFactory constructor.
 *
 * In Phase 6 the "allow-always" path is not yet reachable (the Telegram prompt
 * has only ✅ Approve / ❌ Deny — the tiered "allow once vs allow always" buttons
 * are Phase 7). The store exists as an architecture seam and for future callers.
 */

/** Port: per-session tool approval cache. */
export interface AllowAlwaysStore {
  /** Returns true if `toolName` has been added to the allow-always list. */
  has(toolName: string): boolean;
  /** Add `toolName` to the allow-always list. Subsequent `has()` calls return true. */
  add(toolName: string): void;
}

/** In-memory implementation — resets with the BridgeSession (i.e., on session eviction). */
export class InMemoryAllowAlwaysStore implements AllowAlwaysStore {
  private readonly _allowed = new Set<string>();

  has(toolName: string): boolean {
    return this._allowed.has(toolName);
  }

  add(toolName: string): void {
    this._allowed.add(toolName);
  }
}
