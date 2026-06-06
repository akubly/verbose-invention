/**
 * B3 Pipe Authentication (ADR-10) — regression suite.
 *
 * Verifies that `FakeDaemon.setRequiredToken()` correctly models the token-
 * validation behaviour introduced by ADR-10:
 *
 *   1. Valid token → `session.registered` received, session registered.
 *   2. Missing token → connection closed silently; no `session.registered`.
 *   3. Wrong token  → connection closed silently; no `session.registered`.
 *   4. Token change (daemon restart) → old token rejected, new token accepted.
 *   5. ADR-6 reconnect: same sessionId re-hello with valid token still works.
 *
 * Transport: pure in-memory (FakeDaemon + FakeExtensionClient).
 * No real Windows named pipe is required — these tests run on any OS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDaemon } from '../helpers/FakeDaemon.js';
import { FakeExtensionClient } from '../helpers/FakeExtensionClient.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { generatePipeAuth, cleanupPipeAuth, getAuthFilePath } from '../../src/bridge/pipeAuth.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_TOKEN = 'a'.repeat(64); // 64-char hex stand-in

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('B3 pipe auth — FakeDaemon token validation (ADR-10)', () => {
  let daemon: FakeDaemon;

  beforeEach(() => {
    daemon = new FakeDaemon();
    daemon.setRequiredToken(VALID_TOKEN);
  });

  afterEach(() => {
    daemon.reset();
  });

  // ── 1. Valid token ──────────────────────────────────────────────────────────

  it('valid token → session.registered received and session registered', async () => {
    const client = new FakeExtensionClient('sess-auth-ok', 'reach-test');
    client.connect(daemon);
    client.sendHello(VALID_TOKEN);

    await flush();

    expect(daemon.isRegistered('sess-auth-ok')).toBe(true);
    const acks = client.receivedOfType('session.registered');
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ type: 'session.registered', sessionId: 'sess-auth-ok' });
  });

  // ── 2. Missing token ────────────────────────────────────────────────────────

  it('missing token → connection closed silently; no session.registered', async () => {
    const client = new FakeExtensionClient('sess-no-token', 'reach-test');
    client.connect(daemon);
    client.sendHello(); // no authToken argument

    await flush();
    await flush(); // extra drain for 'end' event propagation

    expect(daemon.isRegistered('sess-no-token')).toBe(false);
    expect(client.receivedOfType('session.registered')).toHaveLength(0);
    // No hello recorded in daemon's received log (rejected before logging).
    expect(daemon.messagesOfType('hello')).toHaveLength(0);
  });

  // ── 3. Wrong token ──────────────────────────────────────────────────────────

  it('wrong token → connection closed silently; no session.registered', async () => {
    const client = new FakeExtensionClient('sess-bad-token', 'reach-test');
    client.connect(daemon);
    client.sendHello('b'.repeat(64)); // wrong token

    await flush();
    await flush();

    expect(daemon.isRegistered('sess-bad-token')).toBe(false);
    expect(client.receivedOfType('session.registered')).toHaveLength(0);
    expect(daemon.messagesOfType('hello')).toHaveLength(0);
  });

  // ── 4. Token change (daemon restart simulation) ─────────────────────────────

  it('old token rejected after token rotation; new token accepted', async () => {
    // Session A connects with the first token.
    const clientA = new FakeExtensionClient('sess-rotate-a', 'reach-a');
    clientA.connect(daemon);
    clientA.sendHello(VALID_TOKEN);
    await flush();
    expect(daemon.isRegistered('sess-rotate-a')).toBe(true);

    // Simulate daemon restart: rotate to a new token.
    daemon.reset();
    const NEW_TOKEN = 'c'.repeat(64);
    daemon.setRequiredToken(NEW_TOKEN);

    // Session B tries with the OLD token — must be rejected.
    const clientB = new FakeExtensionClient('sess-rotate-b', 'reach-b');
    clientB.connect(daemon);
    clientB.sendHello(VALID_TOKEN);
    await flush();
    await flush();
    expect(daemon.isRegistered('sess-rotate-b')).toBe(false);

    // Session B retries with the NEW token — must be accepted.
    const clientC = new FakeExtensionClient('sess-rotate-b', 'reach-b');
    clientC.connect(daemon);
    clientC.sendHello(NEW_TOKEN);
    await flush();
    expect(daemon.isRegistered('sess-rotate-b')).toBe(true);
  });

  // ── 5. ADR-6 reconnect: same sessionId re-hello with valid token ────────────

  it('ADR-6 reconnect: same sessionId re-hello with valid token is accepted', async () => {
    const client = new FakeExtensionClient('sess-reconnect', 'reach-rc');
    client.connect(daemon);
    client.sendHello(VALID_TOKEN);
    await flush();
    expect(daemon.isRegistered('sess-reconnect')).toBe(true);

    // Drop and reconnect (simulates pipe re-established after daemon restart).
    client.dropConnection();
    await flush();

    const client2 = new FakeExtensionClient('sess-reconnect', 'reach-rc');
    client2.connect(daemon);
    client2.sendHello(VALID_TOKEN);
    await flush();

    expect(daemon.isRegistered('sess-reconnect')).toBe(true);
    expect(client2.receivedOfType('session.registered')).toHaveLength(1);
  });

  // ── 6. No auth check when token not configured ──────────────────────────────

  it('no required token configured → hello without authToken is accepted', async () => {
    // Reset to no-auth mode (backward compat for existing test suites).
    daemon.reset();
    daemon.setRequiredToken(null);

    const client = new FakeExtensionClient('sess-noauth', 'reach-noauth');
    client.connect(daemon);
    client.sendHello(); // no token
    await flush();

    expect(daemon.isRegistered('sess-noauth')).toBe(true);
    expect(client.receivedOfType('session.registered')).toHaveLength(1);
  });
});

// ─── N1: timingSafeEqual — length-mismatch guard ─────────────────────────────

describe('N1 — constant-time token comparison (FakeDaemon models the reject path)', () => {
  it('token with wrong length is rejected (not just wrong bytes)', async () => {
    const daemon = new FakeDaemon();
    daemon.setRequiredToken(VALID_TOKEN);

    const client = new FakeExtensionClient('sess-shorttoken', 'reach-short');
    client.connect(daemon);
    // Send a token that is the right prefix but shorter than 64 chars.
    client.sendHello('a'.repeat(32));

    await flush();
    await flush();

    expect(daemon.isRegistered('sess-shorttoken')).toBe(false);
    expect(client.receivedOfType('session.registered')).toHaveLength(0);
    daemon.reset();
  });

  it('empty authToken is rejected', async () => {
    const daemon = new FakeDaemon();
    daemon.setRequiredToken(VALID_TOKEN);

    const client = new FakeExtensionClient('sess-emptytoken', 'reach-empty');
    client.connect(daemon);
    client.sendHello('');

    await flush();
    await flush();

    expect(daemon.isRegistered('sess-emptytoken')).toBe(false);
    daemon.reset();
  });
});

// ─── N2: cleanupPipeAuth — removes auth file on shutdown ─────────────────────

describe('N2 — cleanupPipeAuth() removes auth file on daemon shutdown', () => {
  it('removes the auth file after generatePipeAuth writes it', async () => {
    // Write a real auth file to a temp location.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-test-'));

    // Redirect getReachDataDir() (and thus getAuthFilePath()) to tempDir.
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      const config = await generatePipeAuth();

      // File should now exist.
      await expect(fs.access(getAuthFilePath())).resolves.toBeUndefined();

      // Cleanup should remove it.
      await cleanupPipeAuth();
      await expect(fs.access(getAuthFilePath())).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cleanupPipeAuth is a no-op when auth file is already gone (ENOENT)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-test-'));
    vi.stubEnv('REACH_DATA_DIR', tempDir);

    try {
      const config = await generatePipeAuth();
      // Delete the file manually first.
      await fs.unlink(getAuthFilePath());
      // Calling cleanupPipeAuth again should not throw.
      await expect(cleanupPipeAuth()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── N3: Path alignment — daemon getAuthFilePath() matches extension logic ────
//
// The extension replicates getReachDataDir() in standalone JS (no TS imports).
// These tests pin the daemon's getAuthFilePath() contract so any drift between
// src/config/config.ts and extension.mjs getAuthFilePath() is caught here.
// See: .squad/decisions/inbox/carter-pr10-cycle14.md
//
// NOTE: extension.mjs getAuthFilePath() is NOT exported and cannot be unit-tested
// directly from this TS harness — only the daemon side is asserted here.
// The extension logic mirrors the daemon exactly (REACH_DATA_DIR override →
// path.resolve(); fallback → os.homedir()/.reach/). Manual review required for
// extension-side path changes.

describe('N3 — getAuthFilePath() path contract (daemon ↔ extension alignment)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('default (no REACH_DATA_DIR) → ~/.reach/bridge-auth.json', () => {
    vi.stubEnv('REACH_DATA_DIR', '');
    const expected = path.join(os.homedir(), '.reach', 'bridge-auth.json');
    expect(getAuthFilePath()).toBe(expected);
  });

  it('REACH_DATA_DIR set to absolute path → resolves under that directory', () => {
    const customDir = path.join(os.tmpdir(), 'reach-custom-test');
    vi.stubEnv('REACH_DATA_DIR', customDir);
    const expected = path.join(path.resolve(customDir), 'bridge-auth.json');
    expect(getAuthFilePath()).toBe(expected);
  });

  it('REACH_DATA_DIR with surrounding whitespace → trimmed before resolving', () => {
    const customDir = path.join(os.tmpdir(), 'reach-trim-test');
    vi.stubEnv('REACH_DATA_DIR', `  ${customDir}  `);
    const expected = path.join(path.resolve(customDir.trim()), 'bridge-auth.json');
    expect(getAuthFilePath()).toBe(expected);
  });

  it('REACH_DATA_DIR set to whitespace-only string → treated as unset, falls back to ~/.reach', () => {
    vi.stubEnv('REACH_DATA_DIR', '   ');
    const expected = path.join(os.homedir(), '.reach', 'bridge-auth.json');
    expect(getAuthFilePath()).toBe(expected);
  });
});
