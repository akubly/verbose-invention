#!/usr/bin/env node

/**
 * Reach — Full install orchestrator
 *
 * Usage:
 *   node dist/install/index.js
 *   npm run init
 *
 * What it does (in order):
 *   1. Config wizard — validate/prompt for required env vars, write to .env
 *   2. Extension copy  — install extension.mjs to Copilot CLI extensions dir
 *   3. Service install — register and start the Reach Windows service
 *
 * Requires an interactive terminal (TTY) when env vars are missing.
 * To install non-interactively, populate .env before running.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { copyExtension } from './copyExtension.js';
import { install } from '../service/install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Returns the project root: dist/install/ → dist/ → project root */
function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

// ---------------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------------

function readEnvFile(envPath: string): Map<string, string> {
  if (!fs.existsSync(envPath)) return new Map();
  const content = fs.readFileSync(envPath, 'utf-8');
  const vars = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
  }
  return vars;
}

/**
 * Writes a single key=value entry to the .env file.
 * Updates the line in-place if the key already exists; appends if not.
 * Creates the file if absent. Preserves all other content.
 */
function writeEnvKey(envPath: string, key: string, value: string): void {
  const lines: string[] = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)
    : [];

  let found = false;
  const updated = lines.map(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1 && line.slice(0, eqIdx).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    // Trim trailing blank lines before appending
    while (updated.length > 0 && updated[updated.length - 1]?.trim() === '') {
      updated.pop();
    }
    updated.push(`${key}=${value}`);
    updated.push('');
  }

  fs.writeFileSync(envPath, updated.join(os.EOL), 'utf-8');
}

// ---------------------------------------------------------------------------
// Prompt helpers (TTY only — callers must gate on isTTY before calling)
// ---------------------------------------------------------------------------

async function promptLine(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptConfirm(message: string): Promise<boolean> {
  const answer = await promptLine(message);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

// ---------------------------------------------------------------------------
// Config wizard
// ---------------------------------------------------------------------------

async function runConfigWizard(envPath: string): Promise<void> {
  const envVars = readEnvFile(envPath);

  /** Resolution order: process.env (already loaded) > .env file */
  function getVal(key: string): string | undefined {
    return process.env[key] !== undefined ? process.env[key] : envVars.get(key);
  }

  const botToken   = getVal('TELEGRAM_BOT_TOKEN');
  const chatId     = getVal('TELEGRAM_CHAT_ID');
  const allowedIds = getVal('TELEGRAM_ALLOWED_USER_IDS');

  const ok  = (label: string) => console.log(`[reach]   ${label.padEnd(36)}✅  found`);
  const warn = (label: string, note: string) => console.log(`[reach]   ${label.padEnd(36)}⚠   ${note}`);

  console.log('[reach] Checking configuration…');
  botToken   ? ok('TELEGRAM_BOT_TOKEN')   : warn('TELEGRAM_BOT_TOKEN',   'missing — will prompt');
  chatId     ? ok('TELEGRAM_CHAT_ID')     : warn('TELEGRAM_CHAT_ID',     'missing (set later via /pair)');
  allowedIds ? ok('TELEGRAM_ALLOWED_USER_IDS') : warn('TELEGRAM_ALLOWED_USER_IDS', 'not configured — will prompt');
  console.log('[reach]');

  // Non-TTY gate: if prompting is needed, bail with instructions
  const needsPrompt = !botToken || !allowedIds;
  if (needsPrompt && !process.stdin.isTTY) {
    console.error('[reach] ERROR: Interactive terminal required for first-time setup.');
    console.error('[reach] Populate .env before running non-interactively:');
    console.error('[reach]   TELEGRAM_BOT_TOKEN=<your-bot-token>');
    console.error('[reach]   TELEGRAM_ALLOWED_USER_IDS=<your-telegram-user-id>');
    console.error('[reach] Find your ID: message @userinfobot in Telegram.');
    process.exit(1);
  }

  // TELEGRAM_BOT_TOKEN — required, prompt if missing
  if (!botToken) {
    console.log('[reach] TELEGRAM_BOT_TOKEN is required to start the daemon.');
    const token = await promptLine('[reach] Bot token: ');
    if (!token) {
      console.error('[reach] ERROR: Bot token cannot be empty.');
      process.exit(1);
    }
    writeEnvKey(envPath, 'TELEGRAM_BOT_TOKEN', token);
    console.log(`[reach] Written to ${envPath}`);
    console.log('[reach]');
  }

  // TELEGRAM_CHAT_ID — warn only, pairing handles this at runtime
  if (!chatId) {
    console.log('[reach] ⚠  TELEGRAM_CHAT_ID not set. Use /pair in Telegram after the daemon starts.');
    console.log('[reach]');
  }

  // TELEGRAM_ALLOWED_USER_IDS — prompt with explicit skip
  if (!allowedIds) {
    console.log('[reach] TELEGRAM_ALLOWED_USER_IDS gates who can send the daemon commands.');
    console.log('[reach] Find your ID: message @userinfobot in Telegram — it replies with your numeric ID.');
    const ids = await promptLine('[reach] Your Telegram user ID (or leave blank to skip): ');
    if (ids) {
      writeEnvKey(envPath, 'TELEGRAM_ALLOWED_USER_IDS', ids);
      console.log(`[reach] Written to ${envPath}`);
    } else {
      const skip = await promptConfirm('[reach] Skip and configure later? [y/N]: ');
      if (!skip) {
        console.error('[reach] Aborted. Set TELEGRAM_ALLOWED_USER_IDS in .env and re-run.');
        process.exit(1);
      }
      console.log('[reach] ⚠️ Skipped. ANY Telegram user in your configured chat can control the daemon until TELEGRAM_ALLOWED_USER_IDS is set.');
    }
    console.log('[reach]');
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]  Reach — Install Setup');
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]');

  const projectRoot = getProjectRoot();
  const envPath = path.join(projectRoot, '.env');

  // Step 0: Config wizard
  await runConfigWizard(envPath);

  // Step 1: Extension
  console.log('[reach] Step 1/2: Installing extension…');
  copyExtension();
  console.log('[reach]');

  // Print next-step pointers before handing off to the async service installer
  // (service install calls process.exit internally when complete).
  console.log('[reach] ────────────────────────────────────────────────────');
  console.log('[reach]  Once the service is running:');
  console.log('[reach]    Upgrade:   git pull && npm run build && npm run init');
  console.log('[reach]    Uninstall: npm run uninstall');
  console.log('[reach]    Logs:      Get-EventLog Application -Source Reach -Newest 50');
  console.log('[reach] ────────────────────────────────────────────────────');
  console.log('[reach]');

  // Step 2: Service (handles its own exit via node-windows events)
  console.log('[reach] Step 2/2: Installing Windows service…');
  await install();
}

// Only run when executed directly, not when imported
const isDirectRun =
  process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runInit().catch((err: unknown) => {
    console.error('[reach] Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
