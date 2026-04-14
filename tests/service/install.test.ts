import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ─── Mock process.exit ───────────────────────────────────────────────────────

const mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`);
});

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

// ─── Import the REAL module under test ───────────────────────────────────────

import { install, uninstall, createService } from '../../src/service/install.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Service installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructedConfig = undefined;
    eventHandlers.clear();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    it('logs a warning but continues when .env file is missing', () => {
      // First call: existsSync(scriptPath) → true
      // Second call: existsSync(envPath) → false
      mockExistsSync
        .mockReturnValueOnce(true)   // script exists
        .mockReturnValueOnce(false); // .env missing

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
  });
});
