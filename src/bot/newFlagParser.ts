/**
 * Quote-aware tokenizer for /new command arguments.
 *
 * Quote semantics:
 *   - Double-quoted ("…") and single-quoted ('…') values may contain spaces.
 *   - Quote chars are stripped from the result token.
 *   - Backslash is ALWAYS literal inside quoted strings — no escape sequences.
 *     This is intentional and required for Windows paths like
 *     `"C:\Users\Aaron Smith\repo"` and UNC paths like `"\\server\share"`.
 *   - An unmatched quote is an error (thrown).
 *
 * Whitespace handling:
 *   - Leading/trailing whitespace in the raw input is trimmed.
 *   - Unquoted tokens are delimited by whitespace.
 */

/**
 * Discriminated result type for the public parseNewFlags boundary.
 *
 * Internal helpers (tokenize, parseFlagValue) may throw — parseNewFlags catches
 * those throws and converts them to { ok: false, error }.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Success value shape returned by parseNewFlags. */
export interface ParsedNewFlagsValue {
  sessionName: string;
  model?: string;
  cwd?: string;
}

function tokenize(raw: string): string[] {
  const input = raw.trim();
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;

    const ch = input[i]!;
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      i++;
      let value = '';
      let closed = false;

      while (i < input.length) {
        const current = input[i]!;
        if (current === quote) {
          closed = true;
          i++;
          break;
        }
        value += current;
        i++;
      }

      if (!closed) {
        throw new Error('Unclosed quoted value in /new command');
      }
      tokens.push(value);
      continue;
    }

    let value = '';
    while (i < input.length && !/\s/.test(input[i]!)) {
      value += input[i]!;
      i++;
    }
    tokens.push(value);
  }

  return tokens;
}

/**
 * Extracts the value token for a named flag from the token list.
 *
 * Flag-as-value detection: if the next token starts with `--`, it is treated
 * as a flag, not a value, and an error is thrown.
 *
 * @throws {Error} If the flag value is missing or the next token looks like a flag.
 */
function parseFlagValue(
  tokens: string[],
  index: number,
  flagName: '--model' | '--cwd',
): { value: string; nextIndex: number } {
  const next = tokens[index + 1];
  if (!next) {
    if (flagName === '--model') {
      throw new Error('Missing model value for --model');
    }
    throw new Error(`Missing value for ${flagName}`);
  }
  if (next.startsWith('--')) {
    throw new Error(
      `Value for ${flagName} looks like a flag (${next}); did you mean to provide a value first?`,
    );
  }
  return { value: next, nextIndex: index + 1 };
}

/**
 * Parses the argument string following the /new command into structured flags.
 *
 * Supported flags:
 *   `--model <model>` — override the default Copilot model for this session
 *   `--cwd <alias-or-path>` — working directory alias or absolute path
 *
 * Returns `{ ok: false, error }` for all error conditions — including tokenizer
 * errors (unclosed quote), missing session name, unknown flags, flag-as-value
 * detection, multi-word session names, and missing flag values. Never throws.
 */
export function parseNewFlags(match: string): ParseResult<ParsedNewFlagsValue> {
  try {
    const tokens = tokenize(match);
    if (tokens.length === 0) {
      throw new Error('Missing session name');
    }

    const sessionParts: string[] = [];
    let model: string | undefined;
    let cwd: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === '--model') {
        const { value, nextIndex } = parseFlagValue(tokens, i, '--model');
        model = value;
        i = nextIndex;
        continue;
      }
      if (token === '--cwd') {
        const { value, nextIndex } = parseFlagValue(tokens, i, '--cwd');
        cwd = value;
        i = nextIndex;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(
          'Unknown flag. Usage: /new <session-name> [--model <model>] [--cwd <alias-or-path>]',
        );
      }
      sessionParts.push(token);
    }

    const sessionName = sessionParts.join(' ').trim();
    if (!sessionName) {
      throw new Error('Missing session name');
    }

    if (sessionParts.length > 1) {
      return {
        ok: false,
        error: 'Session name cannot contain spaces. Did you forget to quote a flag value?',
      };
    }

    return {
      ok: true,
      value: {
        sessionName,
        ...(model !== undefined && { model }),
        ...(cwd !== undefined && { cwd }),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
