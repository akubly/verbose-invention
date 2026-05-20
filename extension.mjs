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
 * BRIDGE PROTOCOL (JSON-Lines, UTF-8, max 64 KB per line):
 *
 *   Inbound  (daemon → extension):
 *     { "type": "registered", "sessionId": "..." }
 *     { "type": "ping", "id": "<uuid>" }
 *     { "type": "session.command", "sessionId": "...", "payload": { ... } }
 *
 *   Outbound (extension → daemon):
 *     { "type": "register", "sessionId": "..." }
 *     { "type": "pong", "id": "<uuid>" }
 *     { "type": "session.event", "sessionId": "...", "payload": { ... } }
 *     { "type": "session.command-result", "sessionId": "...", "payload": { ... } }
 *
 * RECONNECT POLICY (ADR-6):
 *   Exponential backoff — base 1 s, multiplier 2×, ceiling 300 s.
 *   Never give up while the CLI session is alive.
 *   On successful reconnect: re-send `register` and reset backoff.
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

// ─── Constants ────────────────────────────────────────────────────────────────

const PIPE_PATH = '\\\\.\\pipe\\reach-bridge';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CEILING_MS = 300_000;
const BACKOFF_MULTIPLIER = 2;

// ─── State ────────────────────────────────────────────────────────────────────

/** The SESSION_ID assigned by the CLI. Available as env var in extension processes. */
const SESSION_ID = process.env['SESSION_ID'] ?? '';

/** Copilot SDK session handle (set on first successful joinSession). */
let sdkSession = null;

/** Current pipe socket. null when disconnected. */
let pipeSocket = null;

/** Reconnect attempt counter (resets to 0 on successful connect). */
let reconnectAttempt = 0;

/** True when teardown has been initiated (stop reconnecting). */
let stopping = false;

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
 * Silently drops the message if the socket is not connected.
 *
 * @param {object} msg - The message object to serialise.
 */
function sendToDaemon(msg) {
  if (pipeSocket === null || pipeSocket.destroyed) return;
  try {
    pipeSocket.write(JSON.stringify(msg) + '\n', 'utf-8');
  } catch (err) {
    log('warn', `sendToDaemon failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Inbound message handling ────────────────────────────────────────────────

/**
 * Dispatch a parsed inbound message from the daemon.
 *
 * @param {object} msg - Parsed JSON object.
 */
function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      log('info', `Registered with daemon (session: ${msg.sessionId})`);
      break;

    case 'ping':
      // ADR-7: reply immediately with the same id.
      sendToDaemon({ type: 'pong', id: msg.id });
      break;

    case 'session.command':
      handleCommand(msg);
      break;

    default:
      log('warn', `Unknown message type from daemon: "${msg.type}" — ignoring`);
  }
}

/**
 * Handle a `session.command` message from the daemon.
 * Injects the command text into the active Copilot CLI session.
 *
 * @param {{ sessionId: string, payload: { text?: string } }} msg
 *
 * TODO (Phase 6 Day 3–4): Full relay integration — collect streaming
 *   response chunks and send back `session.command-result` messages.
 */
async function handleCommand(msg) {
  if (sdkSession === null) {
    log('warn', 'session.command received but no SDK session — dropping');
    sendToDaemon({
      type: 'session.command-result',
      sessionId: SESSION_ID,
      payload: { error: 'no-sdk-session' },
    });
    return;
  }

  const text = typeof msg.payload?.text === 'string' ? msg.payload.text : '';
  if (text.length === 0) {
    log('warn', 'session.command: empty text payload — ignoring');
    return;
  }

  try {
    // Stub: collect full response then send a single command-result.
    // Phase 6 Day 3–4 will add streaming chunk forwarding.
    let accumulated = '';
    for await (const chunk of sdkSession.send(text)) {
      accumulated += chunk;
    }
    sendToDaemon({
      type: 'session.command-result',
      sessionId: SESSION_ID,
      payload: { text: accumulated },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `session.command error: ${message}`);
    sendToDaemon({
      type: 'session.command-result',
      sessionId: SESSION_ID,
      payload: { error: message },
    });
  }
}

// ─── Session event forwarding ─────────────────────────────────────────────────

/**
 * Subscribe to SDK session events and forward them to the daemon.
 *
 * @param {object} session - The SDK CopilotSession handle.
 *
 * TODO (Phase 6 Day 3–4): Wire specific event types (message, tool_call,
 *   stream_delta) once the relay refactor defines the forwarding schema.
 */
function wireSessionEvents(session) {
  // Stub: log that wiring is set up; specific event subscriptions added in Day 3–4.
  log('info', 'Session event forwarding wired (stub — awaiting relay refactor)');

  // Example of how to forward an event once event types are defined:
  // session.on('some.event', (payload) => {
  //   sendToDaemon({ type: 'session.event', sessionId: SESSION_ID, payload });
  // });
  void session; // suppress unused-variable lint until wired
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
    const socket = createConnection(PIPE_PATH);
    pipeSocket = socket;

    let lineBuffer = '';
    let registered = false;

    socket.setEncoding('utf-8');

    socket.on('connect', () => {
      reconnectAttempt = 0; // Reset backoff on successful connect.
      log('info', `Connected to daemon pipe (session: ${SESSION_ID})`);

      // ADR-2: push-based registration — first thing sent on connect.
      sendToDaemon({ type: 'register', sessionId: SESSION_ID });
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
    sdkSession = await joinSession();
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
