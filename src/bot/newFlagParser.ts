export interface ParsedNewFlags {
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
        if (quote === '"' && current === '\\') {
          const next = input[i + 1];
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
        }
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

export function parseNewFlags(match: string): ParsedNewFlags {
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

  return {
    sessionName,
    ...(model !== undefined && { model }),
    ...(cwd !== undefined && { cwd }),
  };
}
