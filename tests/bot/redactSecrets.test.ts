/**
 * Tests for src/bot/redactSecrets.ts (I11 — Kat is creating this module).
 *
 * Contract under test (export: `redactSecrets(text: string): string`):
 *   - Keyword-prefixed token patterns redacted (e.g., "token: <value>")
 *   - ENV-style assignment values redacted (e.g., "TELEGRAM_BOT_TOKEN=12345:abc...")
 *   - High-entropy bare strings ≥40 chars redacted
 *   - URL credentials stripped (user:pass@ in authority)
 *   - Plain prose unchanged
 *   - Already-redacted text is idempotent (no double-redaction)
 *   - Short tokens (<16 chars) NOT redacted (avoid over-redaction of common words)
 *   - Whole-excerpt path: only the secret is replaced in a multi-sentence input
 *
 * ⚠️  RED until Kat creates src/bot/redactSecrets.ts.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/bot/redactSecrets.js';

// Convenience: a placeholder that should appear where secrets were.
const REDACT_MARKER = '[REDACTED]';

// High-entropy string ≥40 chars (random-looking, no keyword needed).
const HIGH_ENTROPY = 'k9Xm2pQr7vNsLwDhYcE4aOjZtFu1Ii8bGnA5MoV';
// The same length but short — must NOT be redacted.
const SHORT_TOKEN  = 'shorttoken123';
// Fake GitHub token — obviously not a real PAT (contains '-'), won't trip secret scanning.
// Reused in T1 and T2 so a single value covers both the unquoted and quoted ENV-pass tests.
const FAKE_GH_TOKEN = 'not-a-real-token-0000';

describe('redactSecrets — keyword-prefixed tokens', () => {
  it('replaces value after "token:" keyword', () => {
    const input  = 'Authorization: token abc123longtokenhere1234567890';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123longtokenhere1234567890');
    expect(result).toContain('token');   // keyword preserved
  });

  it('replaces value after "password:" keyword', () => {
    const input  = 'password: supersecretpasswordvalue12345678';
    const result = redactSecrets(input);
    expect(result).not.toContain('supersecretpasswordvalue12345678');
    expect(result).toContain('password');  // keyword preserved
  });

  it('replaces value after "api_key:" keyword', () => {
    const input  = 'api_key: ABCDEF1234567890abcdef1234567890AB';
    const result = redactSecrets(input);
    expect(result).not.toContain('ABCDEF1234567890abcdef1234567890AB');
  });
});

describe('redactSecrets — ENV-style assignments', () => {
  it('redacts the value in TELEGRAM_BOT_TOKEN=<value>', () => {
    const input  = 'TELEGRAM_BOT_TOKEN=12345:abcdefghijklmnopqrstuvwxyz1234567890';
    const result = redactSecrets(input);
    expect(result).not.toContain('12345:abcdefghijklmnopqrstuvwxyz1234567890');
    // Variable name should remain visible.
    expect(result).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('redacts the value in GITHUB_TOKEN=<value>', () => {
    const input  = `GITHUB_TOKEN=${FAKE_GH_TOKEN}`;
    const result = redactSecrets(input);
    expect(result).not.toContain(FAKE_GH_TOKEN);
    expect(result).toContain('GITHUB_TOKEN');
  });
});

describe('redactSecrets — high-entropy bare strings', () => {
  it('redacts a bare high-entropy string ≥40 chars', () => {
    const result = redactSecrets(HIGH_ENTROPY);
    expect(result).not.toContain(HIGH_ENTROPY);
  });

  it('does NOT redact a short (<16 chars) string', () => {
    const result = redactSecrets(SHORT_TOKEN);
    expect(result).toContain(SHORT_TOKEN);
  });
});

describe('redactSecrets — URL credentials', () => {
  it('strips user:password from URL authority', () => {
    const input  = 'Repository at https://user:password@example.com/repo.git';
    const result = redactSecrets(input);
    expect(result).not.toContain('user:password@');
    // Host should survive.
    expect(result).toContain('example.com');
  });
});

describe('redactSecrets — plain prose unchanged', () => {
  it('leaves a sentence with no secrets intact', () => {
    const input = 'The quick brown fox jumps over the lazy dog.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('leaves a normal log line intact', () => {
    const input = 'Session abc123 registered for user akubl at 2024-01-01T00:00:00Z.';
    expect(redactSecrets(input)).toBe(input);
  });
});

describe('redactSecrets — idempotency', () => {
  it('applying redactSecrets twice yields the same result as once', () => {
    const input     = `TELEGRAM_BOT_TOKEN=12345:abcdefghijklmnopqrstuvwxyz1234567890 and some prose`;
    const once      = redactSecrets(input);
    const twice     = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it('already-redacted text is unchanged', () => {
    const alreadyRedacted = `${REDACT_MARKER} and some prose`;
    expect(redactSecrets(alreadyRedacted)).toBe(alreadyRedacted);
  });
});

describe('redactSecrets — whole-excerpt path', () => {
  it('replaces only the secret mid-sentence, leaving surrounding text intact', () => {
    const prefix = 'Connecting to the relay service. ';
    const suffix = ' Please verify your network connection.';
    const secret = HIGH_ENTROPY;
    const input  = `${prefix}Using token: ${secret}${suffix}`;

    const result = redactSecrets(input);

    // Secret gone.
    expect(result).not.toContain(secret);
    // Surrounding prose survives.
    expect(result).toContain('Connecting to the relay service');
    expect(result).toContain('Please verify your network connection');
  });
});

// ─── C6 — Quote preservation (T3–T6) ─────────────────────────────────────────

describe('redactSecrets — quote preservation (C6)', () => {
  it('C6-1 double-quoted keyword value: closing quote preserved', () => {
    const input  = 'token="abc123longvalue1234567890"';
    const result = redactSecrets(input);
    expect(result).toBe('token="[REDACTED]"');
  });

  it('C6-2 single-quoted keyword value: closing quote preserved', () => {
    const input  = "token='abc123longvalue1234567890'";
    const result = redactSecrets(input);
    expect(result).toBe("token='[REDACTED]'");
  });

  it('C6-3 unquoted keyword value: no spurious quote added', () => {
    const input  = 'token=abc123longvalue1234567890';
    const result = redactSecrets(input);
    expect(result).toBe('token=[REDACTED]');
  });

  it('C6-4 double-quoted ENV assignment: closing quote preserved', () => {
    const input  = `GITHUB_TOKEN="${FAKE_GH_TOKEN}"`;
    const result = redactSecrets(input);
    expect(result).toBe('GITHUB_TOKEN="[REDACTED]"');
  });

  it('C6-5 mismatched quote (open double, close single): value still redacted, whatever close char was found is re-emitted', () => {
    // The regex makes a best-effort capture of the trailing quote character.
    // The important invariant is that the value is gone.
    const input  = 'token="abc123longvalue1234567890\'';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123longvalue1234567890');
  });
});


// ─── C8 — Extended charset: JWT and base64-with-padding ──────────────────────

describe('redactSecrets — JWT and base64-padded strings (C8)', () => {
  it('C8-1 JWT-shaped token (three dot-separated base64url segments, 39+ chars) is redacted', () => {
    // Realistic JWT header.payload.signature — total length well over 39 chars.
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactSecrets(jwt);
    expect(result).not.toContain(jwt);
    expect(result).toContain('[REDACTED]');
  });

  it('C8-2 base64 string with = padding (40+ chars) is redacted', () => {
    // 42-char base64 value with == padding.
    const b64 = 'c29tZTQwK2NoYXJ2YWx1ZXdpdGhwYWRkaW5nZXh0cmE==';
    const result = redactSecrets(b64);
    expect(result).not.toContain(b64);
    expect(result).toContain('[REDACTED]');
  });
});

describe('redactSecrets — AWS key patterns (C2-I1)', () => {
  it('redacts value in AWS_ACCESS_KEY_ID=<value>', () => {
    const input  = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('AWS_ACCESS_KEY_ID');
  });

  it('redacts bare high-entropy value with / and + (guards C8 charset)', () => {
    // Bare value — NO KEY= prefix — so only HIGH_ENTROPY_PATTERN can redact it.
    // Contains / and + (chars added to the charset in cycle-8). If the charset
    // regressed to exclude those chars, the 42-char value would fragment into short
    // runs (longest: ~12 chars) and NEITHER assertion below would hold.
    // Deliberately avoids keyword words (token, key, secret…) to prevent
    // KEYWORD_PATTERN from firing first and masking the real test target.
    // The toBe assertion further guards against partial/fragmented redaction.
    const bare = 'FAKE+Xm3z9pQr/vNsLwD7hYc+E4aOjZtFu1Ii/8bGn';
    const result = redactSecrets(bare);
    expect(result).not.toContain(bare);
    expect(result).toBe('[REDACTED]');
  });

  it('plain prose with words "access" or "key" NOT adjacent to assignment → not redacted', () => {
    const input = 'Please access the key storage system for config details.';
    expect(redactSecrets(input)).toBe(input);
  });
});
