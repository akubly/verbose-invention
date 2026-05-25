/**
 * extension.mjs — Reach CLI Extension
 *
 * This file is the Reach extension for the GitHub Copilot CLI.
 *
 * DEPLOYMENT: `reach install` copies this file to the user's Copilot
 * extensions directory:
 *   Windows: %APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs
 *   macOS/Linux: ~/.config/github-copilot/extensions/reach/extension.mjs
 *
 * LIFECYCLE: The CLI loads this file as a child process on every new
 * foreground session. On `/clear` the extension is reloaded; on CLI exit
 * it is terminated. The extension must not hold any long-lived state that
 * cannot be re-established on reconnect.
 *
 * BRIDGE PROTOCOL (JSON-Lines, UTF-8, max 64 KB per line, ADR-8 canonical schema):
 *
 *   Inbound  (daemon → extension):
 *     { "type": "session.registered", "sessionId": "...", "mode": { ... }, "topicId": 123 }
 *     { "type": "ping", "id": "<uuid>", "sessionId": "..." }
 *     { "type": "inject", "sessionId": "...", "requestId": "...", "text": "..." }
 *     { "type": "afk.activated", "sessionId": "...", "topicId": 123, "topicUrl": "..." }
 *     { "type": "back.confirmed", "sessionId": "..." }
 *     { "type": "mode.changed", "active": true, "since": "..." }
 *     { "type": "mirror.input", "sessionId": "...", "text": "...", "source": "telegram", "topicId": 123 }
 *     { "type": "relay.command", "sessionId": "...", "command": "/clear", "args": [] }
 *
 *   Outbound (extension → daemon):
 *     { "type": "hello", "sessionId": "...", "sessionName": "..." }
 *     { "type": "pong", "id": "<uuid>", "sessionId": "..." }
 *     { "type": "afk.request", "sessionId": "..." }
 *     { "type": "back.request", "sessionId": "..." }
 *     { "type": "stream", "sessionId": "...", "requestId": "...", "chunk": "...", "done": false }
 *     { "type": "stream.error", "sessionId": "...", "requestId": "...", "error": "..." }
 *     { "type": "session.event", "sessionId": "...", "payload": { ... } }  (future use)
 *
 * RECONNECT POLICY (ADR-6):
 *   Exponential backoff — base 1 s, multiplier 2×, ceiling 300 s.
 *   Never give up while the CLI session is alive.
 *   On successful reconnect: re-send `hello` and reset backoff.
 *
 * HEARTBEAT (ADR-7):
 *   Daemon sends `ping` every 30 s; extension replies `pong` with same `id`.
 *   Pipe teardown (CLI exit) is detected via `close` / `error` events.
 *
 * ERROR HANDLING (ADR-4):
 *   All errors are logged via `session.log()` — NEVER throw unhandled
 *   rejections that could crash the CLI process.
 *
 * @module reach/extension
 */

// ─── SDK import ───────────────────────────────────────────────────────────────
//
// joinSession() connects this extension process to the current foreground
// Copilot CLI session via JSON-RPC over stdio.
// It reads SESSION_ID from the environment automatically.

import { joinSession } from '@github/copilot-sdk/extension';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

// PIPE_PATH is no longer a constant — it is read from bridge-auth.json at
// connect time (ADR-10). See readPipeAuth() below.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CEILING_MS = 300_000;
const BACKOFF_MULTIPLIER = 2;
/** Max chars for serialised tool args forwarded in permission.request. */
const ARGS_MAX_CHARS = 4096;

// ─── Risk classification (ADR-9 §5 — mirrors src/copilot/permissions.ts) ─────
//
// The extension owns risk classification (Q5). This list is the authoritative
// consumer of DESTRUCTIVE_TOOLS from permissions.ts. Any update to that list
// MUST be mirrored here.

const DESTRUCTIVE_TOOLS = new Set([
  'edit',
  'create',
  'powershell',
  'bash',
  'git_commit',
  'gh_pr_create',
  'gh_issue_create',
]);

const SAFE_TOOLS = new Set([
  'read',
  'url',
  'view',
  'grep',
  'glob',
  'list_powershell',
  'read_powershell',
  'list_agents',
  'read_agent',
  'fetch_copilot_cli_documentation',
  'web_fetch',
  'web_search',
  'session_store_sql',
  'github-mcp-server-get_file_contents',
  'github-mcp-server-get_copilot_space',
  'github-mcp-server-list_copilot_spaces',
  'github-mcp-server-search_code',
  'github-mcp-server-search_users',
  'memory-read_graph',
  'memory-open_nodes',
  'memory-search_nodes',
  // SDK kind: 'memory' — Copilot CLI memory storage (store_memory). Non-destructive.
  'memory',
]);

/**
 * @param {string} toolName
 * @returns {boolean}
 */
export function isDestructive(toolName) {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
export function isKnownSafe(toolName) {
  return SAFE_TOOLS.has(toolName);
}

// ─── State ────────────────────────────────────────────────────────────────────

/** The SESSION_ID assigned by the CLI. Available as env var in extension processes. */
const SESSION_ID = process.env['SESSION_ID'] ?? '';

/**
 * Human-readable session name. Read from SESSION_NAME env var if set by the CLI;
 * fall back to SESSION_ID so the field is always a non-empty string (ADR-8 §3).
 */
const SESSION_NAME = process.env['SESSION_NAME'] || SESSION_ID;

/** Copilot SDK session handle (set on first successful joinSession). */
let sdkSession = null;

/** Current pipe socket. null when disconnected. */
let pipeSocket = null;

/** Reconnect attempt counter (resets to 0 on successful connect). */
let reconnectAttempt = 0;

/** True when teardown has been initiated (stop reconnecting). */
let stopping = false;

/**
 * Pipe auth config read from bridge-auth.json before each connect attempt.
 * Holds the dynamic pipe path and per-run token (ADR-10).
 * Re-read on every connection attempt to pick up daemon restarts.
 *
 * @type {{ pipeName: string; pipePath: string; token: string } | null}
 */
let pipeAuth = null;

/**
 * In-flight permission requests awaiting a daemon response.
 * Maps permissionId → { resolve: (approved: boolean) => void }.
 * Aborted with deny on pipe close (ADR-9 §5 pipe-close abort).
 *
 * @type {Map<string, (approved: boolean) => void>}
 */
const pendingPermissions = new Map();

/**
 * Set of requestIds for inject operations currently executing sdkSession.send().
 * Replaces the single `currentRequestId` global to avoid the race window where
 * two concurrent injects would overwrite each other's requestId context.
 * Insertion-ordered: the last entry is the most recently started inject.
 *
 * @type {Set<string>}
 */
const activeInjectIds = new Set();

/**
 * Returns the requestId of the most recently started inject still in flight,
 * or '' if no inject is currently running. Used in permission.request messages
 * as informational context (ADR-9 §3.1 — "context only").
 *
 * @returns {string}
 */
function getActiveRequestId() {
  let last = '';
  for (const id of activeInjectIds) last = id;
  return last;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

/**
 * Log a message. Uses session.log() when available, falls back to stderr.
 * All paths are synchronous-safe (no await) to allow use in error handlers.
 *
 * @param {string} level - 'info' | 'warn' | 'error'
 * @param {string} message
 */
function log(level, message) {
  const prefix = `[reach-extension][${level.toUpperCase()}]`;
  if (sdkSession !== null && typeof sdkSession.log === 'function') {
    try {
      sdkSession.log(`${prefix} ${message}`);
    } catch {
      process.stderr.write(`${prefix} ${message}\n`);
    }
  } else {
    process.stderr.write(`${prefix} ${message}\n`);
  }
}

// ─── Exponential backoff ──────────────────────────────────────────────────────

/**
 * Returns the delay in milliseconds for the current reconnect attempt.
 * Schedule: 1 s, 2 s, 4 s, 8 s, … 256 s, 300 s, 300 s, …
 *
 * @param {number} attempt - Zero-based attempt index.
 * @returns {number} Delay in milliseconds.
 */
function backoffDelay(attempt) {
  const raw = BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
  return Math.min(raw, BACKOFF_CEILING_MS);
}

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Pipe I/O ─────────────────────────────────────────────────────────────────

/**
 * Send a JSON-Lines frame to the daemon.
 * Returns false if the socket is not connected or the write fails.
 *
 * @param {object} msg - The message object to serialise.
 * @returns {boolean} True when the frame was handed to the socket.
 */
function sendToDaemon(msg) {
  if (pipeSocket === null || pipeSocket.destroyed) return false;
  try {
    pipeSocket.write(JSON.stringify(msg) + '\n', 'utf-8');
    return true;
  } catch (err) {
    log('warn', `sendToDaemon failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Surface a user-facing one-line message in the CLI session when possible.
 *
 * @param {string} message
 * @param {'info' | 'warning' | 'error'} [level]
 */
function sanitizeForCliLine(value) {
  return String(value)
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

function showCliMessage(message, level = 'info') {
  const safeMessage = sanitizeForCliLine(message);
  if (sdkSession !== null && typeof sdkSession.log === 'function') {
    Promise.resolve(sdkSession.log(safeMessage, { level })).catch((err) => {
      process.stderr.write(`${safeMessage}\n`);
      log('warn', `session.log failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  process.stderr.write(`${safeMessage}\n`);
}

/**
 * @param {{ sessionId?: unknown }} msg
 * @param {string} type
 * @returns {boolean}
 */
function isForCurrentSession(msg, type) {
  if (msg.sessionId === SESSION_ID) return true;
  log('warn', `${type} for different sessionId "${String(msg.sessionId)}" — ignoring`);
  return false;
}

// ─── Inbound message handling ────────────────────────────────────────────────

/**
 * Dispatch a parsed inbound message from the daemon.
 *
 * @param {object} msg - Parsed JSON object.
 */
function handleMessage(msg) {
  switch (msg.type) {
    case 'session.registered':
      log('info', `Registered with daemon (session: ${msg.sessionId})`);
      handleSessionRegistered(msg);
      break;

    case 'ping':
      // ADR-7: reply immediately with the same id, including sessionId (ADR-8 §8).
      sendToDaemon({ type: 'pong', id: msg.id, sessionId: SESSION_ID });
      break;

    case 'inject':
      if (isForCurrentSession(msg, 'inject')) handleInject(msg);
      break;

    case 'permission.response':
      if (isForCurrentSession(msg, 'permission.response')) handlePermissionResponse(msg);
      break;

    case 'afk.activated':
      if (isForCurrentSession(msg, 'afk.activated')) handleAfkActivated(msg);
      break;

    case 'back.confirmed':
      if (isForCurrentSession(msg, 'back.confirmed')) handleBackConfirmed(msg);
      break;

    case 'mode.changed':
      handleModeChanged(msg);
      break;

    case 'mirror.input':
      if (isForCurrentSession(msg, 'mirror.input')) handleMirrorInput(msg);
      break;

    case 'relay.command':
      if (isForCurrentSession(msg, 'relay.command')) {
        const command = typeof msg.command === 'string' ? sanitizeForCliLine(msg.command) : '<unknown>';
        const args = Array.isArray(msg.args) ? msg.args.map(sanitizeForCliLine).join(' ') : '';
        log('info', `relay.command received (stub): ${command} ${args}`.trim());
      }
      break;

    default:
      log('warn', `Unknown message type from daemon: "${msg.type}" — ignoring`);
  }
}

/**
 * Run text through the SDK session and stream the assistant response back to the daemon.
 *
 * @param {string} text
 * @param {string} requestId
 * @param {string} label
 */
async function streamSdkResponse(text, requestId, label) {
  activeInjectIds.add(requestId);

  try {
    let chunkCount = 0;
    for await (const chunk of sdkSession.send(text)) {
      const frame = JSON.stringify({
        type: 'stream',
        sessionId: SESSION_ID,
        requestId,
        chunk: String(chunk),
        done: false,
      }) + '\n';
      if (pipeSocket !== null && !pipeSocket.destroyed) {
        const canWriteMore = pipeSocket.write(frame, 'utf-8');
        if (!canWriteMore) {
          await new Promise((resolve) => {
            if (pipeSocket !== null) {
              pipeSocket.once('drain', resolve);
            } else {
              resolve(undefined);
            }
          });
        }
      }
      chunkCount++;
    }
    sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk: '', done: true });
    log('info', `${label} complete: requestId=${requestId} chunks=${chunkCount}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `${label} error: ${message}`);
    sendToDaemon({ type: 'stream.error', sessionId: SESSION_ID, requestId, error: message });
  } finally {
    activeInjectIds.delete(requestId);
  }
}

/**
 * Handle an `inject` message from the daemon.
 * Injects the command text into the active Copilot CLI session and streams
 * each SDK response chunk back as a `stream` message (ADR-8 §5).
 *
 * @param {{ sessionId: string, requestId: string, text: string }} msg
 */
async function handleInject(msg) {
  if (sdkSession === null) {
    log('warn', 'inject received but no SDK session — sending stream.error');
    sendToDaemon({
      type: 'stream.error',
      sessionId: SESSION_ID,
      requestId: msg.requestId,
      error: 'no-sdk-session',
    });
    return;
  }

  const text = typeof msg.text === 'string' ? msg.text : '';
  if (text.length === 0) {
    log('warn', 'inject: empty text — ignoring');
    return;
  }

  await streamSdkResponse(text, msg.requestId, 'inject');
}

/**
 * @param {{ mode?: { active?: boolean, since?: string }, topicId?: number }} msg
 */
function handleSessionRegistered(msg) {
  if (msg.mode?.active === true) {
    showCliMessage('🛰️ AFK mode active');
    if (typeof msg.topicId === 'number') {
      log('info', `AFK topic already assigned on registration: ${msg.topicId}`);
    }
  }
}

/**
 * @param {{ topicId?: number, topicUrl?: string }} msg
 */
function handleAfkActivated(msg) {
  const suffix = typeof msg.topicUrl === 'string' && msg.topicUrl.length > 0
    ? ` — ${msg.topicUrl}`
    : '';
  showCliMessage(`🛰️ AFK mode active${suffix}`);
  if (typeof msg.topicId === 'number') {
    log('info', `AFK activated for topic ${msg.topicId}`);
  }
}

function handleBackConfirmed(_msg) {
  showCliMessage('🖥️ Back at desk');
}

/**
 * @param {{ active?: boolean, since?: string }} msg
 */
function handleModeChanged(msg) {
  showCliMessage(msg.active === true ? '🛰️ AFK mode active' : '🖥️ Back at desk');
  if (typeof msg.since === 'string') {
    log('info', `mode.changed since=${msg.since}`);
  }
}

/**
 * @param {{ text?: string, topicId?: number }} msg
 */
async function handleMirrorInput(msg) {
  if (sdkSession === null) {
    log('warn', 'mirror.input received but no SDK session — ignoring');
    return;
  }

  const text = typeof msg.text === 'string' ? msg.text : '';
  if (text.length === 0) {
    log('warn', 'mirror.input: empty text — ignoring');
    return;
  }

  showCliMessage(`📱 Telegram: ${text}`);
  await streamSdkResponse(text, `mirror-${randomUUID()}`, 'mirror.input');
}

// ─── Session event forwarding ─────────────────────────────────────────────────

/**
 * Handle a `permission.response` from the daemon.
 * Resolves the suspended permissionCallback for the matching permissionId.
 *
 * @param {{ permissionId: string, decision: 'allow' | 'deny' }} msg
 */
function handlePermissionResponse(msg) {
  const resolve = pendingPermissions.get(msg.permissionId);
  if (!resolve) {
    log('warn', `permission.response for unknown permissionId: ${msg.permissionId} — ignoring`);
    return;
  }
  pendingPermissions.delete(msg.permissionId);
  resolve(msg.decision === 'allow');
}

/** Minor: 10-minute ceiling on permission prompts to prevent truly orphaned callbacks. */
const PERMISSION_FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wait for a permission.response from the daemon for the given permissionId.
 * Returns a Promise that resolves to true (allow) or false (deny).
 * The Promise is aborted with false if the pipe closes before a response arrives.
 * A 10-minute fallback timer resolves deny if no response arrives after that window.
 *
 * @param {string} permissionId
 * @returns {Promise<boolean>}
 */
function waitForPermissionResponse(permissionId) {
  return new Promise((resolve) => {
    pendingPermissions.set(permissionId, resolve);
    // Fallback ceiling: resolve deny if no response arrives within 10 minutes.
    // This is a safety net only — normal resolution is daemon response or pipe close.
    setTimeout(() => {
      if (pendingPermissions.has(permissionId)) {
        pendingPermissions.delete(permissionId);
        log('warn', `permission.request ${permissionId} unanswered after 10 minutes — denying`);
        resolve(false);
      }
    }, PERMISSION_FALLBACK_TIMEOUT_MS);
  });
}

/**
 * Abort all pending permissionCallbacks with deny.
 * Called on pipe close so the SDK is never left hanging (ADR-9 §5).
 */
function abortPendingPermissions() {
  for (const [permId, resolve] of pendingPermissions) {
    log('warn', `Aborting pending permission ${permId} (pipe closed) — denying`);
    resolve(false);
  }
  pendingPermissions.clear();
}

// ─── SDK permission hook (ADR-9) ──────────────────────────────────────────────

/**
 * Subscribe to SDK session events and forward them to the daemon.
 * Registers the onPermissionRequest hook for destructive tool classification (ADR-9 §5).
 *
 * @param {object} session - The SDK CopilotSession handle.
 */
function wireSessionEvents(session) {
  log('info', 'Session event forwarding wired (ADR-9 permission hook active)');

  // ADR-9 §5: Extension classifies tool risk and forwards only destructive tools.
  // The daemon routes permission.request to the user via Telegram inline keyboard.
  if (typeof session.onPermissionRequest === 'function') {
    session.onPermissionRequest(async (req) => {
      const toolName = req?.toolName ?? '';
      const args = req?.args !== undefined ? JSON.stringify(req.args) : '';

      // Known-safe tools are auto-approved without prompting.
      if (isKnownSafe(toolName)) {
        return { kind: 'approved' };
      }
      // Unknown tools (neither safe nor destructive) are denied by default (safety parity with SDK).
      if (!isDestructive(toolName)) {
        return { kind: 'denied' };
      }

      // Destructive tool: forward to daemon for user approval.
      const permissionId = randomUUID();
      const truncatedArgs = args.length > ARGS_MAX_CHARS ? args.slice(0, ARGS_MAX_CHARS) : args;

      sendToDaemon({
        type: 'permission.request',
        sessionId: SESSION_ID,
        requestId: getActiveRequestId(),
        permissionId,
        toolName,
        args: truncatedArgs,
        riskLevel: 'destructive',
      });

      log('info', `permission.request sent for tool "${toolName}" (permissionId: ${permissionId})`);

      // I2: if the SDK fires req.signal before the daemon responds, send permission.cancelled
      // so the daemon cleans up the pending Telegram prompt.
      if (req?.signal instanceof AbortSignal) {
        req.signal.addEventListener('abort', () => {
          const pendingResolve = pendingPermissions.get(permissionId);
          if (pendingResolve !== undefined) {
            pendingPermissions.delete(permissionId);
            sendToDaemon({ type: 'permission.cancelled', sessionId: SESSION_ID, permissionId });
            log('info', `permission.cancelled sent for ${permissionId} (SDK AbortSignal fired)`);
            pendingResolve(false);
          }
        }, { once: true });
      }

      // Await decision indefinitely — no local timer (ADR-9 Q4).
      // Pipe-close abort is handled by abortPendingPermissions() on 'close' event.
      const approved = await waitForPermissionResponse(permissionId);

      log('info', `permission response for "${toolName}": ${approved ? 'allow' : 'deny'}`);
      return approved ? { kind: 'approved' } : { kind: 'denied' };
    });
  }
}

// ─── Pipe authentication (ADR-10) ─────────────────────────────────────────────

/**
 * Returns the path to the bridge-auth.json file written by the daemon.
 * Uses %LOCALAPPDATA% on Windows (matches pipeAuth.ts on the daemon side).
 *
 * @returns {string}
 */
function getAuthFilePath() {
  const localAppData =
    process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'reach', 'bridge-auth.json');
}

/**
 * Read the daemon's bridge-auth.json. Returns null if the file is missing,
 * unreadable, or malformed (daemon not running yet).
 *
 * @returns {Promise<{ pipeName: string; pipePath: string; token: string } | null>}
 */
async function readPipeAuthFile() {
  try {
    const raw = await readFile(getAuthFilePath(), 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.pipeName !== 'string' || typeof data.token !== 'string') {
      return null;
    }
    return {
      pipeName: data.pipeName,
      pipePath: `\\\\.\\pipe\\${data.pipeName}`,
      token: data.token,
    };
  } catch {
    return null;
  }
}

// ─── Pipe connection loop ────────────────────────────────────────────────────

/**
 * Connect to the daemon pipe, register, and handle messages until the
 * connection closes. Returns when the connection is lost (caller retries
 * with exponential backoff per ADR-6).
 *
 * @returns {Promise<void>} Resolves on clean disconnect; rejects on connect
 *   error so the caller can apply backoff.
 */
function connectToDaemon() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipeAuth.pipePath);
    pipeSocket = socket;

    let lineBuffer = '';
    let registered = false;

    socket.setEncoding('utf-8');

    socket.on('connect', () => {
      reconnectAttempt = 0; // Reset backoff on successful connect.
      log('info', `Connected to daemon pipe (session: ${SESSION_ID})`);

      // ADR-2: push-based registration — first thing sent on connect.
      // Re-sent on every reconnect (ADR-6 hello-resend rule, ADR-8 §1).
      // ADR-10: include authToken from bridge-auth.json.
      sendToDaemon({ type: 'hello', sessionId: SESSION_ID, sessionName: SESSION_NAME, authToken: pipeAuth.token });
      registered = true;
    });

    socket.on('data', (chunk) => {
      lineBuffer += chunk;

      // DoS guard: mirror server-side 64 KB limit.
      if (lineBuffer.length > 64 * 1024) {
        log('warn', 'Inbound buffer exceeded 64 KB — resetting connection');
        socket.destroy();
        return;
      }

      let newlineIdx;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          log('warn', 'Non-JSON line from daemon — ignoring');
          continue;
        }

        if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
          log('warn', 'Malformed message from daemon (missing type) — ignoring');
          continue;
        }

        handleMessage(msg);
      }
    });

    socket.on('close', () => {
      pipeSocket = null;
      if (registered) {
        log('info', 'Daemon pipe closed');
      }
      // ADR-9 §5: abort all in-flight permission requests with deny on pipe close.
      // This ensures the SDK's permissionCallback is never left hanging when the
      // daemon disconnects (e.g., daemon restart, SIGTERM).
      abortPendingPermissions();
      resolve();
    });

    socket.on('error', (err) => {
      // 'close' fires after 'error'; resolve there to trigger backoff in caller.
      if (!registered) {
        // Connect-time error — reject so caller sees the failure immediately.
        reject(err);
      } else {
        log('warn', `Pipe error: ${err.message}`);
      }
    });
  });
}

// ─── Main reconnect loop ──────────────────────────────────────────────────────

/**
 * Attempt to connect to the daemon, retrying with exponential backoff until
 * the extension is stopped (ADR-6: never give up while CLI session is alive).
 *
 * @returns {Promise<void>}
 */
async function runConnectionLoop() {
  while (!stopping) {
    // Re-read bridge-auth.json on every attempt so a daemon restart (which
    // writes a new pipe name + token) is picked up automatically (ADR-6, ADR-10).
    pipeAuth = await readPipeAuthFile();
    if (!pipeAuth) {
      const delay = backoffDelay(reconnectAttempt);
      log('warn', `bridge-auth.json not found — daemon not running; retrying in ${delay} ms`);
      reconnectAttempt++;
      if (!stopping) await sleep(delay);
      continue;
    }

    try {
      await connectToDaemon();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = backoffDelay(reconnectAttempt);
      const elapsed = reconnectAttempt > 0
        ? ` (attempt ${reconnectAttempt + 1}, elapsed ~${Math.round(delay / 1000)}s next delay)`
        : '';
      log('warn', `Daemon unreachable${elapsed}: ${message} — retrying in ${delay} ms`);
      reconnectAttempt++;
    }

    if (stopping) break;

    const delay = backoffDelay(reconnectAttempt - 1);
    await sleep(delay);
  }
}

// ─── Extension slash commands (ADR-11) ───────────────────────────────────────

/**
 * Send an extension-level slash command request to the daemon.
 *
 * @param {'afk.request' | 'back.request'} type
 */
function sendModeRequest(type) {
  try {
    const sent = sendToDaemon({ type, sessionId: SESSION_ID });
    if (!sent) {
      showCliMessage('⚠ Reach daemon not running', 'warning');
    }
  } catch (err) {
    log('error', `mode request failed: ${err instanceof Error ? err.message : String(err)}`);
    showCliMessage('⚠ Reach daemon not running', 'warning');
  }
}

/**
 * @returns {import('@github/copilot-sdk').CommandDefinition[]}
 */
function createReachCommands() {
  return [
    {
      name: 'afk',
      description: 'Mirror this Copilot session through Telegram',
      handler: () => sendModeRequest('afk.request'),
    },
    {
      name: 'back',
      description: 'Return this Copilot session to local-only mode',
      handler: () => sendModeRequest('back.request'),
    },
  ];
}

// ─── Extension entry point ────────────────────────────────────────────────────

/**
 * Main entry point. Called once by the CLI when the extension loads.
 *
 * Required extension API surface:
 *   - Exported async `main()` function (or top-level await) — the CLI awaits
 *     it before processing the first user turn.
 *   - Must not throw unhandled rejections (ADR-4: fail silent via session.log).
 *   - `session.log(msg)` — SDK method for writing to the CLI session log.
 *   - `session.send(text)` — SDK method to inject a user turn.
 *   - `session.on(event, cb)` — SDK method to observe session events.
 *   - `SESSION_ID` env var — authoritative session identity (set by CLI).
 */
async function main() {
  if (SESSION_ID.length === 0) {
    process.stderr.write(
      '[reach-extension][ERROR] SESSION_ID env var not set — extension requires CLI process context\n',
    );
    return;
  }

  try {
    sdkSession = await joinSession({ commands: createReachCommands() });
    log('info', `SDK session joined (id: ${SESSION_ID})`);
    wireSessionEvents(sdkSession);
  } catch (err) {
    // ADR-4: fail silent — do not crash the CLI.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[reach-extension][ERROR] joinSession failed: ${message}\n`);
    // Still attempt daemon connection so daemon can at least mark session as present.
  }

  // Start the daemon connection loop in the background.
  // We do NOT await it here — the extension stays alive as long as the CLI runs.
  runConnectionLoop().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `Connection loop crashed unexpectedly: ${message}`);
  });
}

// Graceful shutdown on CLI teardown signals.
process.on('SIGTERM', () => {
  stopping = true;
  pipeSocket?.destroy();
});
process.on('SIGINT', () => {
  stopping = true;
  pipeSocket?.destroy();
});

// Run.
main().catch((err) => {
  // Last-resort catch — should never reach here if main() handles errors correctly.
  process.stderr.write(
    `[reach-extension][FATAL] Unhandled error in main: ${err instanceof Error ? err.message : String(err)}\n`,
  );
});
