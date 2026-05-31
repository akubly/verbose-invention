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
    expect(result.sessionName).toBe('mysession');
    expect(result.cwd).toBe('C:\\Users\\Aaron Smith\\repo');
  });

  it('strips surrounding quotes from double-quoted --cwd value', () => {
    const result = parseNewFlags('my-project --cwd "D:\\git\\verbose invention"');
    expect(result.cwd).toBe('D:\\git\\verbose invention');
    // Quotes must be stripped — not present in the value.
    expect(result.cwd).not.toMatch(/^"/);
    expect(result.cwd).not.toMatch(/"$/);
  });

  it('handles double-quoted Unix-style path', () => {
    const result = parseNewFlags('my-project --cwd "/home/user/my project"');
    expect(result.cwd).toBe('/home/user/my project');
  });
});

// ─── Happy-path: single-quoted paths with spaces ──────────────────────────────

describe('parseNewFlags — single-quoted paths (I3)', () => {
  it('extracts --cwd with a single-quoted path containing spaces', () => {
    const result = parseNewFlags("mysession --cwd 'C:\\path with spaces'");
    expect(result.sessionName).toBe('mysession');
    expect(result.cwd).toBe('C:\\path with spaces');
  });

  it('strips surrounding single quotes from --cwd value', () => {
    const result = parseNewFlags("my-project --cwd '/home/user/my project'");
    expect(result.cwd).toBe('/home/user/my project');
    expect(result.cwd).not.toMatch(/^'/);
    expect(result.cwd).not.toMatch(/'$/);
  });
});

// ─── Happy-path: multi-flag order independence (I4) ──────────────────────────

describe('parseNewFlags — multiple flags, order-independent (I4)', () => {
  it('--model before --cwd: both extracted correctly', () => {
    const result = parseNewFlags('mysession --model gpt-5 --cwd myalias');
    expect(result.sessionName).toBe('mysession');
    expect(result.model).toBe('gpt-5');
    expect(result.cwd).toBe('myalias');
  });

  it('--cwd before --model: both extracted correctly', () => {
    const result = parseNewFlags('mysession --cwd myalias --model gpt-5');
    expect(result.sessionName).toBe('mysession');
    expect(result.cwd).toBe('myalias');
    expect(result.model).toBe('gpt-5');
  });

  it('--model with --cwd as quoted path: both extracted', () => {
    const result = parseNewFlags('mysession --model claude-4 --cwd "C:\\git\\my project"');
    expect(result.sessionName).toBe('mysession');
    expect(result.model).toBe('claude-4');
    expect(result.cwd).toBe('C:\\git\\my project');
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('parseNewFlags — error cases', () => {
  it('flag-as-value: --model --cwd value → throws descriptive error', () => {
    // "--model" is itself a flag, not a valid model name.
    expect(() => parseNewFlags('mysession --model --cwd value')).toThrow();
  });

  it('missing --cwd value (flag at end of input) → throws', () => {
    expect(() => parseNewFlags('mysession --cwd')).toThrow();
  });

  it('missing session name (/new --cwd value) → throws', () => {
    // "--cwd" as the first token is not a valid session name.
    expect(() => parseNewFlags('--cwd value')).toThrow();
  });

  it('empty match string → throws', () => {
    expect(() => parseNewFlags('')).toThrow();
  });

  it('whitespace-only match string → throws', () => {
    expect(() => parseNewFlags('   ')).toThrow();
  });
});

// ─── Regression: no flags → plain session name unchanged ──────────────────────

describe('parseNewFlags — no flags (regression)', () => {
  it('session name only: no cwd, no model', () => {
    const result = parseNewFlags('my-project');
    expect(result.sessionName).toBe('my-project');
    expect(result.cwd).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('session name with special chars (hyphens, numbers)', () => {
    const result = parseNewFlags('reach-v2-2024');
    expect(result.sessionName).toBe('reach-v2-2024');
  });
});
