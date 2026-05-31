/**
 * /cwd command group — anticipatory tests (Phase 9 Item 3, Task T6).
 *
 * STATUS: RED until Carter lands the /cwd command handler.
 * Tests will fail with "commandHandlers.get('cwd') is undefined" until then.
 *
 * ─── Assumed API shape (Carter's T6 contract) ────────────────────────────────
 *
 * Carter adds `configPath?: string` to HandlerOptions (src/bot/handlers.ts).
 * The /cwd command is registered via `bot.command('cwd', handler)` inside
 * registerHandlers(). ctx.match is everything after '/cwd '.
 *
 * Subcommand dispatch:
 *   /cwd list (or bare /cwd)  → lists known cwds or empty-state message
 *   /cwd add <alias> <path>   → validates alias + path, persists, replies
 *   /cwd remove <alias>       → checks alias exists, removes, persists, replies
 *   /cwd <unknown>            → usage help
 *
 * General-topic-only (Aaron's locked decision):
 *   ctx.message.message_thread_id is set  → friendly refusal, no state change
 *   ctx.message.message_thread_id is absent → proceed normally
 *
 * Persistence: loadConfig(configPath) → transform → saveConfig(configPath, newConfig).
 * Atomic write semantics are Kat's responsibility (config.ts saveConfig) and are
 * already tested in tests/config/config.test.ts. Here we only assert saveConfig
 * was called with the right arguments.
 *
 * ─── Adjustments if Carter diverges ─────────────────────────────────────────
 * - Different file: update import path for registerHandlers
 * - Different option name (e.g., configLoader instead of configPath):
 *   update HandlerOptions construction below
 * - /cwd registered as separate function: import + call that instead
 * See .squad/decisions/inbox/jun-phase9-item3-tests.md for rationale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import { makeMockFactory } from '../mocks/sdk.js';
import { makeMockBot } from '../helpers/botMocks.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const {
  mockLoadConfig,
  mockSaveConfig,
  mockValidateAlias,
  mockValidatePath,
  mockAddKnownCwd,
  mockRemoveKnownCwd,
  mockListKnownCwds,
  mockGetKnownCwdByAlias,
} = vi.hoisted(() => ({
  mockLoadConfig:        vi.fn(),
  mockSaveConfig:        vi.fn(),
  mockValidateAlias:     vi.fn(),
  mockValidatePath:      vi.fn(),
  mockAddKnownCwd:       vi.fn(),
  mockRemoveKnownCwd:    vi.fn(),
  mockListKnownCwds:     vi.fn(),
  mockGetKnownCwdByAlias: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/config.js')>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  };
});

vi.mock('../../src/config/knownCwds.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/knownCwds.js')>();
  return {
    ...actual,
    validateAlias:      (...args: unknown[]) => mockValidateAlias(...args),
    validatePath:       (...args: unknown[]) => mockValidatePath(...args),
    addKnownCwd:        (...args: unknown[]) => mockAddKnownCwd(...args),
    removeKnownCwd:     (...args: unknown[]) => mockRemoveKnownCwd(...args),
    listKnownCwds:      (...args: unknown[]) => mockListKnownCwds(...args),
    getKnownCwdByAlias: (...args: unknown[]) => mockGetKnownCwdByAlias(...args),
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_CONFIG_PATH = '/test/reach/config.json';
const ALIAS = 'myrepo';
const CWD_PATH = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo';
const NOW = '2024-06-01T00:00:00.000Z';

/**
 * ctx for the General Topic (no message_thread_id → /cwd is allowed).
 * Pass inSessionTopic = true to simulate a session topic (/cwd must be refused).
 */
function makeCwdCtx(matchText: string, inSessionTopic = false) {
  return {
    message: {
      message_thread_id: inSessionTopic ? 42 : undefined,
      text: matchText ? `/cwd ${matchText}` : '/cwd',
    },
    match: matchText,
    chat: { id: -1001234567890 },
    reply: vi.fn().mockResolvedValue({ message_id: 100 }),
    api:   { editMessageText: vi.fn() },
  };
}

function makeKnownEntry(alias = ALIAS, path = CWD_PATH) {
  return { alias, path, addedAt: NOW };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('/cwd command group (T6 — awaiting Carter)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
    vi.clearAllMocks();

    // Default happy-path stubs — override per test as needed
    mockLoadConfig.mockResolvedValue({});
    mockSaveConfig.mockResolvedValue(undefined);
    mockValidateAlias.mockReturnValue({ ok: true });
    mockValidatePath.mockResolvedValue({ ok: true, normalized: CWD_PATH });
    mockAddKnownCwd.mockImplementation((cfg: any, alias: string, path: string, now: string) => ({
      ...cfg,
      knownCwds: [...(cfg.knownCwds ?? []), { alias, path, addedAt: now }],
    }));
    mockRemoveKnownCwd.mockImplementation((cfg: any, alias: string) => ({
      ...cfg,
      knownCwds: (cfg.knownCwds ?? []).filter((c: any) => c.alias !== alias),
    }));
    mockListKnownCwds.mockReturnValue([]);
    mockGetKnownCwdByAlias.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── /cwd list ───────────────────────────────────────────────────────────────

  it('/cwd list — empty registry → replies with empty-state message', async () => {
    mockListKnownCwds.mockReturnValue([]);
    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const handler = commandHandlers.get('cwd')!;
    const ctx = makeCwdCtx('list');
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText.toLowerCase()).toMatch(/no known|no cwd|empty/);
  });

  it('/cwd list — populated registry → reply contains alias and path for each entry', async () => {
    const entries = [
      makeKnownEntry('repo-a', CWD_PATH),
      makeKnownEntry('repo-b', CWD_PATH.replace('myrepo', 'other')),
    ];
    mockListKnownCwds.mockReturnValue(entries);
    mockLoadConfig.mockResolvedValue({ knownCwds: entries });

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx('list');
    await commandHandlers.get('cwd')!(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toContain('repo-a');
    expect(replyText).toContain('repo-b');
  });

  it('/cwd bare (empty match) → defaults to list behaviour', async () => {
    mockListKnownCwds.mockReturnValue([]);
    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(''); // ctx.match = ''
    await commandHandlers.get('cwd')!(ctx);

    // Should produce a list reply (empty state), NOT an error about unknown subcommand
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  // ── /cwd add ────────────────────────────────────────────────────────────────

  it('/cwd add <alias> <path> happy path → validates, persists, replies success', async () => {
    const newConfig = { knownCwds: [makeKnownEntry()] };
    mockAddKnownCwd.mockReturnValue(newConfig);

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`add ${ALIAS} ${CWD_PATH}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockValidateAlias).toHaveBeenCalledWith(ALIAS);
    expect(mockValidatePath).toHaveBeenCalledWith(CWD_PATH);
    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, newConfig);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/✅|added|success/i);
  });

  it('/cwd add — invalid alias → friendly error, saveConfig NOT called', async () => {
    mockValidateAlias.mockReturnValue({ ok: false, reason: 'starts with hyphen' });

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`add -bad ${CWD_PATH}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|error|invalid/i);
  });

  it('/cwd add — invalid path → friendly error, saveConfig NOT called', async () => {
    mockValidatePath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`add ${ALIAS} ${CWD_PATH}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|error|not exist/i);
  });

  it('/cwd add — alias collision → friendly error, saveConfig NOT called', async () => {
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    // If Carter checks via getKnownCwdByAlias first:
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    // If Carter calls addKnownCwd which throws:
    mockAddKnownCwd.mockImplementation(() => {
      throw new Error(`Alias "${ALIAS}" already exists in knownCwds`);
    });

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`add ${ALIAS} ${CWD_PATH}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toMatch(/❌|error|already|collision/i);
  });

  // ── /cwd remove ─────────────────────────────────────────────────────────────

  it('/cwd remove <alias> — alias exists → removes, persists, replies success', async () => {
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    const newConfig = { knownCwds: [] };
    mockRemoveKnownCwd.mockReturnValue(newConfig);

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`remove ${ALIAS}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, newConfig);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/✅|removed|success/i);
  });

  it('/cwd remove <alias> — alias missing → friendly "not found" error, saveConfig NOT called', async () => {
    mockLoadConfig.mockResolvedValue({ knownCwds: [] });
    mockGetKnownCwdByAlias.mockReturnValue(undefined);

    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`remove ${ALIAS}`);
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|not found|unknown/i);
  });

  // ── unknown subcommand ───────────────────────────────────────────────────────

  it('/cwd unknownsub → usage reply, no state change', async () => {
    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx('unknownsub');
    await commandHandlers.get('cwd')!(ctx);

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    // Should mention valid subcommands or be a usage string
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toMatch(/usage|list|add|remove|❌/i);
  });

  // ── general-topic-only guard ─────────────────────────────────────────────────

  it('general-topic-only: /cwd in a session topic → friendly refusal, no state change', async () => {
    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry(),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx('list', /* inSessionTopic */ true);
    await commandHandlers.get('cwd')!(ctx);

    // Config must not be touched
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toMatch(/general|topic|❌/i);
  });

  // ── removing alias for an active session's cwd ───────────────────────────────

  it('removing alias for an active session cwd — succeeds; session itself is unaffected', async () => {
    // The registry still has the session entry (session keeps running).
    // The cwd registry entry simply disappears from config.
    const existingEntry = makeKnownEntry();
    mockLoadConfig.mockResolvedValue({ knownCwds: [existingEntry] });
    mockGetKnownCwdByAlias.mockReturnValue(existingEntry);
    mockRemoveKnownCwd.mockReturnValue({ knownCwds: [] });

    const sessionEntry: SessionEntry = {
      sessionName: 'active-session',
      topicId: 99,
      chatId: -1001234567890,
      createdAt: NOW,
      cwd: CWD_PATH,
    };
    const { bot, commandHandlers } = makeMockBot();
    registerHandlers({
      bot: bot as any,
      registry: makeStubRegistry([sessionEntry]),
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeCwdCtx(`remove ${ALIAS}`);
    await commandHandlers.get('cwd')!(ctx);

    // The remove still persists without error; the running session is untouched
    expect(mockSaveConfig).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/✅|removed|success/i);
  });
});
