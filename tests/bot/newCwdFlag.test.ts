/**
 * /new --cwd flag — anticipatory tests (Phase 9 Item 3, Task T7).
 *
 * STATUS: RED until Carter lands the --cwd parser in the /new command handler.
 *
 * ─── Assumed API shape (Carter's T7 contract) ────────────────────────────────
 *
 * Carter extends the /new handler in registerHandlers() to parse an optional
 * `--cwd <value>` flag from ctx.match:
 *
 *   ctx.match = '<session-name> [--cwd <value>] [--model <model>]'
 *
 * Disambiguation (Kat's decision, §4 of kat-phase9-item3-config-schema.md):
 *   1. Looks like an absolute path?
 *      Windows: starts with '<letter>:\\' or '\\\\'
 *      Unix:    starts with '/'
 *      → call validatePath(); use normalized path.
 *   2. Otherwise → alias lookup.
 *      getKnownCwdByAlias(config, value)
 *      hit  → use entry.path; call touchKnownCwd + saveConfig
 *      miss → friendly error, abort session creation
 *
 * Resolved path is passed to registry.register(..., cwd) so the SessionEntry
 * records the correct working directory.
 *
 * ─── Adjustments if Carter diverges ─────────────────────────────────────────
 * - Different option key: update HandlerOptions cast below
 * - Different path-detection regex: update test values accordingly
 * - UNC treated differently (design doc §Q3 says reject UNC): adjust
 *   the UNC test if Carter's real behaviour differs
 * See .squad/decisions/inbox/jun-phase9-item3-tests.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/types.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const {
  mockLoadConfig,
  mockSaveConfig,
  mockValidatePath,
  mockGetKnownCwdByAlias,
  mockTouchKnownCwd,
} = vi.hoisted(() => ({
  mockLoadConfig:         vi.fn(),
  mockSaveConfig:         vi.fn(),
  mockValidatePath:       vi.fn(),
  mockGetKnownCwdByAlias: vi.fn(),
  mockTouchKnownCwd:      vi.fn(),
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
    validatePath:       (...args: unknown[]) => mockValidatePath(...args),
    getKnownCwdByAlias: (...args: unknown[]) => mockGetKnownCwdByAlias(...args),
    touchKnownCwd:      (...args: unknown[]) => mockTouchKnownCwd(...args),
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

type HandlerFn = (ctx: any) => Promise<void>;

const TEST_CONFIG_PATH = '/test/reach/config.json';
const SESSION_NAME     = 'my-project';
const ALIAS            = 'myrepo';
const ABS_PATH         = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo';
const NOW              = '2024-06-01T00:00:00.000Z';
const TOPIC_ID         = 42;
const CHAT_ID          = -1001234567890;

function makeMockBot() {
  const commandHandlers = new Map<string, HandlerFn>();
  const onHandlers      = new Map<string, HandlerFn>();
  const bot = {
    command: vi.fn((name: string, handler: HandlerFn) => {
      commandHandlers.set(name, handler);
    }),
    on:    vi.fn((event: string, h: HandlerFn) => { onHandlers.set(event, h); }),
    catch: vi.fn(),
  };
  return { bot, commandHandlers, onHandlers };
}

function makeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    load:          vi.fn(),
    register:      vi.fn(),
    upsert:        vi.fn(),
    resolve:       vi.fn((id: number) => map.get(id)),
    findByName:    vi.fn(),
    findAllByName: vi.fn(() => []),
    list:          vi.fn(() => Array.from(map.values())),
    remove:        vi.fn(),
    move:          vi.fn(),
  } as unknown as ISessionRegistry;
}

function makeNewCtx(matchText: string) {
  return {
    message: {
      message_thread_id: TOPIC_ID,
      text: `/new ${matchText}`,
    },
    match: matchText,
    chat:  { id: CHAT_ID },
    reply: vi.fn().mockResolvedValue({
      message_id: 100,
      chat: { id: CHAT_ID },
    }),
    api:   { editMessageText: vi.fn() },
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('/new --cwd flag (T7 — awaiting Carter)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
    vi.clearAllMocks();

    mockLoadConfig.mockResolvedValue({});
    mockSaveConfig.mockResolvedValue(undefined);
    // Default: validatePath accepts any input
    mockValidatePath.mockResolvedValue({ ok: true, normalized: ABS_PATH });
    // Default: alias lookup misses
    mockGetKnownCwdByAlias.mockReturnValue(undefined);
    // Default: touchKnownCwd is a no-op identity function
    mockTouchKnownCwd.mockImplementation((cfg: any) => cfg);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Regression: no --cwd → existing behaviour unchanged ─────────────────────

  it('/new <name> (no --cwd) → session registered with default cwd, no config load', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(SESSION_NAME);
    await commandHandlers.get('new')!(ctx);

    // registry.register called (session created)
    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[2]).toBe(SESSION_NAME); // third arg = session name

    // --cwd path: cwd arg (index 4) should be absent / undefined
    expect(callArgs[4]).toBeUndefined();

    // No config I/O for --cwd resolution
    expect(mockGetKnownCwdByAlias).not.toHaveBeenCalled();
    expect(mockValidatePath).not.toHaveBeenCalled();
  });

  // ── Path branch ──────────────────────────────────────────────────────────────

  it('/new <name> --cwd <abs-path> → path branch: validatePath called, resolved cwd passed to register', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd ${ABS_PATH}`);
    await commandHandlers.get('new')!(ctx);

    expect(mockValidatePath).toHaveBeenCalledWith(ABS_PATH);
    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // cwd is the fifth arg (topicId, chatId, sessionName, model?, cwd?)
    expect(callArgs[4]).toBe(ABS_PATH); // validatePath returned ABS_PATH as normalized
  });

  it('/new --cwd with invalid path → validatePath rejects → friendly error, no register', async () => {
    mockValidatePath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd ${ABS_PATH}`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|error|not exist/i);
  });

  it.skipIf(process.platform !== 'win32')(
    '/new --cwd UNC path (\\\\server\\share) → path branch → validatePath rejects UNC → friendly error',
    async () => {
      mockValidatePath.mockResolvedValue({
        ok: false,
        reason: 'UNC network paths are not supported',
      });

      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      registerHandlers({
        bot: bot as any,
        registry,
        factory: makeMockFactory(),
        globalModel: 'test-model',
        configPath: TEST_CONFIG_PATH,
      } as any);

      const ctx = makeNewCtx(`${SESSION_NAME} --cwd \\\\server\\share`);
      await commandHandlers.get('new')!(ctx);

      expect(registry.register).not.toHaveBeenCalled();
      // Friendly error from validatePath propagated
      expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|UNC|error/i);
    },
  );

  // ── Alias branch ─────────────────────────────────────────────────────────────

  it('/new <name> --cwd <alias> hit → resolves path, touches lastUsedAt, register with resolved path', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    const configWithAlias = { knownCwds: [entry] };
    const touchedConfig   = { knownCwds: [{ ...entry, lastUsedAt: NOW }] };

    mockLoadConfig.mockResolvedValue(configWithAlias);
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue(touchedConfig);

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd ${ALIAS}`);
    await commandHandlers.get('new')!(ctx);

    // Alias lookup
    expect(mockGetKnownCwdByAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
    // lastUsedAt updated and persisted
    expect(mockTouchKnownCwd).toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(TEST_CONFIG_PATH, touchedConfig);
    // Session registered with the resolved path
    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new <name> --cwd <unknown-alias> → alias miss → friendly error, no register', async () => {
    mockLoadConfig.mockResolvedValue({});
    mockGetKnownCwdByAlias.mockReturnValue(undefined); // miss

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd unknown-alias`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toMatch(/❌|unknown|not found|alias/i);
  });

  // ── Flag parsing edge cases ───────────────────────────────────────────────────

  it('/new <name> --cwd (no value) → usage reply, no register', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/❌|usage|cwd/i);
  });

  it('/new <name> --cwd <alias> --model <model> → both flags honored', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    mockLoadConfig.mockResolvedValue({ knownCwds: [entry] });
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue({ knownCwds: [{ ...entry, lastUsedAt: NOW }] });

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd ${ALIAS} --model claude-sonnet`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // model is 4th arg (index 3), cwd is 5th (index 4)
    expect(callArgs[3]).toBe('claude-sonnet');
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  it('/new <name> --model <model> --cwd <alias> → flags in reverse order also work', async () => {
    const entry = { alias: ALIAS, path: ABS_PATH, addedAt: NOW };
    mockLoadConfig.mockResolvedValue({ knownCwds: [entry] });
    mockGetKnownCwdByAlias.mockReturnValue(entry);
    mockTouchKnownCwd.mockReturnValue({ knownCwds: [{ ...entry, lastUsedAt: NOW }] });

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --model claude-sonnet --cwd ${ALIAS}`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).toHaveBeenCalledOnce();
    const callArgs = (registry.register as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('claude-sonnet');
    expect(callArgs[4]).toBe(ABS_PATH);
  });

  // ── Spoofed-prefix edge case ─────────────────────────────────────────────────

  it('/new --cwd myrepoxyz (non-alias, non-absolute) → alias lookup miss → friendly error', async () => {
    // 'myrepoxyz' is not in BOT_COMMANDS and doesn't look like an absolute path,
    // so it goes to the alias branch. The alias is not found → error.
    mockGetKnownCwdByAlias.mockReturnValue(undefined);

    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd myrepoxyz`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).not.toHaveBeenCalled();
  });

  // ── Relay after session is registered ────────────────────────────────────────

  it('/new <name> --cwd <path> success → reply includes session name and success indicator', async () => {
    // Confirms the success reply (not relay) is sent when register succeeds.
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    registerHandlers({
      bot: bot as any,
      registry,
      factory: makeMockFactory(makeMockSession(['ok'])),
      globalModel: 'test-model',
      configPath: TEST_CONFIG_PATH,
    } as any);

    const ctx = makeNewCtx(`${SESSION_NAME} --cwd ${ABS_PATH}`);
    await commandHandlers.get('new')!(ctx);

    expect(registry.register).toHaveBeenCalledOnce();
    const replyText: string = ctx.reply.mock.calls[0][0];
    expect(replyText).toMatch(/✅|registered|success/i);
    expect(replyText).toContain(SESSION_NAME);
  });
});
