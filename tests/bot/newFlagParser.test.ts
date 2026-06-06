/**
 * Quote-aware flag parser tests (I3+I4 — Carter is implementing).
 *
 * Carter is refactoring the /new command flag parser to handle:
 *   - Double-quoted values with spaces  (--cwd "C:\Users\Aaron Smith\repo")
 *   - Single-quoted values with spaces  (--cwd 'C:\path with spaces')
 *   - Multiple flags in any order       (--model gpt-5 --cwd alias)
 *   - Flag-as-value detection           (--model --cwd value → error)
 *   - Missing flag value                (--cwd with no following token → error)
 *   - Missing session name              (/new --cwd → error, needs name first)
 *
 * Expected export: `parseNewFlags(match: string): ParsedNewFlags`
 * where `ParsedNewFlags = { sessionName: string; cwd?: string; model?: string }`
 * and throws a descriptive string on bad input.
 *
 * Alternatively Carter may export `parseFlagString` or similar — adjust the
 * import path/name if the actual export differs.
 *
 * ─── Quote-handling contract ─────────────────────────────────────────────────
 * Documented in .squad/decisions/inbox/jun-phase9-review-tests.md:
 *   - Double quotes (" "): values may contain spaces; quote chars stripped
 *   - Single quotes (' '): same as double quotes
 *   - No escape sequences inside quotes (backslash is literal — needed for
 *     Windows paths like C:\Users\Aaron Smith\repo)
 *   - Unmatched quotes: treated as error or literal quote (TBD by Carter)
 *
 * ⚠️  RED until Carter lands the quote-aware parser.
 */

import { describe, it, expect } from 'vitest';
import { parseNewFlags } from '../../src/bot/newFlagParser.js';

// ─── Happy-path: double-quoted paths with spaces ──────────────────────────────

describe('parseNewFlags — double-quoted paths (I3)', () => {
  it('extracts --cwd with a double-quoted path containing spaces', () => {
    const result = parseNewFlags('mysession --cwd "C:\\Users\\Aaron Smith\\repo"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
    expect(result.value.cwd).toBe('C:\\Users\\Aaron Smith\\repo');
  });

  it('strips surrounding quotes from double-quoted --cwd value', () => {
    const result = parseNewFlags('my-project --cwd "D:\\git\\verbose invention"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cwd).toBe('D:\\git\\verbose invention');
    // Quotes must be stripped — not present in the value.
    expect(result.value.cwd).not.toMatch(/^"/);
    expect(result.value.cwd).not.toMatch(/"$/);
  });

  it('handles double-quoted Unix-style path', () => {
    const result = parseNewFlags('my-project --cwd "/home/user/my project"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cwd).toBe('/home/user/my project');
  });
});

// ─── Happy-path: single-quoted paths with spaces ──────────────────────────────

describe('parseNewFlags — single-quoted paths (I3)', () => {
  it('extracts --cwd with a single-quoted path containing spaces', () => {
    const result = parseNewFlags("mysession --cwd 'C:\\path with spaces'");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
    expect(result.value.cwd).toBe('C:\\path with spaces');
  });

  it('strips surrounding single quotes from --cwd value', () => {
    const result = parseNewFlags("my-project --cwd '/home/user/my project'");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cwd).toBe('/home/user/my project');
    expect(result.value.cwd).not.toMatch(/^'/);
    expect(result.value.cwd).not.toMatch(/'$/);
  });
});

// ─── Happy-path: multi-flag order independence (I4) ──────────────────────────

describe('parseNewFlags — multiple flags, order-independent (I4)', () => {
  it('--model before --cwd: both extracted correctly', () => {
    const result = parseNewFlags('mysession --model gpt-5 --cwd myalias');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
    expect(result.value.model).toBe('gpt-5');
    expect(result.value.cwd).toBe('myalias');
  });

  it('--cwd before --model: both extracted correctly', () => {
    const result = parseNewFlags('mysession --cwd myalias --model gpt-5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
    expect(result.value.cwd).toBe('myalias');
    expect(result.value.model).toBe('gpt-5');
  });

  it('--model with --cwd as quoted path: both extracted', () => {
    const result = parseNewFlags('mysession --model claude-4 --cwd "C:\\git\\my project"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
    expect(result.value.model).toBe('claude-4');
    expect(result.value.cwd).toBe('C:\\git\\my project');
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('parseNewFlags — error cases', () => {
  it('flag-as-value: --model --cwd value → ok: false', () => {
    const result = parseNewFlags('mysession --model --cwd value');
    expect(result.ok).toBe(false);
  });

  it('missing --cwd value (flag at end of input) → ok: false', () => {
    const result = parseNewFlags('mysession --cwd');
    expect(result.ok).toBe(false);
  });

  it('missing session name (/new --cwd value) → ok: false', () => {
    const result = parseNewFlags('--cwd value');
    expect(result.ok).toBe(false);
  });

  it('empty match string → ok: false', () => {
    const result = parseNewFlags('');
    expect(result.ok).toBe(false);
  });

  it('whitespace-only match string → ok: false', () => {
    const result = parseNewFlags('   ');
    expect(result.ok).toBe(false);
  });
});

// ─── Regression: no flags → plain session name unchanged ──────────────────────

describe('parseNewFlags — no flags (regression)', () => {
  it('session name only: no cwd, no model', () => {
    const result = parseNewFlags('my-project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('my-project');
    expect(result.value.cwd).toBeUndefined();
    expect(result.value.model).toBeUndefined();
  });

  it('session name with special chars (hyphens, numbers)', () => {
    const result = parseNewFlags('reach-v2-2024');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('reach-v2-2024');
  });
});

// ─── C2 regression: backslash is literal inside double quotes ─────────────────

describe('parseNewFlags — backslash is literal in double-quoted values (C2 regression)', () => {
  it('UNC-style path "\\\\\\\\server\\\\share" → cwd = \\\\server\\share (no escape collapse)', () => {
    // Input string to parseNewFlags: mysession --cwd "\\server\share"
    // With backslash-as-literal: \\server\share is preserved as-is.
    // With old escape processing: \\ would collapse to \ giving \server\share.
    const result = parseNewFlags('mysession --cwd "\\\\server\\share"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cwd).toBe('\\\\server\\share');
  });
});

// ─── Cycle 12: quoted multi-word session name rejected ────────────────────────

describe('parseNewFlags — quoted multi-word session name rejected (cycle 12)', () => {
  it('quoted session name with internal space → ok: false with spaces error', () => {
    const result = parseNewFlags('"my session"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/spaces/i);
  });

  it('quoted multi-word error message matches unquoted multi-word error', () => {
    const quoted = parseNewFlags('"my session"');
    const unquoted = parseNewFlags('my session');
    expect(quoted.ok).toBe(false);
    expect(unquoted.ok).toBe(false);
    if (quoted.ok || unquoted.ok) return;
    expect(quoted.error).toBe(unquoted.error);
  });

  it('single-word session name → ok: true (regression guard)', () => {
    const result = parseNewFlags('mysession');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
  });

  it('unquoted multi-word → ok: false (existing behavior preserved)', () => {
    const result = parseNewFlags('my session');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/spaces/i);
  });

  it('quoted name with leading/trailing whitespace → trimmed to valid name', () => {
    // sessionName = sessionParts.join(' ').trim() strips outer whitespace from
    // a quoted token like " mysession" → 'mysession' → ok: true.
    const result = parseNewFlags('" mysession"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('mysession');
  });
});

// ─── C2 regression: multi-word session name returns error, not silent join ────

describe('parseNewFlags — multi-word session name returns error (C2 regression)', () => {
  it('two unquoted words as session name → ok: false with spaces error', () => {
    const result = parseNewFlags('my session');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/spaces/i);
  });

  it('multi-word error message hints at quoting', () => {
    const result = parseNewFlags('my big project');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/quote/i);
  });

  it('single-word session name → ok: true, no error', () => {
    const result = parseNewFlags('myproject');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe('myproject');
  });
});
