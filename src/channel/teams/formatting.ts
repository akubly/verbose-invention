/**
 * Teams HTML formatting module.
 *
 * Converts the markdown subset produced by assistant output into
 * Teams-compatible HTML for use in channel messages (contentType: 'html').
 *
 * Targeted Teams HTML subset:
 *   <b>, <i>, <code>, <pre><code>, <a href="...">, <br>, <ul>/<li>, <ol>/<li>
 *
 * No Microsoft Graph / SDK dependencies — pure string transformation.
 */

/** Supported block types from the block parser. */
type Block =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'blank' };

/** Escape HTML special characters for element body text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape HTML special characters for double-quoted attribute values. */
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Returns true if ch is an alphanumeric character or underscore (word character). */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

/**
 * Returns true if the URL scheme is in the safe allowlist: http, https, mailto, tel.
 *
 * Robust against bypass attempts:
 *   - Leading whitespace / control chars: trimStart() before scheme extraction
 *   - Mixed case: tested case-insensitively
 *   - Embedded non-letter chars in scheme (e.g. "java\x00script:"): won't match allowlist
 */
function isSafeUrl(url: string): boolean {
  // trimStart strips leading whitespace (handles " javascript:" bypass)
  const trimmed = url.trimStart();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return false;
  // Any non-letter character embedded in the scheme (e.g. control chars) will
  // prevent a match, so no extra stripping is needed.
  const scheme = trimmed.slice(0, colonIdx);
  return /^(https?|mailto|tel)$/i.test(scheme);
}

/**
 * Apply inline markdown formatting to a plain-text segment.
 *
 * Processes (in precedence order): inline code, bold (** or __), italic (* or _),
 * links, and HTML-escapes all remaining plain-text characters.
 *
 * Called recursively for nested formatting content.
 */
function processInline(text: string): string {
  let result = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!; // safe: i < text.length

    // Inline code: `...`  — no further processing inside
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        result += `<code>${escapeHtml(text.slice(i + 1, close))}</code>`;
        i = close + 1;
        continue;
      }
    }

    if (ch === '*') {
      const next = text[i + 1]; // string | undefined
      if (next === '*') {
        // Bold: **text**
        const close = text.indexOf('**', i + 2);
        if (close !== -1) {
          result += `<b>${processInline(text.slice(i + 2, close))}</b>`;
          i = close + 2;
          continue;
        }
      } else {
        // Italic: *text* — only when not intra-word (e.g. a*b*c stays literal)
        const close = text.indexOf('*', i + 1);
        if (close !== -1) {
          const before = i > 0 ? text[i - 1] : undefined;
          const after = text[close + 1];
          if (!isWordChar(before) && !isWordChar(after)) {
            result += `<i>${processInline(text.slice(i + 1, close))}</i>`;
            i = close + 1;
            continue;
          }
        }
      }
    }

    if (ch === '_') {
      const next = text[i + 1]; // string | undefined
      if (next === '_') {
        // Bold: __text__
        const close = text.indexOf('__', i + 2);
        if (close !== -1) {
          result += `<b>${processInline(text.slice(i + 2, close))}</b>`;
          i = close + 2;
          continue;
        }
      } else {
        // Italic: _text_ — only when not intra-word (e.g. snake_case stays literal)
        const close = text.indexOf('_', i + 1);
        if (close !== -1) {
          const before = i > 0 ? text[i - 1] : undefined;
          const after = text[close + 1];
          if (!isWordChar(before) && !isWordChar(after)) {
            result += `<i>${processInline(text.slice(i + 1, close))}</i>`;
            i = close + 1;
            continue;
          }
        }
      }
    }

    // Link: [text](url)
    if (ch === '[') {
      const textEnd = text.indexOf(']', i + 1);
      if (textEnd !== -1 && text[textEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', textEnd + 2);
        if (urlEnd !== -1) {
          const rawUrl = text.slice(textEnd + 2, urlEnd);
          const linkText = processInline(text.slice(i + 1, textEnd));
          if (isSafeUrl(rawUrl)) {
            result += `<a href="${escapeHtmlAttr(rawUrl)}">${linkText}</a>`;
          } else {
            // Disallowed scheme (e.g. javascript:, data:, vbscript:) — render text only
            result += linkText;
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // HTML special characters in plain text
    if (ch === '&') { result += '&amp;'; i++; continue; }
    if (ch === '<') { result += '&lt;'; i++; continue; }
    if (ch === '>') { result += '&gt;'; i++; continue; }

    result += ch;
    i++;
  }

  return result;
}

/** Matches an unordered list line: "- content" or "* content" */
const UL_LINE_RE = /^[-*] (.*)$/;

/** Matches an ordered list line: "1. content", "2. content", etc. */
const OL_LINE_RE = /^\d+\. (.*)$/;

/**
 * Parse a plain-text segment (code fences already removed) into typed blocks.
 * Groups consecutive list lines into ul/ol blocks; blank lines and paragraphs
 * are preserved separately.
 */
function buildBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let paraLines: string[] = [];

  function flushParagraph(): void {
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', lines: [...paraLines] });
      paraLines = [];
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      flushParagraph();
      blocks.push({ type: 'blank' });
      i++;
      continue;
    }

    const ulMatch = UL_LINE_RE.exec(line);
    if (ulMatch !== null) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const m = UL_LINE_RE.exec(itemLine);
        if (m === null) break;
        items.push(m[1] ?? '');
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    const olMatch = OL_LINE_RE.exec(line);
    if (olMatch !== null) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const m = OL_LINE_RE.exec(itemLine);
        if (m === null) break;
        items.push(m[1] ?? '');
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    paraLines.push(line);
    i++;
  }

  flushParagraph();
  return blocks;
}

/** Render a list of blocks to HTML. */
function renderBlocks(blocks: Block[]): string {
  // Strip leading/trailing blank blocks to avoid spurious line breaks at segment edges.
  let start = 0;
  let end = blocks.length;
  while (start < end && blocks[start]?.type === 'blank') start++;
  while (end > start && blocks[end - 1]?.type === 'blank') end--;
  const trimmed = blocks.slice(start, end);

  return trimmed
    .map((block, idx, arr): string => {
      const isLast = idx === arr.length - 1;
      switch (block.type) {
        case 'paragraph':
          // Append <br> after a paragraph unless it is the last block, so that
          // a blank block immediately after (also <br>) produces the expected
          // double line-break paragraph separator.
          return block.lines.map(processInline).join('<br>') + (isLast ? '' : '<br>');
        case 'ul':
          return `<ul>${block.items.map((item) => `<li>${processInline(item)}</li>`).join('')}</ul>`;
        case 'ol':
          return `<ol>${block.items.map((item) => `<li>${processInline(item)}</li>`).join('')}</ol>`;
        case 'blank':
          return '<br>';
      }
    })
    .join('');
}

// Matches fenced code blocks: ```[lang]\ncontent\n```
// Lazy [\s\S]*? stops at the first closing ```.
const CODE_FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * Convert a markdown string to Teams-compatible HTML.
 *
 * Markdown → HTML mapping:
 * - `**text**` or `__text__`       → `<b>text</b>`
 * - `*text*` or `_text_`           → `<i>text</i>`
 * - `` `code` ``                   → `<code>code</code>`
 * - ```` ```[lang]\ncode\n``` ````  → `<pre><code>code</code></pre>`
 * - `[text](url)`                  → `<a href="url">text</a>`
 * - `- item` / `* item`            → `<ul><li>item</li></ul>`
 * - `1. item` (ordered)            → `<ol><li>item</li></ol>`
 * - Plain-text newlines            → `<br>` (within a paragraph)
 * - Blank lines                    → `<br>` (paragraph separator)
 *
 * HTML-escaping:
 * - Plain text: `&`, `<`, `>` → named entities
 * - Code content: `&`, `<`, `>` → named entities (content otherwise verbatim)
 * - Link URLs: `&`, `<`, `>`, `"` → named entities
 *
 * @param markdown - Raw markdown string as produced by assistant output.
 * @returns Teams-compatible HTML, ready for `body.content` with `body.contentType = 'html'`.
 */
export function formatForTransport(markdown: string): string {
  if (markdown.length === 0) return '';

  // Normalise CRLF / CR to LF for consistent processing on all platforms.
  const text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const parts: string[] = [];
  CODE_FENCE_RE.lastIndex = 0; // reset stateful global regex
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderBlocks(buildBlocks(text.slice(lastIndex, match.index))));
    }

    // Strip the trailing newline before the closing ``` (part of the fence syntax).
    const code = (match[2] ?? '').replace(/\n$/, '');
    parts.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(renderBlocks(buildBlocks(text.slice(lastIndex))));
  }

  return parts.join('');
}
