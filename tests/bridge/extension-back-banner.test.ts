/**
 * Structural regression test for Bug #3 fix: deduplicate "🖥️ Back at desk" banner.
 *
 * APPROACH (I7 — option a failed, using source-analysis per extension-protocol-drift.test.ts):
 *   Option (a) — direct import — is not feasible: `handleBackConfirmed` and
 *   `handleModeChanged` are NOT exported by extension.mjs, and the file has
 *   top-level side effects (reads env vars, imports @github/copilot-sdk/extension).
 *   Option (b) — extracting to a separate importable module — would require modifying
 *   extension.mjs, which is outside this wave's file-ownership scope.
 *   Option (c) — subprocess integration test — adds complexity for a structural assertion.
 *
 *   Chosen: source-analysis (same pattern as extension-protocol-drift.test.ts).
 *   Parse extension.mjs with readFileSync, extract handleBackConfirmed and
 *   handleModeChanged bodies via brace-balancing, then assert structural properties.
 *
 * Post-fix contract verified structurally:
 *   - handleBackConfirmed  → calls showCliMessage unconditionally with '🖥️ Back at desk'
 *   - handleModeChanged(active=false) → showCliMessage NOT called at top level
 *   - handleModeChanged(active=true)  → showCliMessage called inside `if (msg.active === true)`
 *
 * This WILL catch a regression where someone modifies these handlers and breaks
 * the dedup contract (e.g., adds showCliMessage to the active=false branch,
 * or removes the unconditional call from handleBackConfirmed).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../..');
const extensionSource = readFileSync(path.resolve(repoRoot, 'extension.mjs'), 'utf8');

// ─── Source-analysis helpers ──────────────────────────────────────────────────

/**
 * Extracts the body (between the outer braces, exclusive) of a top-level
 * `function <name>(...)` declaration in `source`.
 * Uses a simple brace-balancing approach — works for non-nested function
 * declarations that don't contain string literals with unbalanced braces.
 * Returns the inner text (not including the surrounding `{` `}`), or null if
 * the function is not found.
 */
function extractFunctionBody(source: string, name: string): string | null {
  // Match "function handleXxx(...) {" at any indentation.
  const sig = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const sigMatch = sig.exec(source);
  if (!sigMatch) return null;

  let depth  = 1;
  let i      = sigMatch.index + sigMatch[0].length;
  const start = i;

  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }

  return depth === 0 ? source.slice(start, i - 1) : null;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('extension back-banner dedupe — structural contract (Bug #3)', () => {
  let backBody: string;
  let modeBody: string;

  beforeAll(() => {
    const b = extractFunctionBody(extensionSource, 'handleBackConfirmed');
    const m = extractFunctionBody(extensionSource, 'handleModeChanged');

    if (b === null) {
      throw new Error('Could not find handleBackConfirmed in extension.mjs');
    }
    if (m === null) {
      throw new Error('Could not find handleModeChanged in extension.mjs');
    }

    backBody = b;
    modeBody = m;
  });

  // ── handleBackConfirmed ───────────────────────────────────────────────────

  it('handleBackConfirmed contains showCliMessage call', () => {
    expect(backBody).toContain('showCliMessage');
  });

  it('handleBackConfirmed contains "🖥️ Back at desk" string literal', () => {
    expect(backBody).toContain('🖥️ Back at desk');
  });

  it('handleBackConfirmed calls showCliMessage UNCONDITIONALLY (not inside any if block)', () => {
    // Detect if the showCliMessage call is at the top level of the body:
    // strip any nested if/else blocks and check showCliMessage remains visible.
    // Simple heuristic: the showCliMessage call should appear before any `if (` in the body,
    // OR the body should contain no `if (` at all.
    const firstIfIndex   = backBody.indexOf('if (');
    const showCliIndex   = backBody.indexOf('showCliMessage');
    // Either no if-blocks at all, OR showCliMessage appears before the first if.
    const isUnconditional = firstIfIndex === -1 || showCliIndex < firstIfIndex;
    expect(isUnconditional).toBe(true);
  });

  // ── handleModeChanged ─────────────────────────────────────────────────────

  it('handleModeChanged contains showCliMessage call', () => {
    expect(modeBody).toContain('showCliMessage');
  });

  it('handleModeChanged contains "🛰️ AFK mode active" string literal', () => {
    expect(modeBody).toContain('🛰️ AFK mode active');
  });

  it('handleModeChanged does NOT contain "🖥️ Back at desk" (banner ownership is handleBackConfirmed)', () => {
    expect(modeBody).not.toContain('🖥️ Back at desk');
  });

  it('handleModeChanged guards showCliMessage inside msg.active === true check', () => {
    // The fix: showCliMessage only called when active is true.
    // Structural check: the body must contain `msg.active === true` (or equivalent),
    // and "🛰️ AFK mode active" must appear AFTER that guard.
    const guardIndex = modeBody.search(/msg\.active\s*===\s*true/);
    expect(guardIndex).toBeGreaterThanOrEqual(0);

    const afkBannerIndex = modeBody.indexOf('🛰️ AFK mode active');
    expect(afkBannerIndex).toBeGreaterThan(guardIndex);
  });

  it('handleModeChanged active=false path: no unconditional showCliMessage before guard', () => {
    // showCliMessage must NOT appear before the first if-block (i.e., not unconditional).
    const firstIfIndex  = modeBody.indexOf('if (');
    const showCliIndex  = modeBody.indexOf('showCliMessage');
    // showCliMessage must be inside an if-block → its index must be > firstIfIndex.
    expect(firstIfIndex).toBeGreaterThanOrEqual(0);   // there IS an if-block
    expect(showCliIndex).toBeGreaterThan(firstIfIndex); // showCliMessage is inside it
  });
});

