#!/usr/bin/env node

/**
 * Reach — Windows Service installer/uninstaller
 *
 * Usage:
 *   node dist/service/install.js install
 *   node dist/service/install.js uninstall
 *
 * Requires administrative privileges.
 * The service runs as the currently logged-in Windows user (ADR-5).
 * Install prompts for your Windows account password once; it is passed
 * directly to the Windows Service Control Manager and not stored by Reach.
 */

// @ts-expect-error TS7016 - node-windows lacks TypeScript types
import { Service } from 'node-windows';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getScriptPath(): string {
  return path.resolve(__dirname, '..', 'bin.js');
}

function getProjectRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback: getScriptPath() points at dist/bin.js → dirname gives dist/, one level up is project root
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

/** The Windows user account the service will run under (ADR-5). */
export interface ServiceAccount {
  /** Windows username (e.g. 'AaronSmith'). */
  username: string;
  /** NetBIOS domain or machine name (e.g. 'MYCOMPANY' or 'DESKTOP-ABC123'). */
  domain: string;
  /** Windows account password — required by SCM for non-system user accounts. */
  password: string;
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
  /**
   * The Windows account to run the service under.
   * When omitted (uninstall path), no logOnAs block is written to the service config.
   */
  account?: ServiceAccount;
}

export function createService(options: CreateServiceOptions = {}): ServiceInstance {
  const scriptPath = getScriptPath();
  const workingDirectory = getProjectRoot();
  const { envOverrides = [], account } = options;

  const env: Array<{ name: string; value: string }> = [
    { name: 'NODE_ENV', value: 'production' },
    ...envOverrides,
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: Record<string, any> = {
    name: 'Reach',
    description: 'Telegram ↔ GitHub Copilot CLI session bridge',
    script: scriptPath,
    nodeOptions: ['--enable-source-maps'],
    workingDirectory,
    env,
  };

  if (account) {
    config.logOnAs = {
      domain: account.domain,
      account: account.username,
      password: account.password,
    };
    config.allowServiceLogon = true;
  }

  return new Service(config) as ServiceInstance;
}

/**
 * Resolves the current logged-in Windows user using Node's built-in os module.
 * Does not spawn external processes or call LookupAccountName.
 */
export function resolveCurrentUser(): { username: string; domain: string } {
  const username = os.userInfo().username;
  const domain = process.env['USERDOMAIN'] ?? process.env['COMPUTERNAME'] ?? '.';
  return { username, domain };
}

/**
 * Prompts for a password on stdin with character echoing suppressed.
 * The password is never written to disk by Reach — it is passed directly
 * to the Windows Service Control Manager at install time.
 *
 * Requires a TTY: echo suppression uses the readline internal `_writeToOutput`
 * hook, which is only effective when stdin is an interactive terminal. In
 * non-TTY environments (piped input, CI, redirected stdin) we cannot
 * guarantee the typed password is hidden, so we refuse to prompt and instruct
 * the caller to provide credentials via environment variables instead.
 */
export async function promptPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Cannot prompt for password: stdin is not a TTY. ' +
      'Set the REACH_SERVICE_PASSWORD environment variable or run install ' +
      'from an interactive terminal.',
    );
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Suppress echoing of typed characters while still writing the prompt.
    // This uses readline's internal `_writeToOutput` hook — not a stable
    // public API, but the only realistic option short of raw-mode keypress
    // handling. The TTY gate above ensures we never run this code path in
    // contexts where echo suppression could silently fail.
    let promptWritten = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (str: string) => {
      if (!promptWritten) {
        process.stdout.write(str);
        promptWritten = true;
      }
      // Swallow subsequent writes (echoed keystrokes).
    };

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

export async function install(): Promise<void> {
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

  // --- Resolve current user and prompt for password (ADR-5) ---
  const { username, domain } = resolveCurrentUser();
  const accountDisplay = `${domain}\\${username}`;
  console.log(`[reach] Service will run as: ${accountDisplay}`);
  console.log('[reach] Windows requires your password to register a service under your account.');
  console.log('[reach] Your password is passed directly to the Windows Service Control Manager');
  console.log('[reach] and is not stored by Reach.');

  // Prefer the REACH_SERVICE_PASSWORD env var when set (CI / automated installs);
  // fall back to the interactive TTY prompt only when it is absent. promptPassword()
  // requires a TTY and will throw otherwise — the env-var path is the supported
  // non-interactive route advertised in that error message.
  const envPassword = process.env.REACH_SERVICE_PASSWORD;
  const password = envPassword && envPassword.length > 0
    ? envPassword
    : await promptPassword(`[reach] Password for ${accountDisplay}: `);

  if (!password) {
    console.error('[reach] ERROR: Service install requires your Windows password to run as your account.');
    console.error('[reach] Provide it interactively or via the REACH_SERVICE_PASSWORD environment variable.');
    process.exit(1);
  }

  const account: ServiceAccount = { username, domain, password };
  const svc = createService({ envOverrides, account });

  svc.on('install', () => {
    console.log('[reach] Service installed successfully.');
    console.log('[reach] Starting service...');
    svc.start();
  });

  svc.on('start', () => {
    console.log('[reach] Service started.');
    console.log(`[reach] The Reach daemon is now running as a Windows Service under ${accountDisplay}.`);
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

const UNINSTALL_TIMEOUT_MS = 60_000;

/**
 * Composable Promise-based service uninstaller.
 *
 * Wraps the node-windows event-emitter in a Promise so the caller can await
 * the result and accumulate it into a step-summary before deciding on a final
 * exit code. Uses a `settled` guard to handle duplicate event fires and a
 * 60-second timeout so the orchestrator is never left hanging.
 *
 * Does NOT call process.exit(). The caller is responsible for exit codes.
 */
export function uninstallService(): Promise<void> {
  return new Promise((resolve, reject) => {
    const svc = createService();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('[reach] Service uninstall timed out after 60 s — uninstall event never fired'));
    }, UNINSTALL_TIMEOUT_MS);

    const finish = (err?: Error) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    svc.on('uninstall', () => {
      if (settled) return;
      settled = true;
      console.log('[reach] Service uninstalled successfully.');
      finish();
    });

    svc.on('alreadyuninstalled', () => {
      if (settled) return;
      settled = true;
      console.log('[reach] Service is not installed. Nothing to uninstall.');
      finish();
    });

    svc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      console.error('[reach] Service uninstallation error:', err.message);
      if (err.message.includes('Permission')) {
        console.error('[reach] HINT: Run this command as Administrator (elevated privileges required).');
      }
      finish(err);
    });

    console.log('[reach] Uninstalling Reach Windows Service...');
    try {
      svc.uninstall();
    } catch (err) {
      if (!settled) {
        settled = true;
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}

/** CLI shim — calls uninstallService() and exits with the appropriate code. */
export function uninstall(): void {
  uninstallService()
    .then(() => { process.exit(0); })
    .catch(() => { process.exit(1); });
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['install', 'uninstall'].includes(command)) {
    console.error('[reach] Usage: node dist/service/install.js [install|uninstall]');
    process.exit(1);
  }

  if (command === 'install') {
    await install();
  } else if (command === 'uninstall') {
    try {
      await uninstallService();
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }
}

// Only run main() when executed directly, not when imported
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('install.js') || process.argv[1].endsWith('install.ts'));
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('[reach] Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
