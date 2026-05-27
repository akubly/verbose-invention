import type { Bot, Context } from 'grammy';
import type { ISessionRegistry } from '../sessions/registry.js';
import { ERROR_CODES, type BridgeSessionInfo, type ModeState, type RegistrationExtras } from '../bridge/protocol.js';
import type { AfkBridgePort } from './afkBridgePort.js';

export interface TopicBinding extends BridgeSessionInfo {
  topicId: number;
  topicUrl: string;
}

interface StreamState {
  topicId: number;
  text: string;
  messageId?: number;
  lastEditAt: number;
}

export interface AfkModeOptions {
  allowedUserIds?: ReadonlySet<number>;
  allowTelegramInput?: boolean;
}

export interface AfkModeControllerDeps {
  bot: Bot<Context>;
  bridge: AfkBridgePort;
  registry: ISessionRegistry;
  chatId: number;
  delay?: (ms: number) => Promise<void>;
  options?: AfkModeOptions;
}

export interface AfkSeedDTO {
  mode?: ModeState;
  sessions?: Array<{
    sessionId: string;
    topicId: number;
    sessionName?: string;
    cwd?: string;
    topicUrl?: string;
  }>;
}

interface MirrorRateState {
  windowStartMs: number;
  count: number;
}

const TOPIC_OP_GAP_MS = 250;
const STREAM_EDIT_THROTTLE_MS = 800;
const MAX_RETRIES = 4;
const MAX_MIRROR_TEXT_LENGTH = 4096;
const MIRROR_RATE_WINDOW_MS = 60_000;
const MIRROR_RATE_LIMIT = 20;
const GLOBAL_MIRROR_RATE_LIMIT = 100;
/** Cap Telegram retry_after to 30 s; an uncapped server value (e.g. 3600 s) would block the
 *  topic queue for the full duration on each retry, stalling every other session. */
const MAX_RATE_LIMIT_DELAY_MS = 30_000;
/** Compensation operations are best-effort; cap wall time so the rollback always completes. */
const COMPENSATION_TIMEOUT_MS = 7_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function topicUrl(chatId: number, topicId: number): string {
  const internalChatId = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${internalChatId}/${topicId}`;
}

function retryAfterMs(err: unknown): number | undefined {
  const record = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  if (record.error_code !== 429) return undefined;
  const retryAfter = record.parameters?.retry_after;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter)
    ? Math.max(0, retryAfter * 1000)
    : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Escape MarkdownV2 special characters for safe embedding in Telegram messages. */
function escapeTgMdV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

export class AfkModeController {
  private mode: ModeState = { active: false, since: '' };
  private readonly sessionTopics = new Map<string, TopicBinding>();
  private readonly topicSessions = new Map<number, string>();
  private topicQueue: Promise<unknown> = Promise.resolve();
  private generalSummaryMessageId: number | undefined;
  private activationPromise: Promise<void> | undefined;
  private readonly streamStates = new Map<string, StreamState>();
  private readonly streamChains = new Map<string, Promise<void>>();
  private readonly mirrorRates = new Map<string, MirrorRateState>();
  private globalMirrorRate: MirrorRateState = { windowStartMs: 0, count: 0 };
  /** Per-session index of active request IDs for O(1) disconnect cleanup. */
  private readonly sessionRequestIds = new Map<string, Set<string>>();
  /** Deduplication gate: sessionId → in-flight ensureTopic promise. Prevents concurrent calls
   *  from creating multiple topics for the same session (B7-1 sub-claim A). */
  private readonly pendingTopicEnsures = new Map<string, Promise<TopicBinding>>();

  constructor(
    private readonly bot: Bot<Context>,
    private readonly bridge: AfkBridgePort,
    private readonly registry: ISessionRegistry,
    private readonly chatId: number,
    private readonly delay: (ms: number) => Promise<void> = sleep,
    private readonly options: AfkModeOptions = {},
  ) {
    this.bridge.on('afk.request', (sessionId) => {
      this.activate(sessionId).catch((err) => { console.error('[afk] activate failed (session %s):', sessionId, errorText(err)); });
    });
    this.bridge.on('back.request', (sessionId) => {
      this.deactivate(sessionId).catch((err) => { console.error('[afk] deactivate failed (session %s):', sessionId, errorText(err)); });
    });
    this.bridge.on('session.disconnected', (sessionId) => {
      this.handleDisconnect(sessionId).catch((err) => { console.error('[afk] handleDisconnect failed (session %s):', sessionId, errorText(err)); });
    });
    this.bridge.on('stream', (sessionId, requestId, chunk, done) => {
      this.enqueueStream(sessionId, requestId, chunk, done);
    });
    this.bridge.on('stream.error', (sessionId, requestId, error) => {
      this.enqueueStreamError(sessionId, requestId, error);
    });
    this.bridge.setRegistrationAugmenter((session) => this.registrationExtras(session));
  }

  isActive(): boolean {
    return this.mode.active;
  }

  /** @visibleForTesting — Returns a shallow copy of the current mode state. */
  getMode(): ModeState {
    return { ...this.mode };
  }

  async handleTelegramMessage(ctx: Context): Promise<boolean> {
    // Guard ordering (security note): mode-active fires before chat-id. Both
    // return false unconditionally with no observable side effects, so the order
    // carries no security signal — chat-id is still checked before any real
    // processing (topic lookup, auth, bridge dispatch).
    if (!this.mode.active) return false;
    // Defense-in-depth (I5-5): reject updates from any chat other than the
    // configured one. Without this, a bot-accessible group whose topic ID
    // happens to collide could inject mirror input into a registered session.
    if (ctx.chat?.id !== this.chatId) return false;
    const topicId = ctx.message?.message_thread_id;
    const text = ctx.message?.text;
    if (!topicId || !text) return false;
    if (text.startsWith('/')) return false;

    const sessionId = this.topicSessions.get(topicId);
    if (!sessionId) return false;

    if (this.options.allowTelegramInput === false) {
      await ctx.reply('⚠️ Telegram mirror input is disabled while destructive tools are auto-approved. Set REACH_PERMISSION_POLICY=interactiveDestructive to use AFK input.', { message_thread_id: topicId });
      return true;
    }

    // Fail-closed when an allow-list is configured: block if userId absent or not listed.
    // When no allow-list is configured (allowedUserIds === undefined), all users are permitted.
    const userId = ctx.from?.id;
    if (this.options.allowedUserIds !== undefined && (userId === undefined || !this.options.allowedUserIds.has(userId))) {
      await ctx.reply('⛔ You are not authorized to control this Reach session.', { message_thread_id: topicId });
      return true;
    }

    if (text.length > MAX_MIRROR_TEXT_LENGTH) {
      await ctx.reply(`⚠️ Message too long. Limit is ${MAX_MIRROR_TEXT_LENGTH} characters.`, { message_thread_id: topicId });
      return true;
    }

    if (!this.allowMirrorInput(sessionId)) {
      await ctx.reply('⚠️ Too many Telegram messages for this session. Please slow down.', { message_thread_id: topicId });
      return true;
    }

    this.bridge.sendToSession(sessionId, {
      type: 'mirror.input',
      sessionId,
      text,
      source: 'telegram',
      topicId,
    });
    return true;
  }

  private allowMirrorInput(sessionId: string): boolean {
    const now = Date.now();

    // Global rate cap: 100 msgs/min across all sessions
    const globalExpired = now - this.globalMirrorRate.windowStartMs >= MIRROR_RATE_WINDOW_MS;
    if (globalExpired) this.globalMirrorRate = { windowStartMs: now, count: 0 };
    if (this.globalMirrorRate.count >= GLOBAL_MIRROR_RATE_LIMIT) return false;

    // Per-session rate cap: 20 msgs/min
    const current = this.mirrorRates.get(sessionId);
    if (!current || now - current.windowStartMs >= MIRROR_RATE_WINDOW_MS) {
      this.mirrorRates.set(sessionId, { windowStartMs: now, count: 1 });
      this.globalMirrorRate.count++;
      return true;
    }
    if (current.count >= MIRROR_RATE_LIMIT) return false;
    current.count++;
    this.globalMirrorRate.count++;
    return true;
  }

  private async activate(requestingSessionId: string): Promise<void> {
    if (this.activationPromise !== undefined) {
      await this.activationPromise.catch(() => {});
    }
    if (this.mode.active) {
      // Two reasons we might be here with mode already active:
      //   1. Late-register: a session came online after activateAllSessions finished.
      //   2. Rapid re-activate: the same session activated again before being removed
      //      from sessionTopics. In both cases, if the session already has a topic
      //      bound (and no ensure is in flight), there is nothing more to do.
      const info = this.bridge.getSessionInfo(requestingSessionId);
      if (info && !this.sessionTopics.has(requestingSessionId)) {
        const binding = await this.ensureTopic(info);
        this.sendAfkActivated(binding);
      }
      return;
    }

    this.mode = { active: true, since: new Date().toISOString() };
    // notified accumulator captures partial progress for compensatePartialActivation
    const notified: Array<{ sessionId: string; topicId: number }> = [];
    this.activationPromise = this.activateAllSessions(notified);
    try {
      await this.activationPromise;
    } catch (err) {
      // Rollback in-memory state so the daemon can retry cleanly.
      const addedBindings = Array.from(this.sessionTopics.values());
      this.mode = { active: false, since: '' };
      this.sessionTopics.clear();
      this.topicSessions.clear();
      this.sessionRequestIds.clear();
      this.pendingTopicEnsures.clear();
      // Best-effort registry rollback: revert any entries we flipped to 'afk'.
      // Runs BEFORE compensatePartialActivation so that if registrationExtras triggers
      // ensureTopic during compensation, it reads clean registry state (no stale lastTopicId).
      // I7-1 rollback ordering: compensation sends back.confirmed to sessions, which may
      // trigger a new afk.request → registrationExtras → ensureTopic chain.
      // Sequential by intent — caller is rare-path (activation failure), ordering aids debugging.
      for (const binding of addedBindings) {
        const entry = this.registry.findByName(binding.sessionName);
        if (entry) {
          const rolledBack = { ...entry, mode: 'back' as const };
          delete rolledBack.afkSince;
          delete rolledBack.lastTopicId;
          await this.registry.upsert(rolledBack).catch((e) => {
            console.warn('[afk] Registry rollback failed for', binding.sessionName, ':', errorText(e));
          });
        }
      }
      await this.compensatePartialActivation(addedBindings, notified);
      // Cleanup any pinned General summary that was partially posted.
      await this.editGeneralSummary('❌ AFK mode activation failed.');
      // Notify the requesting extension so it can surface the error to the user.
      this.bridge.sendToSession(requestingSessionId, {
        type: 'error',
        sessionId: requestingSessionId,
        error: errorText(err),
        code: ERROR_CODES.AFK_ACTIVATION_FAILED,
      });
      throw err;
    } finally {
      this.activationPromise = undefined;
    }
  }

  // out-parameter: populated with each session that received afk.activated,
  // so the catch block in activate() knows which sessions to back-notify.
  private async activateAllSessions(notified: Array<{ sessionId: string; topicId: number }>): Promise<void> {
    const sessions = this.bridge.listSessions();

    for (const session of sessions) {
      const binding = await this.ensureTopic(session);
      this.sendAfkActivated(binding);
      notified.push({ sessionId: binding.sessionId, topicId: binding.topicId });
      await this.safeSendMessage(
        `📡 AFK mode active. Telegram mirror ready for ${binding.sessionName} (${binding.sessionId}).`,
        binding.topicId,
      );
    }

    await this.postGeneralSummary();
    this.bridge.broadcastToSessions({ type: 'mode.changed', active: true, since: this.mode.since });
  }

  private async compensatePartialActivation(
    createdBindings: TopicBinding[],
    notified: Array<{ sessionId: string; topicId: number }>,
  ): Promise<void> {
    if (createdBindings.length === 0) return;
    const failures: string[] = [];

    // Back-notify only sessions that received afk.activated — sessions in
    // createdBindings that were not notified never got afk.activated, so
    // sending back.confirmed would be spurious and confuse the extension.
    for (const { sessionId } of notified) {
      try {
        this.bridge.sendToSession(sessionId, { type: 'back.confirmed', sessionId });
        this.bridge.sendToSession(sessionId, { type: 'mode.changed', active: false, since: '' });
      } catch (err) {
        failures.push(`notify ${sessionId}: ${errorText(err)}`);
      }
    }

    // Close all topics that were created (regardless of notification status).
    // Compensation closes run OUTSIDE topicQueue. This is safe because:
    //   1. activate() serializes activateAllSessions calls; a retry cannot run a new
    //      activateAllSessions while a prior one is in flight. A retry that fires after
    //      activateAllSessions rejects passes through immediately and may run during
    //      compensation — see point 2.
    //   2. The rollback also clears lastTopicId from the registry, so even
    //      if a late close resolves after a retry, the retry's ensureTopic
    //      has created a fresh topicId — the orphan close targets a dead ID.
    //   3. Promise.race caps wall time per close to COMPENSATION_TIMEOUT_MS.
    const compensationClose = (topicId: number): Promise<void> => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Compensation timed out after ${COMPENSATION_TIMEOUT_MS}ms: closeForumTopic ${topicId}`)),
          COMPENSATION_TIMEOUT_MS,
        ),
      );
      return Promise.race([
        this.withRateLimitRetry(() => this.bot.api.closeForumTopic(this.chatId, topicId)).then(() => undefined),
        timeout,
      ]);
    };

    await Promise.all(createdBindings.map(({ sessionId, topicId }) =>
      compensationClose(topicId).catch((err) => {
        console.warn('[afk] Failed to close partially activated topic %d for %s: %s', topicId, sessionId, errorText(err));
        failures.push(`close ${topicId}: ${errorText(err)}`);
      }),
    ));

    if (failures.length > 0) {
      console.warn('[afk] Partial activation compensation completed with errors:', failures.join('; '));
    }
  }

  private async deactivate(requestingSessionId?: string): Promise<void> {
    if (this.activationPromise !== undefined) {
      await this.activationPromise;
    }
    if (!this.mode.active) {
      if (requestingSessionId) {
        this.bridge.sendToSession(requestingSessionId, {
          type: 'error',
          sessionId: requestingSessionId,
          error: 'Not in AFK mode.',
          code: ERROR_CODES.AFK_NOT_ACTIVE,
        });
      }
      return;
    }

    const bindings = Array.from(this.sessionTopics.values());
    const deactivateErrors: string[] = [];
    for (const binding of bindings) {
      try {
        await this.safeSendMessage('🖥️ Session resumed locally', binding.topicId);
        await this.serializedTopicOperation(() => this.withRateLimitRetry(() =>
          this.bot.api.closeForumTopic(this.chatId, binding.topicId),
        ));
        const existing = this.resolveBindingEntry(binding);
        if (existing) {
          const backEntry = { ...existing, mode: 'back' as const, lastTopicId: binding.topicId };
          delete backEntry.afkSince;
          await this.registry.upsert(backEntry);
        }
      } catch (err) {
        deactivateErrors.push(`${binding.sessionId}: ${errorText(err)}`);
      }
    }
    if (deactivateErrors.length > 0) {
      console.warn('[afk] Deactivate completed with errors:', deactivateErrors.join('; '));
    }

    await this.editGeneralSummary('🖥️ Back at desk.');

    this.mode = { active: false, since: new Date().toISOString() };
    this.sessionTopics.clear();
    this.topicSessions.clear();
    this.streamStates.clear();
    this.streamChains.clear();
    this.mirrorRates.clear();
    this.globalMirrorRate = { windowStartMs: 0, count: 0 };
    this.sessionRequestIds.clear();

    for (const session of this.bridge.listSessions()) {
      this.bridge.sendToSession(session.sessionId, { type: 'back.confirmed', sessionId: session.sessionId });
    }
    this.bridge.broadcastToSessions({ type: 'mode.changed', active: false, since: this.mode.since });
  }

  private resolveBindingEntry(binding: TopicBinding) {
    return this.registry.resolve(binding.topicId) ?? this.registry.findByName(binding.sessionName);
  }

  private async registrationExtras(session: BridgeSessionInfo): Promise<RegistrationExtras> {
    if (!this.mode.active) return {};
    const binding = await this.ensureTopic(session);
    return { mode: { active: true, since: this.mode.since }, topicId: binding.topicId };
  }

  private async ensureTopic(session: BridgeSessionInfo): Promise<TopicBinding> {
    const existingBinding = this.sessionTopics.get(session.sessionId);
    if (existingBinding) return existingBinding;

    // B7-1 sub-claim A (deduplication gate): dedupe concurrent calls for the same session.
    // Two rapid activate() calls both pass the !sessionTopics.has() guard; this gate
    // ensures only the first reaches createOrReopenTopic — the second awaits its result.
    // Failure propagation: if the first caller's createOrReopenTopic throws, that same
    // rejection propagates to the second caller since it awaits the same promise.
    const inFlight = this.pendingTopicEnsures.get(session.sessionId);
    if (inFlight) return await inFlight;

    const work = this.createOrReopenTopic(session);
    this.pendingTopicEnsures.set(session.sessionId, work);
    try {
      return await work;
    } finally {
      this.pendingTopicEnsures.delete(session.sessionId);
    }
  }

  private async createOrReopenTopic(session: BridgeSessionInfo): Promise<TopicBinding> {
    const matches = this.registry.findAllByName(session.sessionName);
    if (matches.length > 1) {
      console.warn(`[afk] Duplicate registry entries for "${session.sessionName}"; creating a fresh AFK topic instead of reusing lastTopicId`);
    }
    const persisted = matches.length === 1 ? matches[0] : undefined;
    let topicId = persisted?.lastTopicId;

    if (topicId !== undefined) {
      const reopened = await this.tryReopenTopic(topicId);
      if (!reopened) topicId = undefined;
    }

    if (topicId === undefined) {
      const created = await this.serializedTopicOperation(() => this.withRateLimitRetry(() =>
        this.bot.api.createForumTopic(this.chatId, `${session.sessionName} (${session.sessionId})`),
      ));
      topicId = created.message_thread_id;
    }

    const binding: TopicBinding = {
      ...session,
      topicId,
      topicUrl: topicUrl(this.chatId, topicId),
    };

    // B7-1 sub-claim B (registry-before-maps): persist to registry BEFORE writing in-memory maps.
    // If upsert throws, maps remain unwritten → no stale binding → session can retry cleanly.
    try {
      await this.registry.upsert({
        sessionName: session.sessionName,
        topicId,
        chatId: this.chatId,
        createdAt: persisted?.createdAt ?? new Date().toISOString(),
        cwd: session.cwd,
        ...(persisted?.model !== undefined && { model: persisted.model }),
        mode: 'afk',
        afkSince: this.mode.since,
        lastTopicId: topicId,
      });
    } catch (err) {
      // F1: Orphan prevention — if upsert fails, close the created topic.
      // Fire-and-forget: don't block the error path on cleanup; don't mask the original error.
      this.bot.api.closeForumTopic(this.chatId, topicId).catch((e) => {
        console.warn(`[afk] Failed to close orphan topic ${topicId}:`, errorText(e));
      });
      throw err;
    }

    this.sessionTopics.set(session.sessionId, binding);
    this.topicSessions.set(topicId, session.sessionId);

    return binding;
  }

  private async tryReopenTopic(topicId: number): Promise<boolean> {
    try {
      await this.serializedTopicOperation(() => this.withRateLimitRetry(() =>
        this.bot.api.reopenForumTopic(this.chatId, topicId),
      ));
      return true;
    } catch (err) {
      const msg = errorText(err).toLowerCase();
      if (msg.includes('not modified') || msg.includes('already open')) return true;
      console.warn(`[afk] Could not reopen topic ${topicId}; creating a new one:`, errorText(err));
      return false;
    }
  }

  private sendAfkActivated(binding: TopicBinding): void {
    this.bridge.sendToSession(binding.sessionId, {
      type: 'afk.activated',
      sessionId: binding.sessionId,
      topicId: binding.topicId,
      topicUrl: binding.topicUrl,
    });
  }

  private async postGeneralSummary(): Promise<void> {
    const lines = [
      '📡 AFK mode active\\.',
      '',
      ...Array.from(this.sessionTopics.values()).map(
        (s) => `• ${escapeTgMdV2(s.sessionName)} \\(${escapeTgMdV2(s.sessionId)}\\) — ${escapeTgMdV2(s.cwd)}`,
      ),
    ];
    const msg = await this.bot.api.sendMessage(this.chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    this.generalSummaryMessageId = msg.message_id;
    try {
      await this.bot.api.pinChatMessage(this.chatId, msg.message_id, { disable_notification: true });
    } catch (err) {
      console.warn('[afk] Failed to pin General summary:', errorText(err));
    }
  }

  private async editGeneralSummary(text: string): Promise<void> {
    if (this.generalSummaryMessageId === undefined) return;
    try {
      await this.bot.api.editMessageText(this.chatId, this.generalSummaryMessageId, text);
    } catch (err) {
      console.warn('[afk] Failed to edit General summary:', errorText(err));
    } finally {
      this.generalSummaryMessageId = undefined;
    }
  }

  private async safeSendMessage(text: string, topicId: number): Promise<void> {
    try {
      // Intentionally omits parse_mode — text sent as plain Telegram, no markdown escape needed.
      // Adding parse_mode in the future requires escaping all user content.
      await this.bot.api.sendMessage(this.chatId, text, { message_thread_id: topicId });
    } catch (err) {
      console.warn(`[afk] Failed to send topic message to ${topicId}:`, errorText(err));
    }
  }

  private async handleDisconnect(sessionId: string): Promise<void> {
    if (!this.mode.active) return;
    const binding = this.sessionTopics.get(sessionId);
    if (!binding) return;
    await this.safeSendMessage('💀 Session ended', binding.topicId);
    await this.serializedTopicOperation(() => this.withRateLimitRetry(() =>
      this.bot.api.closeForumTopic(this.chatId, binding.topicId),
    ));
    this.sessionTopics.delete(sessionId);
    this.topicSessions.delete(binding.topicId);
    this.mirrorRates.delete(sessionId);
    // O(1) cleanup using the sessionRequestIds index instead of O(n) key-scan.
    const requestIds = this.sessionRequestIds.get(sessionId);
    if (requestIds) {
      for (const requestId of requestIds) {
        const key = `${sessionId}:${requestId}`;
        this.streamChains.delete(key);
        this.streamStates.delete(key);
      }
      this.sessionRequestIds.delete(sessionId);
    }
    const existing = this.resolveBindingEntry(binding);
    if (existing) {
      const disconnectedEntry = { ...existing, mode: 'back' as const, lastTopicId: binding.topicId };
      delete disconnectedEntry.afkSince;
      await this.registry.upsert(disconnectedEntry);
    }
  }

  private enqueueStream(sessionId: string, requestId: string, chunk: string, done: boolean): void {
    const key = `${sessionId}:${requestId}`;
    // Track request IDs per session for O(1) disconnect cleanup.
    let ids = this.sessionRequestIds.get(sessionId);
    if (!ids) { ids = new Set(); this.sessionRequestIds.set(sessionId, ids); }
    if (!ids.has(requestId)) ids.add(requestId);

    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleStream(sessionId, requestId, chunk, done))
      .catch((err) => console.warn('[afk] Failed to route stream:', errorText(err)));
    this.streamChains.set(key, next);
    if (done) {
      next.finally(() => {
        this.streamChains.delete(key);
        this.sessionRequestIds.get(sessionId)?.delete(requestId);
      });
    }
  }

  private enqueueStreamError(sessionId: string, requestId: string, error: string): void {
    const key = `${sessionId}:${requestId}`;
    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleStreamError(sessionId, requestId, error))
      .catch((err) => console.warn('[afk] Failed to route stream error:', errorText(err)))
      .finally(() => {
        this.streamChains.delete(key);
        this.sessionRequestIds.get(sessionId)?.delete(requestId);
      });
    this.streamChains.set(key, next);
  }

  private async handleStream(sessionId: string, requestId: string, chunk: string, done: boolean): Promise<void> {
    if (!this.mode.active) return;
    const binding = this.sessionTopics.get(sessionId);
    if (!binding) return;

    const key = `${sessionId}:${requestId}`;
    let state = this.streamStates.get(key);
    if (!state) {
      state = { topicId: binding.topicId, text: '', lastEditAt: 0 };
      this.streamStates.set(key, state);
      const placeholder = await this.bot.api.sendMessage(this.chatId, '…', { message_thread_id: binding.topicId });
      state.messageId = placeholder.message_id;
    }

    try {
      state.text += chunk;
      const now = Date.now();
      if (state.messageId !== undefined && (done || now - state.lastEditAt >= STREAM_EDIT_THROTTLE_MS)) {
        await this.bot.api.editMessageText(this.chatId, state.messageId, state.text || '_(empty response)_');
        state.lastEditAt = now;
      }
    } finally {
      if (done) this.streamStates.delete(key);
    }
  }

  private async handleStreamError(sessionId: string, requestId: string, error: string): Promise<void> {
    const binding = this.sessionTopics.get(sessionId);
    if (!binding) return;
    const key = `${sessionId}:${requestId}`;
    const state = this.streamStates.get(key);
    this.streamStates.delete(key);
    if (state?.messageId !== undefined) {
      await this.bot.api.editMessageText(this.chatId, state.messageId, `❌ Error: ${error}`);
    } else {
      await this.bot.api.sendMessage(this.chatId, `❌ Error: ${error}`, { message_thread_id: binding.topicId });
    }
  }

  private serializedTopicOperation<T>(op: () => Promise<T>): Promise<T> {
    const run = this.topicQueue.catch(() => undefined).then(() => this.runTopicOperationWithGap(op));
    this.topicQueue = run.catch(() => undefined);
    return run;
  }

  private async runTopicOperationWithGap<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } finally {
      await this.delay(TOPIC_OP_GAP_MS);
    }
  }

  private async withRateLimitRetry<T>(op: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await op();
      } catch (err) {
        const rawRetryMs = retryAfterMs(err);
        if (rawRetryMs === undefined || attempt >= MAX_RETRIES) throw err;
        // Cap server-supplied retry_after to 30 s; an uncapped value (e.g. 3600 s) would
        // block the entire topic queue for the full duration on each retry.
        const delayMs = rawRetryMs > 0
          ? Math.min(rawRetryMs, MAX_RATE_LIMIT_DELAY_MS)
          : Math.min(5000, 500 * 2 ** attempt);
        console.warn(
          '[afk] Rate-limited by Telegram (attempt %d/%d): retrying in %d ms — %s',
          attempt + 1, MAX_RETRIES, delayMs, errorText(err),
        );
        await this.delay(delayMs);
        attempt++;
      }
    }
  }

  /**
   * @visibleForTesting — Test-only factory that seeds AFK state from a DTO.
   *
   * Note: streamStates, streamChains, and sessionRequestIds are not seeded —
   * they self-populate on new events.
   */
  public static forTesting(deps: AfkModeControllerDeps, seed: AfkSeedDTO = {}): AfkModeController {
    if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
      throw new Error('AfkModeController.forTesting is test-only');
    }

    const controller = new AfkModeController(
      deps.bot,
      deps.bridge,
      deps.registry,
      deps.chatId,
      deps.delay,
      deps.options,
    );

    if (seed.mode !== undefined) controller.mode = { ...seed.mode };
    controller.sessionTopics.clear();
    controller.topicSessions.clear();
    for (const session of seed.sessions ?? []) {
      const bridgeInfo = deps.bridge.getSessionInfo(session.sessionId);
      const registryEntry = deps.registry.resolve(session.topicId);
      const binding: TopicBinding = {
        sessionId: session.sessionId,
        sessionName: session.sessionName ?? bridgeInfo?.sessionName ?? registryEntry?.sessionName ?? session.sessionId,
        cwd: session.cwd ?? bridgeInfo?.cwd ?? registryEntry?.cwd ?? process.cwd(),
        topicId: session.topicId,
        topicUrl: session.topicUrl ?? topicUrl(deps.chatId, session.topicId),
      };
      controller.sessionTopics.set(session.sessionId, binding);
      controller.topicSessions.set(session.topicId, session.sessionId);
    }
    return controller;
  }
}
