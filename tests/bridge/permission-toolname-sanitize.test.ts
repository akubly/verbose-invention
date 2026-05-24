/**
 * I10 — toolName sanitization in BridgeSession._handlePermissionRequest
 *
 * Verifies that toolNames arriving from the extension are validated against the
 * allowlist regex.  Valid names pass through unchanged; names containing RTL
 * overrides, null bytes, or other disallowed characters are sanitized before
 * being forwarded to the permission callback (and ultimately the Telegram
 * prompt), preventing prompt-spoofing via Unicode manipulation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-sanitize-1';
const REQUEST_ID = 'req-sanitize-abc';
const PERM_ID = 'perm-sanitize-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePermSession(
  bridge: FakeBridge,
  callback: (toolName: string, args: string, signal?: AbortSignal) => Promise<boolean> = vi.fn().mockResolvedValue(true),
) {
  const sendResponseFn = vi.fn();
  const permissionCallback = vi.fn(callback);

  new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
    permissionCallback,
    sendPermissionResponseFn: sendResponseFn,
  });

  return { sendResponseFn, permissionCallback };
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Valid tool names ─────────────────────────────────────────────────────────

describe('I10 — toolName sanitization: valid names pass through unchanged', () => {
  it('simple lowercase name is forwarded as-is', async () => {
    const bridge = new FakeBridge();
    const { permissionCallback } = makePermSession(bridge);

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(receivedName).toBe('bash');
  });

  it('name with allowed special chars (letters, digits, _ . : -) passes through', async () => {
    const bridge = new FakeBridge();
    const { permissionCallback } = makePermSession(bridge);

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'my_tool.v1:foo-bar', '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(receivedName).toBe('my_tool.v1:foo-bar');
  });

  it('name starting with underscore passes through', async () => {
    const bridge = new FakeBridge();
    const { permissionCallback } = makePermSession(bridge);

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, '_internal_tool', '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(receivedName).toBe('_internal_tool');
  });
});

// ─── RTL override ─────────────────────────────────────────────────────────────

describe('I10 — toolName sanitization: RTL override is replaced', () => {
  it('toolName containing U+202E RTL override is sanitized; callback receives the safe version', async () => {
    const bridge = new FakeBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { permissionCallback } = makePermSession(bridge);

    // Attacker attempts to make 'bash\u202Emalware' display as 'bash' → 'erawlam'
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash\u202Emalware', '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    // RTL override replaced with '_'; callback must NOT see the raw hostile string
    expect(receivedName).toBe('bash_malware');
    expect(receivedName).not.toContain('\u202E');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[bridgeSession] toolName failed allowlist validation');
  });
});

// ─── Null byte ────────────────────────────────────────────────────────────────

describe('I10 — toolName sanitization: null byte is replaced', () => {
  it('toolName containing null byte is sanitized; callback receives safe version', async () => {
    const bridge = new FakeBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { permissionCallback } = makePermSession(bridge);

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash\u0000secret', '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(receivedName).toBe('bash_secret');
    expect(receivedName).not.toContain('\u0000');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// ─── Oversized name ───────────────────────────────────────────────────────────

describe('I10 — toolName sanitization: oversized toolName is truncated', () => {
  it('toolName longer than 128 chars is truncated to 128 chars and sanitized', async () => {
    const bridge = new FakeBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { permissionCallback } = makePermSession(bridge);

    // 200-char string; all ASCII letters → would be valid except for length
    const longName = 'a'.repeat(200);
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, longName, '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    // The 200-char all-lowercase name fails the regex (max 128), so it's truncated
    expect(receivedName.length).toBe(128);
    expect(receivedName).toBe('a'.repeat(128));
    // Warning must have been emitted
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('toolName with disallowed chars AND excess length: both truncated and sanitized', async () => {
    const bridge = new FakeBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { permissionCallback } = makePermSession(bridge);

    // 150 chars, every char is a space (disallowed)
    const hostileName = ' '.repeat(150);
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, hostileName, '{}');
    await flush();

    const [receivedName] = (permissionCallback as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    // Truncated to 128, then spaces replaced with '_'
    expect(receivedName.length).toBe(128);
    expect(receivedName).toBe('_'.repeat(128));
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
