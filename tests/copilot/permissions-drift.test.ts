/**
 * Drift detection: DESTRUCTIVE_TOOLS and SAFE_TOOLS in extension.mjs must
 * stay in sync with the canonical sets exported from src/copilot/permissions.ts.
 *
 * This test fails if either side adds or removes a tool without updating the
 * other. It is the enforcement mechanism for the "MUST be mirrored" comment in
 * extension.mjs (ADR-9 §5).
 *
 * Approach: parse extension.mjs as raw text (regex), compare to the TypeScript
 * exports. No shared module required — keeps extension.mjs as plain JS.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE_TOOLS, SAFE_TOOLS } from '../../src/copilot/permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionSource = readFileSync(path.resolve(__dirname, '../../extension.mjs'), 'utf8');

/**
 * Extract a `const NAME = new Set([...]);` block from source and return it as
 * a Set<string>. Handles single- and double-quoted string literals.
 */
function parseSetFromSource(source: string, setName: string): Set<string> {
  const blockRegex = new RegExp(
    `const\\s+${setName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
    'm',
  );
  const blockMatch = blockRegex.exec(source);
  if (!blockMatch || blockMatch[1] === undefined) {
    throw new Error(`permissions-drift: could not locate "${setName}" in extension.mjs`);
  }

  const items: string[] = [];
  const itemRegex = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(blockMatch[1])) !== null) {
    if (m[1]) items.push(m[1]);
  }
  return new Set(items);
}

const extDestructive = parseSetFromSource(extensionSource, 'DESTRUCTIVE_TOOLS');
const extSafe = parseSetFromSource(extensionSource, 'SAFE_TOOLS');

describe('extension.mjs ↔ permissions.ts tool-set drift detection', () => {
  it('DESTRUCTIVE_TOOLS in extension.mjs matches permissions.ts exactly', () => {
    expect(extDestructive).toEqual(DESTRUCTIVE_TOOLS);
  });

  it('SAFE_TOOLS in extension.mjs matches permissions.ts exactly', () => {
    expect(extSafe).toEqual(SAFE_TOOLS);
  });

  it('no tool name appears in both DESTRUCTIVE_TOOLS and SAFE_TOOLS', () => {
    const overlap = [...DESTRUCTIVE_TOOLS].filter((t) => SAFE_TOOLS.has(t));
    expect(overlap).toEqual([]);
  });
});
