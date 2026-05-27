import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const protocolSource = readFileSync(path.resolve(repoRoot, 'src/bridge/protocol.ts'), 'utf8');
const extensionSource = readFileSync(path.resolve(repoRoot, 'extension.mjs'), 'utf8');

function parseOutboundProtocolTypes(source: string): string[] {
  // ASSUMES: no semicolons in member type expressions or comments inside the OutboundMessage union.
  // The lazy `[\s\S]*?` stops at the first `;` — safe as long as union members are bare interface
  // references with no inline semicolons (true for this protocol file's style).
  const unionMatch = /export type OutboundMessage =([\s\S]*?);/.exec(source);
  if (!unionMatch || unionMatch[1] === undefined) {
    throw new Error('extension-protocol-drift: could not locate OutboundMessage union');
  }

  return unionMatch[1]
    .split('\n')
    .map((line) => /^\s*\|\s*(\w+)/.exec(line)?.[1])
    .filter((typeName): typeName is string => typeName !== undefined)
    .map((typeName) => {
      // Tolerate future `extends` clauses without encoding TypeScript grammar in this sentinel.
      const interfaceRegex = new RegExp(`export\\s+interface\\s+${typeName}[^\\{]*\\{([\\s\\S]*?)\\n\\}`, 'm');
      const interfaceMatch = interfaceRegex.exec(source);
      if (!interfaceMatch || interfaceMatch[1] === undefined) {
        throw new Error(`extension-protocol-drift: could not locate interface ${typeName}`);
      }

      const typeMatch = /type:\s*'([^']+)'/.exec(interfaceMatch[1]);
      if (!typeMatch || typeMatch[1] === undefined) {
        throw new Error(`extension-protocol-drift: could not locate discriminant for ${typeName}`);
      }

      return typeMatch[1];
    })
    .sort();
}

function parseExtensionHandleMessageCases(source: string): string[] {
  // Anchor to the default branch so newly added cases before it are counted.
  const switchMatch = /function\s+handleMessage\s*\(\s*msg\s*\)\s*\{\s*switch\s*\(\s*msg\.type\s*\)\s*\{([\s\S]*?)\n\s*default:/.exec(source);
  if (!switchMatch || switchMatch[1] === undefined) {
    throw new Error('extension-protocol-drift: could not locate handleMessage switch');
  }

  const cases: string[] = [];
  const caseRegex = /case\s+['"]([^'"]+)['"]:/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(switchMatch[1])) !== null) {
    if (match[1] !== undefined) cases.push(match[1]);
  }

  return cases.sort();
}

describe('extension.mjs ↔ OutboundMessage protocol drift detection', () => {
  it('handleMessage covers every OutboundMessage discriminant exactly', () => {
    expect(parseExtensionHandleMessageCases(extensionSource)).toEqual(parseOutboundProtocolTypes(protocolSource));
  });
});
