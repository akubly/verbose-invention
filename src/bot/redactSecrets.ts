/**
 * Secret redaction for Telegram-facing text.
 *
 * Applied daemon-side in formatOrientationMessage before any excerpt reaches
 * Telegram. The extension stays a pure cache; this module owns all
 * Telegram-facing sanitization concerns (symmetric with N2 guard location).
 *
 * Conservative bias: false positives (over-redaction) are acceptable.
 * False negatives (real secret leaks) are not.
 *
 * Pattern order matters — most specific first:
 *   1. Keyword-adjacent tokens  (token=, key:, Authorization: Bearer …)
 *   2. ENV-style assignments    (GITHUB_TOKEN=, AWS_ACCESS_KEY_ID=,
 *                                AWS_SECRET_ACCESS_KEY=, ACCESS_KEY(_ID)? vars)
 *   3. High-entropy bare strings (39+ base64/base62 chars including / and +,
 *                                 not preceded by <)
 *   4. URLs with embedded credentials (user:pass@host)
 */

/**
 * Matches common secret keywords followed by an optional separator and a
 * 16+-character value. Groups: (keyword)(separator)(value)(closeQuote).
 * The closeQuote group captures the optional trailing quote so it can be
 * re-emitted after [REDACTED], preventing broken JSON/YAML output like
 * `token="[REDACTED]` (missing close quote).
 */
const KEYWORD_PATTERN =
  /\b(token|key|secret|password|authorization|bearer|api[_-]?key|access[_-]?token)\b(\s*[:=]?\s*['"]?)([A-Za-z0-9_\-.+/=]{16,})(["']?)/gi;

/** Matches env-style secret assignments (e.g. TELEGRAM_BOT_TOKEN=..., GITHUB_TOKEN=..., AWS_ACCESS_KEY_ID=..., AWS_SECRET_ACCESS_KEY=...). */
const ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?TOKEN|ACCESS_KEY(?:_ID)?))\b(\s*=\s*['"]?)([^\s'"]{8,})(["']?)/g;

/**
 * Matches bare high-entropy strings (39+ base64/base62 characters including `/` and `+`).
 * Negative lookbehind `(?<!<)` skips values already inside angle-bracket
 * delimiters (e.g. XML/HTML elements or code-block markers).
 */
const HIGH_ENTROPY_PATTERN = /(?<!<)[A-Za-z0-9_\-/+]{39,}/g;

/**
 * Matches URLs with embedded credentials (https://user:pass@host/…).
 * Captures the protocol prefix so it can be preserved in the replacement.
 */
const URL_CREDS_PATTERN = /(https?:\/\/)[^:@\s]+:[^@\s]+@/g;

/**
 * Redacts common secret patterns from `text`.
 *
 * Exported so Jun can write unit tests against the pattern list.
 */
export function redactSecrets(text: string): string {
  // Pass 1 — keyword-adjacent: preserve keyword + separator + close quote, replace value only.
  let result = text.replace(
    KEYWORD_PATTERN,
    (_match, keyword: string, sep: string, _value: string, closeQuote: string) =>
      `${keyword}${sep}[REDACTED]${closeQuote}`,
  );

  // Pass 2 — env-style assignments.
  result = result.replace(
    ENV_ASSIGNMENT_PATTERN,
    (_match, key: string, sep: string, _value: string, closeQuote: string) =>
      `${key}${sep}[REDACTED]${closeQuote}`,
  );

  // Pass 3 — high-entropy bare strings not already redacted by pass 1/2.
  result = result.replace(HIGH_ENTROPY_PATTERN, '[REDACTED]');

  // Pass 4 — URLs with embedded credentials.
  result = result.replace(URL_CREDS_PATTERN, '$1[REDACTED]@');

  return result;
}
