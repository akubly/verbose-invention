/**
 * TeamsChannel.splitMessage — chunk-length invariant regression tests.
 *
 * Every returned chunk must satisfy chunk.length <= maxMessageLength (28 000).
 * These tests focus specifically on the footer edge cases identified in
 * PR #12 Copilot review Thread 2.
 */

import { describe, it, expect } from 'vitest';
import { TeamsChannel } from '../../../src/channel/teams/index.js';

const MAX = 28_000;

/** Returns a TeamsChannel whose maxMessageLength can be overridden for tests. */
function makeChannel(maxOverride?: number): TeamsChannel {
  const ch = new TeamsChannel();
  if (maxOverride !== undefined) {
    (ch.capabilities as { maxMessageLength: number }).maxMessageLength = maxOverride;
  }
  return ch;
}

/** Asserts every chunk in `chunks` is <= the given limit. */
function assertInvariant(chunks: string[], max: number): void {
  for (const [i, chunk] of chunks.entries()) {
    expect(chunk.length, `chunk[${i}].length (${chunk.length}) > max (${max})`).toBeLessThanOrEqual(max);
  }
}

describe('TeamsChannel.splitMessage — chunk-length invariant', () => {
  it('common case: short message with footer fits in one chunk (unchanged)', () => {
    const ch = makeChannel();
    const chunks = ch.splitMessage('hello', 'footer');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('hello\n\nfooter');
    assertInvariant(chunks, MAX);
  });

  it('no-footer path: every chunk <= maxMessageLength', () => {
    const ch = makeChannel(10);
    const chunks = ch.splitMessage('abcdefghijklmnopqrst');
    assertInvariant(chunks, 10);
    expect(chunks.join('')).toBe('abcdefghijklmnopqrst');
  });

  it('footer fits alongside last body chunk: body splits and footer is appended to last chunk', () => {
    // max = 20, separator = '\n\n' (2), footer = 'F'.repeat(16) = 16 chars
    // footerReserve = 18 < 20 → footer-FITS path (not split to its own chunk)
    // bodyCapacity = 20 - 18 = 2, body = 'X'.repeat(5) → body chunks: 'XX','XX','X'
    // last chunk appends footer: 'X' + '\n\nFFFFFFFFFFFFFFFF' = 19 chars ≤ 20 ✓
    const max = 20;
    const footer = 'F'.repeat(16);  // footerReserve = 18 < 20 → fits
    const body = 'X'.repeat(5);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    // Footer must be APPENDED to the last body chunk, not placed on its own chunk
    expect(chunks[chunks.length - 1]).toContain(footer);
    expect(chunks[chunks.length - 1]).toContain('\n\n');
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('footer at boundary (footerReserve === max − 1): still fits, appended to fill last chunk exactly', () => {
    // max = 20, separator = '\n\n' (2), footer = 'F'.repeat(17) = 17 chars
    // footerReserve = 19 < 20 → still the footer-fits path; last chunk = bodyCapacity 1 + 19 = 20 ≤ 20 ✓
    // (The threshold for own-chunk is footerReserve >= max, i.e. footer.length >= max − 2)
    const max = 20;
    const footer = 'F'.repeat(17);  // footerReserve = 19 < 20 → fits (last chunk = 20 chars exactly)
    const body = 'X'.repeat(5);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    expect(chunks[chunks.length - 1]).toContain(footer);
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('footer exactly equal to maxMessageLength: footer goes on its own chunk', () => {
    // max = 10, separator = 2, footer = 10 chars → footerReserve = 12 >= 10
    const max = 10;
    const footer = 'F'.repeat(max);  // footerReserve = 12 >= 10
    const body = 'B'.repeat(25);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('footer longer than maxMessageLength: footer is split across multiple chunks', () => {
    // max = 10, footer = 'F'.repeat(30) → footerReserve = 32 >= 10
    // footer block = '\n\n' + 'F'.repeat(30) = 32 chars → 4 chunks of 10,10,10,2
    const max = 10;
    const footer = 'F'.repeat(30);
    const body = 'B'.repeat(15);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('footer just barely does not fit (footerReserve === max): footer on own chunk', () => {
    // max = 10, separator = 2, footer = 8 → footerReserve = 10 >= 10
    const max = 10;
    const footer = 'F'.repeat(8);  // footerReserve = 10 === max
    const body = 'B'.repeat(25);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('footer one char larger than max: footer is split', () => {
    const max = 10;
    const footer = 'F'.repeat(max + 1);  // footerReserve = 13 >= 10
    const body = 'B'.repeat(5);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    assertInvariant(chunks, max);
    expect(chunks.join('')).toBe(body + '\n\n' + footer);
  });

  it('no-split case: combined length equals max exactly — single chunk returned', () => {
    const max = 20;
    const separator = '\n\n';
    const footer = 'F'.repeat(5);
    // body length = 20 - 2 - 5 = 13
    const body = 'B'.repeat(max - separator.length - footer.length);
    const ch = makeChannel(max);
    const chunks = ch.splitMessage(body, footer);
    expect(chunks).toHaveLength(1);
    assertInvariant(chunks, max);
  });
});
