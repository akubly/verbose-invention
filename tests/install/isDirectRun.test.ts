/**
 * Tests for src/install/isDirectRun.ts
 *
 * Contract under test:
 *   - Absolute argv[1] matching the module file → true
 *   - Relative argv[1] that resolves to the module file → true  (npm script case)
 *   - Different file in argv[1] → false
 *   - Empty / missing argv[1] → false
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDirectRun } from '../../src/install/isDirectRun.js';

const MODULE_URL  = import.meta.url;
const MODULE_FILE = fileURLToPath(MODULE_URL);

describe('isDirectRun()', () => {
  let savedArgv1: string | undefined;

  beforeEach(() => {
    savedArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (savedArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = savedArgv1;
    }
  });

  // ── IDR1: Absolute path that matches ─────────────────────────────────────

  it('IDR1 absolute match: returns true when argv[1] is the absolute module path', () => {
    process.argv[1] = MODULE_FILE;
    expect(isDirectRun(MODULE_URL)).toBe(true);
  });

  // ── IDR2: Relative path that resolves to the module ───────────────────────

  it('IDR2 relative path: returns true when argv[1] is a relative path to the same file', () => {
    const relPath = path.relative(process.cwd(), MODULE_FILE);
    process.argv[1] = relPath;
    expect(isDirectRun(MODULE_URL)).toBe(true);
  });

  // ── IDR3: Different file ──────────────────────────────────────────────────

  it('IDR3 different file: returns false when argv[1] points to a different file', () => {
    process.argv[1] = path.join(path.dirname(MODULE_FILE), 'other-script.js');
    expect(isDirectRun(MODULE_URL)).toBe(false);
  });

  // ── IDR4: Empty / missing argv[1] ────────────────────────────────────────

  it('IDR4 empty argv[1]: returns false when argv[1] is empty', () => {
    process.argv[1] = '';
    expect(isDirectRun(MODULE_URL)).toBe(false);
  });

  // ── IDR5: Missing argv[1] (length 1) ─────────────────────────────────────

  it('IDR5 missing argv[1]: returns false when argv has only one element', () => {
    process.argv.splice(1);
    expect(isDirectRun(MODULE_URL)).toBe(false);
  });
});
