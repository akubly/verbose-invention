import type { Bot, Context } from 'grammy';
import type { ISessionRegistry } from '../sessions/registry.js';
import type { ExtensionBridge } from '../bridge/extensionBridge.js';

export interface BridgeSessionInfo {
  sessionId: string;
  sessionName: string;
  cwd: string;
}

interface TopicBinding extends BridgeSessionInfo {
  topicId: number;
  topicUrl: string;
}

interface ModeState {
  active: boolean;
  since: string;
}

interface StreamState {
  topicId: number;
  text: string;
  messageId?: number;
  lastEditAt: number;
}

interface AfkModeOptions {
  allowedUserIds?: ReadonlySet<number>;
  allowTelegramInput?: boolean;
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

  constructor(
    private readonly bot: Bot<Context>,
    private readonly bridge: ExtensionBridge,
    private readonly registry: ISessionRegistry,
    private readonly chatId: number,
    private readonly delay: (ms: number) => Promise<void> = sleep,
    private readonly options: AfkModeOptions = {},
  ) {
    this.bridge.on('afk.request', (sessionId) => { void this.activate(sessionId); });
    this.bridge.on('back.request', () => { void this.deactivate(); });
    this.bridge.on('session.disconnected', (sessionId) => { void this.handleDisconnect(sessionId); });
    this.bridge.on('stream', (sessionId, requestId, chunk, done) => {
      this.enqueueStream(sessionId, requestId, chunk, done);
    });
    this.bridge.on('stream.error', (sessionId, requestId, error) => {
      this.enqueueStreamError(sessionId, requestId, error);
    });
    this.bridge.setRegistrationAugmenter?.((session) => this.registrationExtras(session));
  }

  isActive(): boolean {
    return this.mode.active;
  }

  async handleTelegramMessage(ctx: Context): Promise<boolean> {
    if (!this.mode.active) return false;
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
    const current = this.mirrorRates.get(sessionId);
    if (!current || now - current.windowStartMs >= MIRROR_RATE_WINDOW_MS) {
      this.mirrorRates.set(sessionId, { windowStartMs: now, count: 1 });
      return true;
    }
    if (current.count >= MIRROR_RATE_LIMIT) return false;
    current.count++;
    return true;
  }

  private async activate(requestingSessionId: string): Promise<void> {
    if (this.mode.active) {
      if (this.activationPromise !== undefined) {
        await this.activationPromise;
        return;
      }
      const info = this.bridge.getSessionInfo(requestingSessionId);
      if (info) {
        const binding = await this.ensureTopic(info);
        this.sendAfkActivated(binding);
      }
      return;
    }

    this.mode = { active: true, since: new Date().toISOString() };
    this.activationPromise = this.activateAllSessions();
    try {
      await this.activationPromise;
    } finally {
      this.activationPromise = undefined;
    }
  }

  private async activateAllSessions(): Promise<void> {
    const sessions = this.bridge.listSessions();

    for (const session of sessions) {
      const binding = await this.ensureTopic(session);
      this.sendAfkActivated(binding);
      await this.safeSendMessage(
        `📡 AFK mode active. Telegram mirror ready for ${binding.sessionName} (${binding.sessionId}).`,
        binding.topicId,
      );
    }

    await this.postGeneralSummary();
    this.bridge.broadcastToSessions({ type: 'mode.changed', active: true, since: this.mode.since });
  }

  private async deactivate(): Promise<void> {
    if (this.activationPromise !== undefined) {
      await this.activationPromise;
    }
    if (!this.mode.active) {
      console.warn('[afk] /back requested while AFK mode is inactive — no-op');
      return;
    }

    const bindings = Array.from(this.sessionTopics.values());
    for (const binding of bindings) {
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
    }

    await this.editGeneralSummary('🖥️ Back at desk.');

    this.mode = { active: false, since: new Date().toISOString() };
    this.sessionTopics.clear();
    this.topicSessions.clear();
    this.streamStates.clear();
    this.streamChains.clear();
    this.mirrorRates.clear();

    for (const session of this.bridge.listSessions()) {
      this.bridge.sendToSession(session.sessionId, { type: 'back.confirmed', sessionId: session.sessionId });
    }
    this.bridge.broadcastToSessions({ type: 'mode.changed', active: false, since: this.mode.since });
  }

  private resolveBindingEntry(binding: TopicBinding) {
    return typeof this.registry.resolve === 'function'
      ? this.registry.resolve(binding.topicId)
      : this.registry.findByName(binding.sessionName);
  }

  private async registrationExtras(session: BridgeSessionInfo): Promise<Record<string, unknown>> {
    if (!this.mode.active) return {};
    const binding = await this.ensureTopic(session);
    return { mode: { active: true, since: this.mode.since }, topicId: binding.topicId };
  }

  private async ensureTopic(session: BridgeSessionInfo): Promise<TopicBinding> {
    const existingBinding = this.sessionTopics.get(session.sessionId);
    if (existingBinding) return existingBinding;

    const matches = typeof this.registry.findAllByName === 'function'
      ? this.registry.findAllByName(session.sessionName)
      : [this.registry.findByName(session.sessionName)].filter((entry) => entry !== undefined);
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
    this.sessionTopics.set(session.sessionId, binding);
    this.topicSessions.set(topicId, session.sessionId);

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
      '📡 AFK mode active.',
      '',
      ...Array.from(this.sessionTopics.values()).map((s) => `• ${s.sessionName} (${s.sessionId}) — ${s.cwd}`),
    ];
    const msg = await this.bot.api.sendMessage(this.chatId, lines.join('\n'));
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
    for (const key of Array.from(this.streamChains.keys())) {
      if (key.startsWith(`${sessionId}:`)) this.streamChains.delete(key);
    }
    for (const key of Array.from(this.streamStates.keys())) {
      if (key.startsWith(`${sessionId}:`)) this.streamStates.delete(key);
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
    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleStream(sessionId, requestId, chunk, done))
      .catch((err) => console.warn('[afk] Failed to route stream:', errorText(err)));
    this.streamChains.set(key, next);
    if (done) next.finally(() => this.streamChains.delete(key));
  }

  private enqueueStreamError(sessionId: string, requestId: string, error: string): void {
    const key = `${sessionId}:${requestId}`;
    const next = (this.streamChains.get(key) ?? Promise.resolve())
      .then(() => this.handleStreamError(sessionId, requestId, error))
      .catch((err) => console.warn('[afk] Failed to route stream error:', errorText(err)))
      .finally(() => this.streamChains.delete(key));
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
        const retryMs = retryAfterMs(err);
        if (retryMs === undefined || attempt >= MAX_RETRIES) throw err;
        await this.delay(retryMs > 0 ? retryMs : Math.min(5000, 500 * 2 ** attempt));
        attempt++;
      }
    }
  }
}
