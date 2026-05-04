/**
 * MarkdownV2 escaping for Telegram.
 *
 * Strategy: escape-only, no AST parsing.
 * - Identifies code spans (`...`) and code blocks (```...```) and protects
 *   them from plain-text escaping; inside code regions only `\` and `` ` ``
 *   are escaped (Telegram requirement).
 * - Escapes all 18 MarkdownV2 special chars plus `\` in plain-text regions.
 * - Handles unclosed fences defensively: treats trailing unclosed code as
 *   plain text and escapes it.
 *
 * Special chars escaped outside code:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !  (plus \)
 */

export function escapeMarkdownV2(text: string): string {
  let result = '';
  let i = 0;

  while (i < text.length) {
    const nextTick = text.indexOf('`', i);

    if (nextTick === -1) {
      result += escapePlain(text.slice(i));
      break;
    }

    result += escapePlain(text.slice(i, nextTick));
    i = nextTick;

    if (text.startsWith('```', i)) {
      const closeAt = text.indexOf('```', i + 3);
      if (closeAt !== -1) {
        const inner = text.slice(i + 3, closeAt);
        result += '```' + escapeCode(inner) + '```';
        i = closeAt + 3;
      } else {
        result += escapePlain(text.slice(i));
        break;
      }
    } else {
      const closeAt = text.indexOf('`', i + 1);
      if (closeAt !== -1) {
        const inner = text.slice(i + 1, closeAt);
        result += '`' + escapeCode(inner) + '`';
        i = closeAt + 1;
      } else {
        result += escapePlain(text.slice(i));
        break;
      }
    }
  }

  // F12: Defensive check — odd number of triple-backtick fences means unbalanced
  // code blocks that Telegram would reject. Fall back to plain text immediately.
  const fenceCount = (result.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) {
    return escapePlain(text);
  }

  return result;
}

/** Utility for callers that want to skip escaping overhead on clean text. Currently used in tests only.
 * Returns true if the string contains characters that need MarkdownV2 escaping. */
export function needsEscaping(text: string): boolean {
  return /[_*[\]()~`>#+=\-|{}.!\\]/.test(text);
}

function escapePlain(s: string): string {
  return s.replace(/[_*[\]()~`>#+=\-|{}.!\\]/g, '\\$&');
}

function escapeCode(s: string): string {
  return s.replace(/[\\`]/g, '\\$&');
}
