/**
 * Static-source probe: does `@github/copilot-sdk` impose an internal timeout
 * on the `onPermissionRequest` callback?
 *
 * Background: ADR-9 removes the 60s timeout from `promptUserForPermission`
 * in src/bot/prompt.ts on the assumption that the SDK awaits the handler
 * indefinitely. This test guards that assumption by inspecting the installed
 * SDK's compiled source for `_executePermissionAndRespond` and asserting it
 * contains no timeout primitives (no `Promise.race` with setTimeout, no
 * `AbortSignal.timeout`, no `setTimeout` call wrapping the handler await).
 *
 * Why static inspection and not a copied/black-box probe:
 *  - Copying the SDK implementation into the repo creates licensing risk and
 *    drifts silently when the SDK is upgraded.
 *  - A black-box behavioral probe would require booting a real CopilotClient
 *    with credentials and live RPC, which is unreliable in CI.
 *  - Reading the installed file lets the test fail loudly the moment the SDK
 *    grows a timeout, without embedding any of its code.
 *
 * Carter — Bridge Dev, 2026-05-23 (revised in cloud-review cycle 3)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SDK_SESSION_PATH = path.join(
  process.cwd(),
  'node_modules',
  '@github',
  'copilot-sdk',
  'dist',
  'session.js',
);

/**
 * Extract the body of an async method by name from a JS source string.
 * Handles brace-balanced extraction across multiple lines.
 * Returns null if the method cannot be located.
 */
function extractMethodBody(source: string, methodName: string): string | null {
  const signature = new RegExp(`async\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = signature.exec(source);
  if (!match) return null;

  const start = match.index + match[0].length - 1; // position of opening brace
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start + 1, i);
      }
    }
  }
  return null;
}

describe('SDK permission handler — static source inspection', () => {
  let methodBody: string;

  beforeAll(() => {
    // Fail fast with a clear message if the SDK layout changed.
    expect(fs.existsSync(SDK_SESSION_PATH)).toBe(true);
    const source = fs.readFileSync(SDK_SESSION_PATH, 'utf8');
    const body = extractMethodBody(source, '_executePermissionAndRespond');
    expect(body, 'failed to locate _executePermissionAndRespond in SDK source').not.toBeNull();
    methodBody = body!;
  });

  it('does not call Promise.race', () => {
    expect(methodBody).not.toMatch(/Promise\s*\.\s*race\s*\(/);
  });

  it('does not call setTimeout', () => {
    expect(methodBody).not.toMatch(/\bsetTimeout\s*\(/);
  });

  it('does not use AbortSignal.timeout', () => {
    expect(methodBody).not.toMatch(/AbortSignal\s*\.\s*timeout\s*\(/);
  });

  it('does not construct a new AbortController', () => {
    // A fresh AbortController inside _executePermissionAndRespond would be
    // the obvious vehicle for an internal timeout.
    expect(methodBody).not.toMatch(/new\s+AbortController\s*\(/);
  });

  it('awaits the permissionHandler directly (no wrapper detected)', () => {
    // Sanity check that we're inspecting the right function — the body must
    // contain an `await this.permissionHandler(`. If the SDK renames or
    // restructures this call, the test should fail and prompt re-inspection.
    expect(methodBody).toMatch(/await\s+this\.permissionHandler\s*\(/);
  });
});
