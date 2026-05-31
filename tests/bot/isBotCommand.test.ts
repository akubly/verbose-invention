/**
 * Pure unit tests for isBotCommand() and BOT_COMMANDS.
 *
 * Anticipatory tests (Phase 9 Item 2) — RED until Carter lands src/bot/commands.ts.
 * Expected import failure: "Cannot find module '../../src/bot/commands.js'"
 *
 * Carter's contract (per Q2-1 = centralize, design doc §Item 2):
 *   export const BOT_COMMANDS: ReadonlySet<string>   — the canonical bot command set
 *   export function isBotCommand(text: string): boolean
 *     Returns true iff text starts with '/' AND the extracted command word is in BOT_COMMANDS.
 *     Extraction regex: /^\/([a-z_]+)/ (case-sensitive, stops at first non-[a-z_] char).
 *
 * Import path assumption: src/bot/commands.ts (most likely for a new centralized module).
 * If Carter exports from handlers.ts instead, update the import below.
 * See .squad/decisions/inbox/jun-phase9-item2-tests.md for full rationale.
 */

import { describe, it, expect } from 'vitest';
import { isBotCommand, BOT_COMMANDS } from '../../src/bot/commands.js';

// ── BOT_COMMANDS set contract ────────────────────────────────────────────────

describe('BOT_COMMANDS', () => {
  it('is a non-empty Set', () => {
    expect(BOT_COMMANDS).toBeInstanceOf(Set);
    expect(BOT_COMMANDS.size).toBeGreaterThan(0);
  });

  it.each(['new', 'list', 'remove', 'resume', 'help', 'pair'])(
    'contains bot command: %s',
    (cmd) => {
      expect(BOT_COMMANDS.has(cmd)).toBe(true);
    },
  );

  it('does not contain CLI command: clear', () => {
    expect(BOT_COMMANDS.has('clear')).toBe(false);
  });

  it('does not contain CLI command: agent', () => {
    expect(BOT_COMMANDS.has('agent')).toBe(false);
  });

  it('does not contain CLI command: model', () => {
    expect(BOT_COMMANDS.has('model')).toBe(false);
  });
});

// ── isBotCommand — known bot commands → true ────────────────────────────────

describe('isBotCommand — known bot commands', () => {
  it('/new → true', () => {
    expect(isBotCommand('/new')).toBe(true);
  });

  it('/list → true', () => {
    expect(isBotCommand('/list')).toBe(true);
  });

  it('/help → true', () => {
    expect(isBotCommand('/help')).toBe(true);
  });

  it('/remove → true', () => {
    expect(isBotCommand('/remove')).toBe(true);
  });

  it('/resume → true', () => {
    expect(isBotCommand('/resume')).toBe(true);
  });

  it('/pair → true', () => {
    expect(isBotCommand('/pair')).toBe(true);
  });

  it('/new arg1 arg2 → true (bot command with trailing args)', () => {
    expect(isBotCommand('/new arg1 arg2')).toBe(true);
  });

  it('/help   → true (bot command with trailing spaces)', () => {
    expect(isBotCommand('/help   ')).toBe(true);
  });
});

// ── isBotCommand — CLI commands (not in BOT_COMMANDS) → false ───────────────

describe('isBotCommand — CLI commands pass through', () => {
  it('/clear → false (CLI command — must reach the session)', () => {
    expect(isBotCommand('/clear')).toBe(false);
  });

  it('/agent → false (CLI command)', () => {
    expect(isBotCommand('/agent')).toBe(false);
  });

  it('/model → false (CLI command)', () => {
    expect(isBotCommand('/model')).toBe(false);
  });

  it('/unknowncommand → false (anything not in BOT_COMMANDS passes through)', () => {
    expect(isBotCommand('/unknowncommand')).toBe(false);
  });

  it('/clear something → false (CLI command with args)', () => {
    expect(isBotCommand('/clear something')).toBe(false);
  });
});

// ── isBotCommand — degenerate and edge cases → false ────────────────────────

describe('isBotCommand — degenerate inputs', () => {
  it('empty string → false', () => {
    expect(isBotCommand('')).toBe(false);
  });

  it('/ (just a slash) → false (no command word follows)', () => {
    expect(isBotCommand('/')).toBe(false);
  });

  it('plain text without slash → false', () => {
    expect(isBotCommand('hello world')).toBe(false);
  });

  it('   /new (leading whitespace) → false (slash not at position 0)', () => {
    // Contract: must start with '/' at position 0; leading whitespace is not stripped.
    expect(isBotCommand('   /new')).toBe(false);
  });
});

// ── isBotCommand — spoofed / prefix-only matches → false ────────────────────

describe('isBotCommand — word-boundary matching (no prefix collisions)', () => {
  it('/newxyz → false (extracts "newxyz", not in BOT_COMMANDS)', () => {
    // Regression: membership check must be exact match, not prefix.
    // The regex /^\/([a-z_]+)/ extracts the full lowercase word before any
    // non-[a-z_] char — "newxyz" is the extracted word, not a prefix of "new".
    expect(isBotCommand('/newxyz')).toBe(false);
  });

  it('/listmore → false (extracts "listmore", not "list")', () => {
    expect(isBotCommand('/listmore')).toBe(false);
  });

  it('/helpdesk → false', () => {
    expect(isBotCommand('/helpdesk')).toBe(false);
  });
});

// ── isBotCommand — case sensitivity ─────────────────────────────────────────

describe('isBotCommand — case insensitive (Carter decision: normalize to lowercase)', () => {
  // Carter's implementation: regex /^\/([a-zA-Z_]+)/ + .toLowerCase() before Set lookup.
  // Telegram sends commands lowercase, but the daemon accepts any casing for robustness.
  it('/New (initial cap) → true', () => {
    expect(isBotCommand('/New')).toBe(true);
  });

  it('/NEW (all caps) → true', () => {
    expect(isBotCommand('/NEW')).toBe(true);
  });

  it('/LIST (all caps) → true', () => {
    expect(isBotCommand('/LIST')).toBe(true);
  });

  it('/CLEAR (all caps) → false (clear is a CLI command regardless of casing)', () => {
    expect(isBotCommand('/CLEAR')).toBe(false);
  });

  // Case-sensitive variant would mean '/New' → false; Carter rejected that.
  it.todo('case-sensitive variant — /New → false (Carter chose case-insensitive instead)');
});

// ── isBotCommand — multi-line input ─────────────────────────────────────────

describe('isBotCommand — multi-line input', () => {
  it('/new\\nrest → true (newline stops regex, "new" is extracted)', () => {
    // '\n' is not [a-zA-Z_], so the regex stops after 'new' and extracts it.
    expect(isBotCommand('/new\nrest')).toBe(true);
  });

  it('/clear\\nstuff → false (extracts "clear", not in BOT_COMMANDS)', () => {
    expect(isBotCommand('/clear\nstuff')).toBe(false);
  });
});

// ── isBotCommand — Telegram @botname disambiguation suffix ──────────────────

describe('isBotCommand — Telegram @botname suffix', () => {
  // Telegram clients append @BotName when multiple bots share a group.
  // grammY strips it for command handlers, but raw text (message:text) may include it.
  // The design doc regex [a-z_]+ stops at '@', so "new" is extracted from "/new@MyBot".
  it('/new@MyBot → true (@ stops regex, extracts "new")', () => {
    expect(isBotCommand('/new@MyBot')).toBe(true);
  });

  it('/clear@MyBot → false ("clear" is not a bot command)', () => {
    expect(isBotCommand('/clear@MyBot')).toBe(false);
  });

  it('/newbot@MyBot → false (extracts "newbot", not in BOT_COMMANDS)', () => {
    expect(isBotCommand('/newbot@MyBot')).toBe(false);
  });
});

// ── isBotCommand — B1: digit in command position ────────────────────────────
//
// Carter's fix changes extraction regex from /^\/([a-z_]+)/ to
// /^\/([a-zA-Z_][a-zA-Z0-9_]*)/ (digits allowed after first char).
//
// BEFORE the fix: /new123 → regex stops at '1', extracts "new" → true  (BUG!)
// AFTER the fix:  /new123 → extracts "new123" → not in BOT_COMMANDS → false ✓
//
// RED until Carter lands the regex change.

describe('isBotCommand — B1: digit handling (anticipatory)', () => {
  it('/new123 → false (digit suffix not in BOT_COMMANDS)', () => {
    // Before fix: /^\/([a-z_]+)/ extracts "new" → true (wrong).
    // After fix:  /^\/([a-zA-Z_][a-zA-Z0-9_]*)/ extracts "new123" → false.
    expect(isBotCommand('/new123')).toBe(false);
  });

  it('/list1 → false (digit suffix not in BOT_COMMANDS)', () => {
    expect(isBotCommand('/list1')).toBe(false);
  });

  it('/status42 → false (not in BOT_COMMANDS at all, even without digits)', () => {
    expect(isBotCommand('/status42')).toBe(false);
  });

  it('/new_test → false (underscore allowed by regex but "new_test" not in BOT_COMMANDS)', () => {
    // Regex /^\/([a-zA-Z_][a-zA-Z0-9_]*)/ matches "new_test". Not in set → false.
    expect(isBotCommand('/new_test')).toBe(false);
  });

  it('/new → true (regression: existing /new still works after digit fix)', () => {
    expect(isBotCommand('/new')).toBe(true);
  });

  it('/list → true (regression: existing /list still works)', () => {
    expect(isBotCommand('/list')).toBe(true);
  });
});


describe('isBotCommand — unicode in command position', () => {
  // [a-zA-Z_]+ is ASCII-only. Non-ASCII chars either stop the match (leaving a short
  // prefix that won't be in BOT_COMMANDS) or prevent a match entirely.
  it('/néw → false (accent stops regex after "n", "n" not in BOT_COMMANDS)', () => {
    expect(isBotCommand('/néw')).toBe(false);
  });

  it('/新しい → false (first char after / is non-ASCII, regex has no match)', () => {
    expect(isBotCommand('/新しい')).toBe(false);
  });
});
