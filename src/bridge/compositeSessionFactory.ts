/**
 * compositeSessionFactory.ts — Bridge-first, SDK-fallback CopilotSessionFactory.
 *
 * Composition choice: Option A (composite factory).
 * - `resume()` and `create()` try the bridge factory first.
 * - If the bridge has no registered session for the name, fall back to the SDK factory.
 *
 * This allows graceful coexistence: CLI sessions attached via the extension pipe get
 * bridge-backed BridgeSessions (streaming relay over named pipe); pure SDK sessions
 * (created by Reach itself) continue to get SDK-backed CopilotSessions.
 * The relay, throttle, and MarkdownV2 logic in relay.ts require no changes.
 *
 * See: .squad/decisions/inbox/kat-phase6-days3-4-bridge-adapter.md
 */

import type {
  CopilotSession,
  CopilotSessionFactory,
  PermissionPromptCallback,
} from '../copilot/factory.js';

export class CompositeSessionFactory implements CopilotSessionFactory {
  constructor(
    private readonly bridgeFactory: CopilotSessionFactory,
    private readonly sdkFactory: CopilotSessionFactory,
  ) {}

  async resume(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null> {
    // Bridge-first: if the extension has this session live, use it immediately.
    const bridgeSession = await this.bridgeFactory.resume(sessionName, model, permissionCallback);
    if (bridgeSession !== null) return bridgeSession;
    return this.sdkFactory.resume(sessionName, model, permissionCallback);
  }

  async create(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession> {
    // Resume-first on the bridge: if the extension already has the session, use it.
    const bridgeSession = await this.bridgeFactory.resume(sessionName, model, permissionCallback);
    if (bridgeSession !== null) return bridgeSession;
    // Not on the bridge — create a new SDK session (extension hasn't attached, or this
    // is a Reach-spawned session with no extension counterpart).
    return this.sdkFactory.create(sessionName, model, permissionCallback);
  }

  resetForRestart(): void {
    this.bridgeFactory.resetForRestart?.();
    this.sdkFactory.resetForRestart?.();
  }
}
