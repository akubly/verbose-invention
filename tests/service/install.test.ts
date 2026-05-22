import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'path';

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
const mockReadFileSync = vi.fn(() => 'TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHAT_ID=12345\n');
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  };
});

// ─── Mock os ─────────────────────────────────────────────────────────────────

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: 'TestUser', uid: -1, gid: -1, shell: null, homedir: 'C:\\Users\\TestUser' })),
  };
});

// ─── Mock readline ───────────────────────────────────────────────────────────

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('test-password')),
    close: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _writeToOutput: (_str: string) => {},
  })),
}));

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
      USERDOMAIN: process.env.USERDOMAIN,
      COMPUTERNAME: process.env.COMPUTERNAME,
    };
    // Deterministic user-resolution values for all install() tests
    process.env.USERDOMAIN = 'TESTDOMAIN';
    vi.clearAllMocks();
    constructedConfig = undefined;
    eventHandlers.clear();
    // Path-aware default: all key files exist
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('main.js')) return true;        // script exists
      // Only match project root package.json, not subdirectory ones
      if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
      if (p.endsWith('.env')) return true;            // .env exists
      return false;
    });
    mockReadFileSync.mockReturnValue('TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHAT_ID=12345\n');
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
    it('creates a Service and calls svc.install() when script exists', async () => {
      await install();

      expect(mockSvcInstall).toHaveBeenCalledOnce();
      expect(constructedConfig).toBeDefined();
      expect(constructedConfig!.name).toBe('Reach');
    });

    it('exits with error when dist/main.js is missing', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('main.js')) return false;       // script missing
        if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
        if (p.endsWith('.env')) return true;             // .env exists
        return false;
      });

      await expect(install()).rejects.toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Script not found'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env file is missing and env vars are not set', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('main.js')) return true;        // script exists
        if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
        if (p.endsWith('.env')) return false;           // .env missing
        return false;
      });

      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      await expect(install()).rejects.toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env is missing and only TELEGRAM_BOT_TOKEN is set', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('main.js')) return true;        // script exists
        if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
        if (p.endsWith('.env')) return false;           // .env missing
        return false;
      });

      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      delete process.env.TELEGRAM_CHAT_ID;

      await expect(install()).rejects.toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('exits with error when .env is missing and only TELEGRAM_CHAT_ID is set', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('main.js')) return true;        // script exists
        if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
        if (p.endsWith('.env')) return false;           // .env missing
        return false;
      });

      delete process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_CHAT_ID = '12345';

      await expect(install()).rejects.toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('required env vars are not set'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
    });

    it('warns but continues when .env is missing but env vars are set', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('main.js')) return true;        // script exists
        if (p.endsWith('package.json')) return p === path.join(process.cwd(), 'package.json');
        if (p.endsWith('.env')) return false;           // .env missing
        return false;
      });

      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '12345';

      await install();

      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('WARNING'),
      );
      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('warns when .env exists but is missing required vars', async () => {
      mockReadFileSync.mockReturnValue('# empty config\nREACH_MODEL=gpt-4\n');
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      await install();

      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Required vars appear missing'),
      );
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_BOT_TOKEN'),
      );
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_CHAT_ID'),
      );
      // Still proceeds with install
      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('does not warn when .env has both required vars', async () => {
      mockReadFileSync.mockReturnValue('TELEGRAM_BOT_TOKEN=abc\nTELEGRAM_CHAT_ID=123\n');

      await install();

      expect(mockConsoleWarn).not.toHaveBeenCalled();
      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('warns and embeds when .env is missing a var but process.env has it', async () => {
      mockReadFileSync.mockReturnValue('TELEGRAM_BOT_TOKEN=abc\n');
      process.env.TELEGRAM_CHAT_ID = '999';

      await install();

      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('embedded from the current environment'),
      );
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_CHAT_ID'),
      );
      expect(mockSvcInstall).toHaveBeenCalledOnce();
      // The missing var should be embedded in service config
      const envNames = constructedConfig!.env.map((e: any) => e.name);
      expect(envNames).toContain('TELEGRAM_CHAT_ID');
    });

    it('exits 0 when alreadyinstalled event fires', async () => {
      await install();

      const handler = eventHandlers.get('alreadyinstalled');
      expect(handler).toBeDefined();
      expect(() => handler!()).toThrow('process.exit(0)');
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('installs service under current user account (not NetworkService)', async () => {
      await install();

      expect(constructedConfig!.logOnAs).toEqual({
        domain: 'TESTDOMAIN',
        account: 'TestUser',
        password: 'test-password',
      });
      expect(constructedConfig!.allowServiceLogon).toBe(true);
    });

    it('exits with error when empty password is entered', async () => {
      const { createInterface } = await import('readline');
      (createInterface as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('')),
        close: vi.fn(),
        _writeToOutput: (_str: string) => {},
      });

      await expect(install()).rejects.toThrow('process.exit(1)');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('requires your Windows password'),
      );
      expect(mockSvcInstall).not.toHaveBeenCalled();
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
      expect(constructedConfig!.workingDirectory).toBe(process.cwd());
    });

    it('does not set logOnAs when no account is provided', () => {
      createService();

      expect(constructedConfig!.logOnAs).toBeUndefined();
      expect(constructedConfig!.allowServiceLogon).toBeUndefined();
    });

    it('sets logOnAs with user account when account is provided', () => {
      createService({
        account: { username: 'AaronSmith', domain: 'MYCOMPANY', password: 'secret' },
      });

      expect(constructedConfig!.logOnAs).toEqual({
        domain: 'MYCOMPANY',
        account: 'AaronSmith',
        password: 'secret',
      });
      expect(constructedConfig!.allowServiceLogon).toBe(true);
    });

    it('does not embed extra env vars by default', () => {
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

    it('embeds provided envOverrides into service config', () => {
      createService({
        envOverrides: [
          { name: 'TELEGRAM_BOT_TOKEN', value: 'tok' },
          { name: 'TELEGRAM_CHAT_ID', value: '999' },
          { name: 'REACH_MODEL', value: 'gpt-4' },
        ],
      });

      const envNames = constructedConfig!.env.map((e: any) => e.name);
      expect(envNames).toContain('NODE_ENV');
      expect(envNames).toContain('TELEGRAM_BOT_TOKEN');
      expect(envNames).toContain('TELEGRAM_CHAT_ID');
      expect(envNames).toContain('REACH_MODEL');

      const tokenEntry = constructedConfig!.env.find((e: any) => e.name === 'TELEGRAM_BOT_TOKEN');
      expect(tokenEntry!.value).toBe('tok');
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

    it('exits with error when no command is provided', async () => {
      process.argv = ['node', 'install.js'];

      await expect(main()).rejects.toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
      );
    });

    it('exits with error when an unknown command is provided', async () => {
      process.argv = ['node', 'install.js', 'restart'];

      await expect(main()).rejects.toThrow('process.exit(1)');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
      );
    });

    it('calls install() when command is "install"', async () => {
      process.argv = ['node', 'install.js', 'install'];

      await main();

      expect(mockSvcInstall).toHaveBeenCalledOnce();
    });

    it('calls uninstall() when command is "uninstall"', () => {
      process.argv = ['node', 'install.js', 'uninstall'];

      main();

      expect(mockSvcUninstall).toHaveBeenCalledOnce();
    });
  });
});
