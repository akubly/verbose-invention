import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// ─── Mock node-windows ───────────────────────────────────────────────────────

type EventHandler = (...args: any[]) => void;

let constructedConfig: Record<string, any> | undefined;
const mockSvcInstall = vi.fn();
const mockSvcUninstall = vi.fn();
const mockSvcStart = vi.fn();
const eventHandlers = new Map<string, EventHandler>();

vi.mock('node-windows', () => {
  class MockService {
    constructor(config: Record<string, any>) {
      constructedConfig = config;
    }
    on(event: string, handler: EventHandler) {
      eventHandlers.set(event, handler);
      return this;
    }
    install() { mockSvcInstall(); }
    uninstall() { mockSvcUninstall(); }
    start() { mockSvcStart(); }
  }
  return { Service: MockService };
});

// ─── Mock fs ─────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn(() => true);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (...args: any[]) => mockExistsSync(...args) };
});

// ─── Spy declarations (initialized in beforeAll) ────────────────────────────

let mockExit: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let mockConsoleLog: ReturnType<typeof vi.spyOn<typeof console, 'log'>>;
let mockConsoleError: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
let mockConsoleWarn: ReturnType<typeof vi.spyOn<typeof console, 'warn'>>;

// ─── Import the REAL module under test ───────────────────────────────────────

import { install, uninstall, createService, main } from '../../src/service/install.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Service installer', () => {
  beforeAll(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      REACH_MODEL: process.env.REACH_MODEL,
    };
    vi.clearAllMocks();
    constructedConfig = undefined;
    eventHandlers.clear();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ── install() ─────────────────────────────────────────────────────────────

  describe('install()', () => {
    it('creates a Service and calls svc.install() when script exists', () => {
      install();

      expect(mockSvcInstall).toHaveBeenCalledOnce();
      expect(constructedConfig).toBeDefined();
      expect(constructedConfig!.name).toBe('Reach');
    });

    it('exits with error when dist/main.js is missing', () => {
      mockExistsSync.mockReturnValue(false);

      expect(() => install()).toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Script not found'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env file is missing and env vars are not set', () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // package.json found (getProjectRoot)
        .mockReturnValueOnce(true)   // script exists
        .mockReturnValueOnce(false); // .env missing

      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      expect(() => install()).toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env is missing and only TELEGRAM_BOT_TOKEN is set', () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // package.json found (getProjectRoot)
        .mockReturnValueOnce(true)   // script exists
        .mockReturnValueOnce(false); // .env missing

      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      delete process.env.TELEGRAM_CHAT_ID;

      expect(() => install()).toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env is missing and only TELEGRAM_CHAT_ID is set', () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // package.json found (getProjectRoot)
        .mockReturnValueOnce(true)   // script exists
        .mockReturnValueOnce(false); // .env missing

      delete process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_CHAT_ID = '12345';

      expect(() => install()).toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('warns but continues when .env is missing but env vars are set', () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // package.json found (getProjectRoot)
        .mockReturnValueOnce(true)   // script exists
        .mockReturnValueOnce(false); // .env missing

      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '12345';

      install();

      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('WARNING'),
      );
      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('exits 0 when alreadyinstalled event fires', () => {
      install();

      const handler = eventHandlers.get('alreadyinstalled');
      expect(handler).toBeDefined();
      expect(() => handler!()).toThrow('process.exit(0)');
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  // ── uninstall() ───────────────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('creates a Service and calls svc.uninstall()', () => {
      uninstall();

      expect(mockSvcUninstall).toHaveBeenCalledOnce();
      expect(constructedConfig).toBeDefined();
      expect(constructedConfig!.name).toBe('Reach');
    });
  });

  // ── createService() ───────────────────────────────────────────────────────

  describe('createService()', () => {
    it('returns a Service with correct name, script path, and workingDirectory', () => {
      const svc = createService();

      expect(svc).toBeDefined();
      expect(constructedConfig).toBeDefined();
      expect(constructedConfig!.name).toBe('Reach');
      expect(constructedConfig!.script).toMatch(/main\.js$/);
      expect(constructedConfig!.workingDirectory).toBeDefined();
    });

    it('runs as NetworkService via logOnAs', () => {
      createService();

      expect(constructedConfig!.logOnAs).toEqual({
        domain: 'NT AUTHORITY',
        account: 'NetworkService',
      });
      expect(constructedConfig!.allowServiceLogon).toBe(true);
    });

    it('does not embed secrets when embedEnv is false (default)', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '999';
      process.env.REACH_MODEL = 'gpt-4';

      createService();

      const envNames = constructedConfig!.env.map((e: any) => e.name);
      expect(envNames).toContain('NODE_ENV');
      expect(envNames).not.toContain('TELEGRAM_BOT_TOKEN');
      expect(envNames).not.toContain('TELEGRAM_CHAT_ID');
      expect(envNames).not.toContain('REACH_MODEL');

      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      delete process.env.REACH_MODEL;
    });

    it('embeds secrets when embedEnv is true', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '999';
      process.env.REACH_MODEL = 'gpt-4';

      createService({ embedEnv: true });

      const envNames = constructedConfig!.env.map((e: any) => e.name);
      expect(envNames).toContain('NODE_ENV');
      expect(envNames).toContain('TELEGRAM_BOT_TOKEN');
      expect(envNames).toContain('TELEGRAM_CHAT_ID');
      expect(envNames).toContain('REACH_MODEL');

      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      delete process.env.REACH_MODEL;
    });
  });

  // ── main() ──────────────────────────────────────────────────────────────

  describe('main()', () => {
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('exits with error when no command is provided', () => {
      process.argv = ['node', 'install.js'];

      expect(() => main()).toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
      );
    });

    it('exits with error when an unknown command is provided', () => {
      process.argv = ['node', 'install.js', 'restart'];

      expect(() => main()).toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
      );
    });

    it('calls install() when command is "install"', () => {
      process.argv = ['node', 'install.js', 'install'];

      main();

      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('calls uninstall() when command is "uninstall"', () => {
      process.argv = ['node', 'install.js', 'uninstall'];

      main();

      expect(mockSvcUninstall).toHaveBeenCalledOnce();
    });
  });
});
