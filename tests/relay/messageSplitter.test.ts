import { describe, it, expect } from 'vitest';
import { splitForTelegram } from '../../src/relay/messageSplitter.js';

// ─── contract: splitForTelegram(text, opts?) ───────────────────────────────────
//
// Splits a string into ≤maxLen-char chunks for Telegram delivery.
//
// Boundary preference: paragraph (\n\n) > line (\n) > word (\s) > hard cut
// Code blocks:  never split mid-block; close (```) and reopen (```lang) across boundary
// Numbering:    [n/total]\n prefix per chunk — only when total > 1
// Footer:       appended with \n\n to LAST chunk only; steals room from last chunk

describe('splitForTelegram', () => {

  // ── single-chunk cases ─────────────────────────────────────────────────────

  it('returns a single-element array for text shorter than maxLen', () => {
    const result = splitForTelegram('Hello, world!');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Hello, world!');
  });

  it('uses 4096 as default maxLen', () => {
    const text = 'a'.repeat(4095);
    const result = splitForTelegram(text);
    expect(result).toHaveLength(1);
  });

  it('splits when text exceeds default maxLen (4096)', () => {
    const text = 'a'.repeat(4097);
    const result = splitForTelegram(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it('empty string returns a single empty-string chunk', () => {
    const result = splitForTelegram('');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('');
  });

  // ── numbering: only active when total > 1 ─────────────────────────────────

  it('does NOT add numbering marker when text fits in one chunk', () => {
    const result = splitForTelegram('Short text', { numbering: true });
    expect(result).toHaveLength(1);
    // No [1/1] prefix — numbering only kicks in when total > 1
    expect(result[0]).not.toMatch(/^\[\d+\/\d+\]/);
    expect(result[0]).toBe('Short text');
  });

  it('prepends [n/total] markers when text splits into multiple chunks', () => {
    // 3 paragraphs each >40 chars; maxLen=60 forces splits
    const p1 = 'First paragraph with enough content to fill the slot.';   // 54 chars
    const p2 = 'Second paragraph with enough content to fill the slot.';  // 55 chars
    const p3 = 'Third paragraph with enough content to fill the slot.';   // 54 chars
    const text = `${p1}\n\n${p2}\n\n${p3}`;

    const result = splitForTelegram(text, { maxLen: 80, numbering: true });

    expect(result.length).toBeGreaterThan(1);

    const total = result.length;
    result.forEach((chunk, idx) => {
      expect(chunk, `chunk ${idx}`).toMatch(new RegExp(`^\\[${idx + 1}/${total}\\]`));
    });
  });

  it('numbering uses two-pass: total is accurate even if chunk count changes prefix length', () => {
    // Build text that creates exactly 3 chunks so [n/3] is the correct total
    const para = (n: number) => `Paragraph ${n} has some content here for testing.`;
    const text = [para(1), para(2), para(3)].join('\n\n');

    const result = splitForTelegram(text, { maxLen: 70, numbering: true });

    if (result.length === 3) {
      expect(result[0]).toMatch(/^\[1\/3\]/);
      expect(result[1]).toMatch(/^\[2\/3\]/);
      expect(result[2]).toMatch(/^\[3\/3\]/);
    } else {
      // If text fits differently, just verify [n/total] format is consistent
      const total = result.length;
      result.forEach((chunk, idx) => {
        expect(chunk).toMatch(new RegExp(`^\\[${idx + 1}/${total}\\]`));
      });
    }
  });

  // ── footer ────────────────────────────────────────────────────────────────

  it('appends footer to last chunk when text is short', () => {
    const result = splitForTelegram('Hello', { footer: '📎 session · model' });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('📎 session · model');
  });

  it('footer is appended only to the last chunk, not intermediate ones', () => {
    const p1 = 'First paragraph with enough text to be its own chunk here.';  // 59 chars
    const p2 = 'Second paragraph with enough text to be its own chunk here.'; // 60 chars
    const text = `${p1}\n\n${p2}`;

    const result = splitForTelegram(text, { maxLen: 80, footer: 'FOOTER' });

    expect(result.length).toBeGreaterThan(1);
    expect(result[result.length - 1]).toContain('FOOTER');
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]).not.toContain('FOOTER');
    }
  });

  it('footer is separated from last chunk content with a blank line', () => {
    const result = splitForTelegram('Content', { footer: 'HUD_FOOTER' });
    expect(result[0]).toBe('Content\n\nHUD_FOOTER');
  });

  it('footer steals room so last chunk does not exceed maxLen', () => {
    const footer = 'FOOTER_TEXT';  // 11 chars
    // Build text that would barely fit in one 60-char chunk WITHOUT footer,
    // but overflows WITH footer appended (\n\n = 2 extra chars → total 13 overhead)
    const p1 = 'Para one with some content.';  // 27 chars
    const p2 = 'Para two with more content.';  // 27 chars
    const text = `${p1}\n\n${p2}`;             // 27 + 2 + 27 = 56 chars

    // maxLen = 60: without footer, text (56 chars) fits in one chunk
    // with footer: 56 + 2 + 11 = 69 > 60 → must split
    const result = splitForTelegram(text, { maxLen: 60, footer });

    // Every chunk including the last (with footer) must be ≤ maxLen
    for (const chunk of result) {
      expect(chunk.length, `chunk length: ${chunk.length}`).toBeLessThanOrEqual(60);
    }
    // Footer must be present on last chunk
    expect(result[result.length - 1]).toContain(footer);
  });

  // ── boundary preference ────────────────────────────────────────────────────

  it('prefers paragraph boundaries (\n\n) over line boundaries', () => {
    const p1 = 'line A\nline B';   // 13 chars — two lines in one paragraph
    const p2 = 'line C\nline D';   // 13 chars
    const text = `${p1}\n\n${p2}`; // 30 chars

    // maxLen=20: forces a split; paragraph boundary is at pos 13
    const result = splitForTelegram(text, { maxLen: 20 });

    expect(result.length).toBeGreaterThan(1);
    // First chunk should contain both lines of p1 together (paragraph respected)
    expect(result[0]).toContain('line A');
    expect(result[0]).toContain('line B');
    // Second chunk should start with the second paragraph
    expect(result[result.length - 1]).toContain('line C');
  });

  it('falls back to line boundary when no paragraph boundary fits', () => {
    // One paragraph with multiple lines — no \n\n available
    const text = 'line one\nline two\nline three\nline four';

    const result = splitForTelegram(text, { maxLen: 20 });

    expect(result.length).toBeGreaterThan(1);
    // Each chunk must not exceed maxLen
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
    // Chunks must not contain partial lines broken mid-word (line boundary respected)
    const joined = result.join('\n');
    expect(joined).toContain('line one');
    expect(joined).toContain('line two');
  });

  it('falls back to word boundary when no line boundary fits', () => {
    // Single very long line, no newlines
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';

    const result = splitForTelegram(text, { maxLen: 20 });

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
    // Rejoin should preserve all words
    const allWords = text.split(' ');
    const resultText = result.join(' ');
    for (const word of allWords) {
      expect(resultText).toContain(word);
    }
  });

  it('hard-cuts when no whitespace exists within maxLen window', () => {
    // Single word longer than maxLen
    const text = 'averylongwordwithnospacesatall';  // 30 chars

    const result = splitForTelegram(text, { maxLen: 10 });

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    // All characters preserved across chunks
    expect(result.join('')).toBe(text);
  });

  // ── code block integrity ───────────────────────────────────────────────────

  it('closes and reopens a code block with lang tag when it spans a chunk boundary', () => {
    const lang = 'python';
    const codeLines = Array.from({ length: 10 }, (_, i) => `result_${i} = compute(${i})`);
    const codeBlock = `\`\`\`${lang}\n${codeLines.join('\n')}\n\`\`\``;
    // "intro\n\n" + codeBlock will exceed 80 chars
    const text = `intro text\n\n${codeBlock}`;

    const result = splitForTelegram(text, { maxLen: 80 });

    if (result.length === 1) {
      // Text happened to fit — no split needed, test is vacuous but not failing
      expect(result[0]).toContain('```python');
      return;
    }

    // Every chunk that contains code lines must be properly fenced
    for (const chunk of result) {
      if (chunk.includes('result_')) {
        // Chunk contains code content → must have opening and closing fence
        expect(chunk).toMatch(/^```python/m);
        expect(chunk.trimEnd()).toMatch(/```$/);
      }
    }

    // Consecutive chunks that carry the code block must reopen with the same lang tag
    const codeChunks = result.filter((c) => c.includes('result_'));
    for (const chunk of codeChunks) {
      expect(chunk).toMatch(new RegExp(`\`\`\`${lang}`));
    }
  });

  it('splits a code block larger than maxLen at line boundaries with fences on each sub-chunk', () => {
    // Code block alone exceeds maxLen — must split within it
    const lang = 'js';
    const lines = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`);
    const codeBlock = `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;

    const result = splitForTelegram(codeBlock, { maxLen: 80 });

    expect(result.length).toBeGreaterThan(1);

    for (const chunk of result) {
      // Every chunk in a code-only block must have balanced fences
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2, `unbalanced fences in chunk: ${JSON.stringify(chunk)}`).toBe(0);
      // All reopened chunks carry the lang tag
      if (chunk.startsWith('```')) {
        expect(chunk).toMatch(new RegExp(`\`\`\`${lang}`));
      }
    }
  });

  it('does not split a code block at a non-line boundary (no mid-word cuts inside code)', () => {
    // Code block with long single-line statements: must split at line boundaries
    const lang = 'ts';
    const longLine = 'const veryLongVariableName = someFunction(arg1, arg2, arg3, arg4);'; // 68 chars
    const lines = Array.from({ length: 5 }, () => longLine);
    const codeBlock = `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;

    const result = splitForTelegram(codeBlock, { maxLen: 120 });

    // If splitting was needed, splits should happen at \n not mid-line
    for (const chunk of result) {
      // Chunk should not end with a partial line (i.e., should not cut mid-variable-name)
      // Each chunk's code content should consist of complete lines
      const inner = chunk.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      const innerLines = inner.split('\n');
      for (const line of innerLines) {
        // Each line must be either empty or a complete statement
        if (line.trim()) {
          expect([longLine, '']).toContain(line);
        }
      }
    }
  });

  // ── all chunks non-empty and content preserved ────────────────────────────

  it('produces no empty chunks', () => {
    const text = 'Para A\n\nPara B\n\nPara C\n\nPara D';
    const result = splitForTelegram(text, { maxLen: 15 });
    for (const chunk of result) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it('preserves all content across chunks (plain text)', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} content.`);
    const text = paragraphs.join('\n\n');
    const result = splitForTelegram(text, { maxLen: 30 });
    const rejoined = result.join(' ');
    for (const para of paragraphs) {
      expect(rejoined).toContain(`Paragraph ${para.slice(10, 11)}`);
    }
  });

  // ── combined: numbering + footer ──────────────────────────────────────────

  it('numbering and footer coexist correctly on multi-chunk output', () => {
    const p1 = 'First part of the message with enough text.';  // 44 chars
    const p2 = 'Second part of the message with enough text.'; // 45 chars
    const text = `${p1}\n\n${p2}`;
    const footer = 'HUD';

    const result = splitForTelegram(text, { maxLen: 70, numbering: true, footer });

    expect(result.length).toBeGreaterThan(1);

    // First chunk: numbering prefix, NO footer
    expect(result[0]).toMatch(/^\[\d+\/\d+\]/);
    expect(result[0]).not.toContain(footer);

    // Last chunk: numbering prefix AND footer
    const last = result[result.length - 1];
    expect(last).toMatch(/^\[\d+\/\d+\]/);
    expect(last).toContain(footer);
  });
});
