#!/usr/bin/env node

/**
 * Reach — Windows Service installer/uninstaller
 *
 * Usage:
 *   node dist/service/install.js install
 *   node dist/service/install.js uninstall
 *
 * Requires administrative privileges.
 */

// @ts-expect-error TS7016 - node-windows lacks TypeScript types
import { Service } from 'node-windows';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getScriptPath(): string {
  return path.resolve(__dirname, '..', 'main.js');
}

function getProjectRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback: getScriptPath() points at dist/main.js → dirname gives dist/, one level up is project root
  return path.resolve(path.dirname(getScriptPath()), '..');
}

function parseEnvFile(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars.set(key, value);
  }
  return vars;
}

/** Minimal type for the object returned by node-windows Service constructor. */
export interface ServiceInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
  install(): void;
  uninstall(): void;
  start(): void;
}

export interface CreateServiceOptions {
  /** Specific env vars to embed in the service config (e.g., vars missing from .env but available in process.env). */
  envOverrides?: Array<{ name: string; value: string }>;
}

export function createService(options: CreateServiceOptions = {}): ServiceInstance {
  const scriptPath = getScriptPath();
  const workingDirectory = getProjectRoot();
  const { envOverrides = [] } = options;

  const env: Array<{ name: string; value: string }> = [
    { name: 'NODE_ENV', value: 'production' },
    ...envOverrides,
  ];

  const svc = new Service({
    name: 'Reach',
    description: 'Telegram ↔ GitHub Copilot CLI session bridge',
    script: scriptPath,
    nodeOptions: ['--enable-source-maps'],
    workingDirectory: workingDirectory,
    env,
    logOnAs: { domain: 'NT AUTHORITY', account: 'NetworkService' },
    allowServiceLogon: true,
  });

  return svc as ServiceInstance;
}

export function install(): void {
  const scriptPath = getScriptPath();
  
  if (!fs.existsSync(scriptPath)) {
    console.error(`[reach] ERROR: Script not found at ${scriptPath}`);
    console.error('[reach] HINT: Run "npm run build" first to compile the project.');
    process.exit(1);
  }

  const projectRoot = getProjectRoot();
  const envPath = path.join(projectRoot, '.env');
  const hasEnvFile = fs.existsSync(envPath);
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!process.env.TELEGRAM_CHAT_ID;

  if (!hasEnvFile && (!hasToken || !hasChatId)) {
    console.error(`[reach] ERROR: No .env file found at ${envPath} and required env vars are not set.`);
    console.error('[reach] The service requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to run.');
    console.error('[reach] Either create a .env file at the project root or export both env vars before installing.');
    process.exit(1);
  }

  const envOverrides: Array<{ name: string; value: string }> = [];

  if (!hasEnvFile) {
    console.warn(`[reach] WARNING: No .env file found at ${envPath}`);
    console.warn('[reach] Proceeding because both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in the environment.');
    // No .env — embed all available secrets from process.env
    if (process.env.TELEGRAM_BOT_TOKEN) {
      envOverrides.push({ name: 'TELEGRAM_BOT_TOKEN', value: process.env.TELEGRAM_BOT_TOKEN });
    }
    if (process.env.TELEGRAM_CHAT_ID) {
      envOverrides.push({ name: 'TELEGRAM_CHAT_ID', value: process.env.TELEGRAM_CHAT_ID });
    }
    if (process.env.REACH_MODEL) {
      envOverrides.push({ name: 'REACH_MODEL', value: process.env.REACH_MODEL });
    }
  } else {
    // .env exists — embed only required vars missing from the file
    let envVars: Map<string, string>;
    try {
      envVars = parseEnvFile(envPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not read .env file: ${message}`);
      process.exit(1);
    }
    const requiredKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;
    const missingFromBoth: string[] = [];

    for (const key of requiredKeys) {
      if (!envVars.get(key)) {
        if (process.env[key]) {
          envOverrides.push({ name: key, value: process.env[key]! });
        } else {
          missingFromBoth.push(key);
        }
      }
    }

    if (envOverrides.length > 0) {
      console.warn('[reach] WARNING: The following required vars are missing from .env and will be');
      console.warn('[reach] embedded from the current environment (reinstall to change):');
      for (const entry of envOverrides) {
        console.warn(`[reach]   - ${entry.name}`);
      }
    }

    if (missingFromBoth.length > 0) {
      console.warn(`[reach] WARNING: Required vars appear missing or empty in ${envPath}:`);
      for (const key of missingFromBoth) {
        console.warn(`[reach]   - ${key}`);
      }
      console.warn('[reach] The service may fail to start without them.');
    }
  }

  const svc = createService({ envOverrides });

  svc.on('install', () => {
    console.log('[reach] Service installed successfully.');
    console.log('[reach] Starting service...');
    svc.start();
  });

  svc.on('start', () => {
    console.log('[reach] Service started.');
    console.log('[reach] The Reach daemon is now running as a Windows Service.');
    console.log('[reach] You can manage it via Services (services.msc) or:');
    console.log('[reach]   NET START Reach');
    console.log('[reach]   NET STOP Reach');
    console.log('[reach]');
    if (hasEnvFile && envOverrides.length > 0) {
      console.log('[reach] Config: reading from .env at runtime; some vars embedded at install time.');
      console.log('[reach] Embedded vars require reinstall to change; .env vars do not.');
    } else if (hasEnvFile) {
      console.log('[reach] Config: reading from .env at runtime (edit .env without reinstalling).');
    } else {
      console.log('[reach] Config: env vars embedded at install time (reinstall to change).');
    }
    console.log('[reach] Required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
    console.log('[reach] Optional: REACH_MODEL (default: claude-sonnet-4)');
    process.exit(0);
  });

  svc.on('alreadyinstalled', () => {
    console.log('[reach] Service is already installed.');
    console.log('[reach] Run "npm run service:uninstall" first if you want to reinstall.');
    process.exit(0);
  });

  svc.on('error', (err: Error) => {
    console.error('[reach] Service installation error:', err.message);
    if (err.message.includes('Permission')) {
      console.error('[reach] HINT: Run this command as Administrator (elevated privileges required).');
    }
    process.exit(1);
  });

  console.log('[reach] Installing Reach as a Windows Service...');
  console.log(`[reach] Script: ${getScriptPath()}`);
  svc.install();
}

export function uninstall(): void {
  const svc = createService();

  svc.on('uninstall', () => {
    console.log('[reach] Service uninstalled successfully.');
    process.exit(0);
  });

  svc.on('alreadyuninstalled', () => {
    console.log('[reach] Service is not installed. Nothing to uninstall.');
    process.exit(0);
  });

  svc.on('error', (err: Error) => {
    console.error('[reach] Service uninstallation error:', err.message);
    if (err.message.includes('Permission')) {
      console.error('[reach] HINT: Run this command as Administrator (elevated privileges required).');
    }
    process.exit(1);
  });

  console.log('[reach] Uninstalling Reach Windows Service...');
  svc.uninstall();
}

export function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['install', 'uninstall'].includes(command)) {
    console.error('[reach] Usage: node dist/service/install.js [install|uninstall]');
    process.exit(1);
  }

  if (command === 'install') {
    install();
  } else if (command === 'uninstall') {
    uninstall();
  }
}

// Only run main() when executed directly, not when imported
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('install.js') || process.argv[1].endsWith('install.ts'));
if (isDirectRun) {
  main();
}
