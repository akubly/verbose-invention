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
  return path.resolve(__dirname, '..', '..');
}

export function createService(): any {
  const scriptPath = getScriptPath();
  const workingDirectory = getProjectRoot();

  // node-windows defaults to Local System (highest privilege).
  // Reach only needs network access + file I/O, so NetworkService would suffice.
  // To change: set logOnAs in the config below, or reconfigure via services.msc.
  // Keeping Local System for now — simpler setup for a personal single-user tool.

  const svc = new Service({
    name: 'Reach',
    description: 'Telegram ↔ GitHub Copilot CLI session bridge',
    script: scriptPath,
    nodeOptions: ['--enable-source-maps'],
    workingDirectory: workingDirectory,
    env: [
      { name: 'NODE_ENV', value: 'production' },
      ...(process.env.TELEGRAM_BOT_TOKEN
        ? [{ name: 'TELEGRAM_BOT_TOKEN', value: process.env.TELEGRAM_BOT_TOKEN }]
        : []),
      ...(process.env.TELEGRAM_CHAT_ID
        ? [{ name: 'TELEGRAM_CHAT_ID', value: process.env.TELEGRAM_CHAT_ID }]
        : []),
      ...(process.env.REACH_MODEL
        ? [{ name: 'REACH_MODEL', value: process.env.REACH_MODEL }]
        : []),
    ]
  });

  return svc;
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

  if (!hasEnvFile) {
    console.warn(`[reach] WARNING: No .env file found at ${envPath}`);
    console.warn('[reach] Proceeding because both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in the environment.');
  }

  const svc = createService();

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
    console.log('[reach] Required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
    console.log('[reach] Optional env var:  REACH_MODEL (default: claude-sonnet-4)');
    console.log('[reach]');
    console.log('[reach] NOTE: Service runs as Local System. If you prefer reduced privileges,');
    console.log('[reach]       change the logon account to NetworkService via services.msc.');
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
