/**
 * Splits a Telegram message into ≤maxLen-char chunks with smart boundary
 * detection and optional chunk numbering + HUD footer.
 *
 * Boundary preference: paragraph (\n\n) > line (\n) > word (\s) > hard cut.
 * Code blocks (```lang...```) are never split mid-block; when a block spans a
 * chunk boundary it is closed with ``` on the current chunk and reopened with
 * ```lang on the next. If a block is larger than maxLen it is split at line
 * boundaries with balanced fences on each sub-chunk.
 */
export interface SplitOptions {
  /** Maximum characters per chunk. Defaults to 4096. */
  maxLen?: number;
  /** When true, prepends [n/total]\n to each chunk (only when total > 1). */
  numbering?: boolean;
  /** HUD string appended (with \n\n separator) to the last chunk only. */
  footer?: string;
  /**
   * Hard cap on the effective chunk size before post-split transformations
   * (e.g. MarkdownV2 escape expansion). Overrides maxLen as the working budget.
   * Use when the caller knows the desired ceiling directly (e.g. 2048 for a
   * worst-case 2× escape ratio against Telegram's 4096-char limit).
   */
  effectiveMaxLen?: number;
  /**
   * Maximum number of chunks to deliver. When the natural split produces more
   * chunks than this limit, the array is truncated to maxChunks-1 natural chunks
   * and a truncation marker is appended as the final chunk — BEFORE numbering
   * and footer composition. This ensures all delivered chunks carry consistent
   * [n/maxChunks] totals and the truncation chunk receives the HUD footer.
   */
  maxChunks?: number;
}

interface CodeBlockInfo {
  /** Index of the opening ``` in the source text. */
  start: number;
  /** Index just past the closing ``` in the source text. */
  end: number;
  lang: string;
}

const DEFAULT_MAX_LEN = 4096;
const TRUNCATION_MARKER = '_(response truncated — too many chunks)_';
const MIN_TRUNCATION_MARKER = '_(truncated)_';

export function splitForTelegram(text: string, opts: SplitOptions = {}): string[] {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  // Use effectiveMaxLen directly when provided; otherwise fall back to maxLen.
  // effectiveMaxLen lets callers specify the desired working budget (e.g. 2048
  // for a worst-case 2× MarkdownV2 escape ratio) without computing a delta.
  const effectiveMax = opts.effectiveMaxLen ?? maxLen;
  const numbering = opts.numbering ?? false;
  const footer = opts.footer;
  const maxChunks = opts.maxChunks;
  const footerOverhead = footer != null ? footer.length + 2 : 0;

  // F1: Preliminary split (no prefix overhead) determines whether numbering is
  // needed. If total > 1 we must re-split with the [n/total]\n prefix reserved
  // so that numbered chunks never exceed maxLen.
  const prelimLastBudget = Math.max(1, effectiveMax - footerOverhead);
  const prelim = doSplit(text, effectiveMax, prelimLastBudget);

  let chunks: string[] = prelim;

  if (numbering && prelim.length > 1) {
    // Iteratively reserve prefix overhead. Converges within 3 iterations
    // because only digit-count changes (at 10, 100, 1000 chunks) require a
    // second pass, and each pass narrows estTotal monotonically.
    let estTotal = prelim.length;
    let prevPrefixLen = -1;
    for (let iter = 0; iter < 3; iter++) {
      const prefixLen = `[${estTotal}/${estTotal}]\n`.length; // worst-case for this total
      if (prefixLen === prevPrefixLen) break; // converged
      prevPrefixLen = prefixLen;
      const numberedMax = Math.max(1, effectiveMax - prefixLen);
      const numberedLastBudget = Math.max(1, numberedMax - footerOverhead);
      const candidate = doSplit(text, numberedMax, numberedLastBudget);
      chunks = candidate;
      if (candidate.length <= 1) break; // fits in one chunk with prefix reserved
      estTotal = candidate.length;
    }
  }

  // Apply maxChunks cap BEFORE footer and numbering composition so that:
  //  - all delivered chunks carry consistent [n/maxChunks] totals, and
  //  - the truncation marker (last chunk) receives the HUD footer.
  // The cap is safe to apply after the two-pass split because we are only
  // shrinking the array — capped prefix length ≤ natural prefix length,
  // so already-sized chunks still fit within effectiveMax.
  if (maxChunks != null && chunks.length > maxChunks) {
    // Budget the truncation marker to account for the numbering prefix and footer
    // that will be layered on top, so the final chunk never exceeds effectiveMax.
    const markerPrefixLen = numbering ? `[${maxChunks}/${maxChunks}]\n`.length : 0;
    const available = effectiveMax - markerPrefixLen - footerOverhead;
    let marker: string;
    if (available >= TRUNCATION_MARKER.length) {
      marker = TRUNCATION_MARKER;
    } else if (available >= MIN_TRUNCATION_MARKER.length) {
      marker = MIN_TRUNCATION_MARKER;
    } else {
      throw new Error(
        `maxLen too small to fit truncation marker with prefix and footer ` +
        `(available=${available}, min=${MIN_TRUNCATION_MARKER.length})`,
      );
    }
    chunks = [...chunks.slice(0, maxChunks - 1), marker];
  }

  if (footer != null) {
    chunks[chunks.length - 1] += `\n\n${footer}`;
  }

  if (numbering && chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((chunk, i) => `[${i + 1}/${total}]\n${chunk}`);
  }

  return chunks;
}

// ─── internal helpers ───────────────────────────────────────────────

function doSplit(text: string, maxLen: number, lastBudget: number): string[] {
  if (text.length === 0) return [''];

  const codeBlocks = parseCodeBlocks(text);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const remaining = text.slice(pos);

    if (remaining.length <= lastBudget) {
      chunks.push(remaining);
      break;
    }

    const windowEnd = pos + maxLen;

    // A code block that starts within the window but extends beyond it.
    const spanningBlock = codeBlocks.find(
      (b) => b.start >= pos && b.start < windowEnd && b.end > windowEnd,
    );

    if (spanningBlock) {
      const relStart = spanningBlock.start - pos;
      if (relStart > 0) {
        // Plain text precedes the block — split at best boundary before it.
        const { bodyEnd, skipLen } = findBestSplit(remaining, relStart);
        if (bodyEnd > 0) {
          chunks.push(remaining.slice(0, bodyEnd));
          pos += bodyEnd + skipLen;
          continue;
        }
      }
      // Block begins at (or immediately at) pos — split within the block.
      chunks.push(...splitCodeBlock(spanningBlock.lang, extractInner(text, spanningBlock), maxLen));
      pos = advancePast(text, spanningBlock.end);
      continue;
    }

    // Standard split.
    const upperBound = Math.max(1, Math.min(maxLen, remaining.length - 1));
    let { bodyEnd, skipLen } = findBestSplit(remaining, upperBound);

    // Ensure we don't split inside a code block that fits fully within the window.
    const absEnd = pos + bodyEnd;
    const enclosed = codeBlocks.find(
      (b) => b.start < absEnd && b.end > absEnd && b.start >= pos,
    );
    if (enclosed) {
      const relBlockStart = enclosed.start - pos;
      if (relBlockStart > 0) {
        const safe = findBestSplit(remaining, relBlockStart);
        bodyEnd = safe.bodyEnd > 0 ? safe.bodyEnd : relBlockStart;
        skipLen = safe.bodyEnd > 0 ? safe.skipLen : 0;
      } else {
        // Block starts at pos and fits in window — split it directly.
        chunks.push(...splitCodeBlock(enclosed.lang, extractInner(text, enclosed), maxLen));
        pos = advancePast(text, enclosed.end);
        continue;
      }
    }

    if (bodyEnd <= 0) {
      const take = Math.min(maxLen, remaining.length);
      chunks.push(remaining.slice(0, take));
      pos += take;
      continue;
    }

    chunks.push(remaining.slice(0, bodyEnd));
    pos += bodyEnd + skipLen;
  }

  const nonEmpty = chunks.filter((c) => c.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [''];
}

function parseCodeBlocks(text: string): CodeBlockInfo[] {
  const blocks: CodeBlockInfo[] = [];
  let pos = 0;
  while (pos < text.length) {
    const openAt = text.indexOf('```', pos);
    if (openAt === -1) break;
    const nlAt = text.indexOf('\n', openAt + 3);
    if (nlAt === -1) { pos = openAt + 3; break; }
    const lang = text.slice(openAt + 3, nlAt).trim();
    const closeAt = text.indexOf('```', nlAt + 1);
    if (closeAt === -1) { pos = openAt + 3; break; }
    blocks.push({ start: openAt, end: closeAt + 3, lang });
    pos = closeAt + 3;
  }
  return blocks;
}

function extractInner(text: string, block: CodeBlockInfo): string[] {
  const lines = text.slice(block.start, block.end).split('\n');
  const lastLine = lines[lines.length - 1];
  const lastIdx = lastLine != null && lastLine.trimEnd() === '```' ? lines.length - 1 : lines.length;
  return lines.slice(1, lastIdx);
}

function advancePast(_text: string, blockEnd: number): number {
  return blockEnd;
}

function findBestSplit(text: string, maxBudget: number): { bodyEnd: number; skipLen: number } {
  if (text.length <= maxBudget) return { bodyEnd: text.length, skipLen: 0 };

  const pp = text.lastIndexOf('\n\n', maxBudget - 1);
  if (pp > 0) return { bodyEnd: pp, skipLen: 2 };

  const pl = text.lastIndexOf('\n', maxBudget - 1);
  if (pl > 0) return { bodyEnd: pl, skipLen: 1 };

  const limit = Math.min(maxBudget - 1, text.length - 1);
  for (let i = limit; i > 0; i--) {
    if (text[i] === ' ' || text[i] === '\t') return { bodyEnd: i, skipLen: 1 };
  }

  return { bodyEnd: Math.min(maxBudget, text.length), skipLen: 0 };
}

function splitCodeBlock(lang: string, innerLines: string[], maxLen: number): string[] {
  const open = `\`\`\`${lang}`;
  const close = '```';
  // Chunk layout: open + "\n" + lines.join("\n") + "\n" + close
  const overhead = open.length + close.length + 2;
  // F11: maximum chars a single line may occupy (one-line group = overhead + line.length)
  const lineCapacity = Math.max(1, maxLen - overhead);
  const result: string[] = [];
  let group: string[] = [];
  let groupLen = 0; // equals group.join('\n').length

  for (const rawLine of innerLines) {
    // F11: hard-cut overlong lines so a single line never exceeds chunk budget.
    const lineSegments: string[] = rawLine.length > lineCapacity
      ? Array.from({ length: Math.ceil(rawLine.length / lineCapacity) },
          (_, k) => rawLine.slice(k * lineCapacity, (k + 1) * lineCapacity))
      : [rawLine];

    for (const line of lineSegments) {
      const addLen = group.length === 0 ? line.length : 1 + line.length;
      if (group.length > 0 && groupLen + addLen + overhead > maxLen) {
        result.push(`${open}\n${group.join('\n')}\n${close}`);
        group = [];
        groupLen = 0;
      }
      group.push(line);
      groupLen += group.length === 1 ? line.length : 1 + line.length;
    }
  }

  if (group.length > 0 || result.length === 0) {
    result.push(`${open}\n${group.join('\n')}\n${close}`);
  }

  return result;
}
