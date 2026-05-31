import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  RegisterMessage,
  PongMessage,
  StreamMessage,
  StreamErrorMessage,
  AfkRequestMessage,
  BackRequestMessage,
} from '../../src/bridge/protocol.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// A7 — Inbound message shape drift coverage
// ─────────────────────────────────────────────────────────────────────────────
//
// The tests below pin the wire schema for the six inbound types introduced or
// formalised in ADR-8 (hello, pong, stream, stream.error) and ADR-11
// (afk.request, back.request).  They operate at two levels:
//
//   1. Union-coverage  — parse InboundMessage union and compare it to the set
//      of type discriminants that extension.mjs actually emits.
//   2. Field-level drift — parse each interface body and assert field names,
//      required-vs-optional status, and declared TypeScript types match the ADR.
//      The "no undeclared fields" assertion is the negative guard for extra
//      fields; the required/optional assertions guard against missing or
//      mis-classified required fields; the typeStr assertions guard against
//      wrong-typed fields.
//
// ASSUMES: interface bodies use a flat structure (no inline semicolons inside
// type expressions or JSDoc comment lines that look like field declarations).
// Both conditions hold for this protocol file's coding style.
// ─────────────────────────────────────────────────────────────────────────────

// ── Inbound parse helpers ─────────────────────────────────────────────────────

function parseInboundProtocolTypes(source: string): string[] {
  // ASSUMES: no semicolons inside the InboundMessage union member list.
  // The lazy `[\s\S]*?` stops at the first `;` — safe as long as union
  // members are bare interface references with no inline semicolons.
  const unionMatch = /export type InboundMessage =([\s\S]*?);/.exec(source);
  if (!unionMatch || unionMatch[1] === undefined) {
    throw new Error('extension-protocol-drift: could not locate InboundMessage union');
  }

  return unionMatch[1]
    .split('\n')
    .map((line) => /^\s*\|\s*(\w+)/.exec(line)?.[1])
    .filter((typeName): typeName is string => typeName !== undefined)
    .map((typeName) => {
      const interfaceRegex = new RegExp(
        `export\\s+interface\\s+${typeName}[^\\{]*\\{([\\s\\S]*?)\\n\\}`,
        'm',
      );
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

/**
 * Collect all inbound type discriminants that extension.mjs emits to the daemon.
 *
 * Three send patterns are covered:
 *  1. `sendToDaemon({ type: 'literal', ... })` — most sends; type is always first property.
 *  2. `JSON.stringify({ type: 'literal', ... })` — hot-path stream chunks written directly.
 *  3. `sendModeRequest('afk.request'|'back.request')` — dynamic type variable resolved here.
 */
function parseExtensionSentTypes(source: string): string[] {
  const types = new Set<string>();

  // Pattern 1: sendToDaemon({ type: 'literal', ...
  const sendRegex = /sendToDaemon\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = sendRegex.exec(source)) !== null) {
    if (m[1] !== undefined) types.add(m[1]);
  }

  // Pattern 2: JSON.stringify({ type: 'literal', ... — stream hot-path
  const stringifyRegex = /JSON\.stringify\s*\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g;
  while ((m = stringifyRegex.exec(source)) !== null) {
    if (m[1] !== undefined) types.add(m[1]);
  }

  // Pattern 3: sendModeRequest('afk.request' | 'back.request')
  const modeRegex = /sendModeRequest\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = modeRegex.exec(source)) !== null) {
    if (m[1] !== undefined) types.add(m[1]);
  }

  return [...types].sort();
}

interface FieldSpec {
  name: string;
  optional: boolean;
  typeStr: string;
}

/**
 * Extract field declarations from a TypeScript interface body string.
 *
 * Handles `fieldName: Type;` (required) and `fieldName?: Type;` (optional).
 * JSDoc comment lines (starting with `*` after leading whitespace) are
 * automatically skipped because `*` is not matched by `\w+`.
 */
function parseInterfaceFields(body: string): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const fieldRegex = /^\s+(\w+)(\?)?\s*:\s*(.+?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(body)) !== null) {
    if (m[1] !== undefined) {
      fields.push({
        name: m[1],
        optional: m[2] === '?',
        typeStr: (m[3] ?? '').trim(),
      });
    }
  }
  return fields;
}

function getInterfaceBody(source: string, interfaceName: string): string {
  const regex = new RegExp(
    `export\\s+interface\\s+${interfaceName}[^{]*\\{([\\s\\S]*?)\\n\\}`,
    'm',
  );
  const match = regex.exec(source);
  if (!match || match[1] === undefined) {
    throw new Error(`extension-protocol-drift: could not locate interface ${interfaceName}`);
  }
  return match[1];
}

// ── A7: InboundMessage union coverage ─────────────────────────────────────────

describe('extension.mjs ↔ InboundMessage protocol drift detection', () => {
  it('all extension.mjs inbound sends are declared in InboundMessage union', () => {
    const sent = parseExtensionSentTypes(extensionSource);
    const declared = parseInboundProtocolTypes(protocolSource);
    for (const type of sent) {
      expect(declared, `extension sends "${type}" but it is not in InboundMessage union`).toContain(
        type,
      );
    }
  });

  it('all A7 inbound types are present in InboundMessage union', () => {
    const a7Types = ['afk.request', 'back.request', 'hello', 'pong', 'stream', 'stream.error'];
    const declared = parseInboundProtocolTypes(protocolSource);
    for (const type of a7Types) {
      expect(declared, `"${type}" is missing from InboundMessage union`).toContain(type);
    }
  });

  it('all A7 inbound types are sent by extension.mjs', () => {
    const a7Types = ['afk.request', 'back.request', 'hello', 'pong', 'stream', 'stream.error'];
    const sent = parseExtensionSentTypes(extensionSource);
    for (const type of a7Types) {
      expect(sent, `"${type}" is never emitted by extension.mjs`).toContain(type);
    }
  });
});

// ── A7: per-type field-level shape assertions ──────────────────────────────────
//
// Each describe group pins the exact shape of one inbound interface:
//   - discriminant value
//   - required fields (name + type string)
//   - optional fields (name + type string)
//   - no undeclared fields (guards "extra fields rejected")
//
// If the TypeScript type is modified without updating the ADR, or vice-versa,
// one of these assertions will fail and signal the drift to the team.
//
// The TypeScript import aliases below are unused at runtime but act as
// compile-time documentation: if an interface is renamed in protocol.ts the
// import itself will break tsc (when tests are checked), making the intent clear.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AnchorImports = RegisterMessage | PongMessage | StreamMessage | StreamErrorMessage | AfkRequestMessage | BackRequestMessage;

describe('A7 inbound message shapes — field-level drift assertions', () => {
  // ── hello (RegisterMessage) ── ADR-8 §1, ADR-10, ADR-11 ─────────────────────
  describe('hello (RegisterMessage)', () => {
    const body = getInterfaceBody(protocolSource, 'RegisterMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is hello', () => {
      expect(byName['type']?.typeStr).toBe("'hello'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('sessionName is required string', () => {
      expect(byName['sessionName']?.optional).toBe(false);
      expect(byName['sessionName']?.typeStr).toBe('string');
    });

    it('authToken is required string — ADR-10 pipe auth token', () => {
      expect(byName['authToken']?.optional).toBe(false);
      expect(byName['authToken']?.typeStr).toBe('string');
    });

    it('cwd is optional string — ADR-11 late addition, legacy clients may omit', () => {
      expect(byName['cwd']?.optional).toBe(true);
      expect(byName['cwd']?.typeStr).toBe('string');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['authToken', 'cwd', 'sessionId', 'sessionName', 'type']);
    });
  });

  // ── pong (PongMessage) ── ADR-8 §1 ──────────────────────────────────────────
  describe('pong (PongMessage)', () => {
    const body = getInterfaceBody(protocolSource, 'PongMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is pong', () => {
      expect(byName['type']?.typeStr).toBe("'pong'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('id is required string — must echo the paired ping id', () => {
      expect(byName['id']?.optional).toBe(false);
      expect(byName['id']?.typeStr).toBe('string');
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['id', 'sessionId', 'type']);
    });
  });

  // ── stream (StreamMessage) ── ADR-8 §3 chunk variant ────────────────────────
  //
  // Covers both the mid-stream variant (done: false) and the final-chunk
  // variant (done: true) — both share the same interface shape; `done` is a
  // required boolean that distinguishes them at the value level, not type level.
  describe('stream (StreamMessage) — chunk and final-chunk variants', () => {
    const body = getInterfaceBody(protocolSource, 'StreamMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is stream', () => {
      expect(byName['type']?.typeStr).toBe("'stream'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('requestId is required string', () => {
      expect(byName['requestId']?.optional).toBe(false);
      expect(byName['requestId']?.typeStr).toBe('string');
    });

    it('chunk is required string', () => {
      expect(byName['chunk']?.optional).toBe(false);
      expect(byName['chunk']?.typeStr).toBe('string');
    });

    it('done is required boolean — false = mid-chunk, true = final chunk', () => {
      expect(byName['done']?.optional).toBe(false);
      expect(byName['done']?.typeStr).toBe('boolean');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['chunk', 'done', 'requestId', 'sessionId', 'type']);
    });
  });

  // ── stream.error (StreamErrorMessage) ── ADR-8 §3 error variant ─────────────
  describe('stream.error (StreamErrorMessage) — error variant', () => {
    const body = getInterfaceBody(protocolSource, 'StreamErrorMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is stream.error', () => {
      expect(byName['type']?.typeStr).toBe("'stream.error'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('requestId is required string', () => {
      expect(byName['requestId']?.optional).toBe(false);
      expect(byName['requestId']?.typeStr).toBe('string');
    });

    it('error is required string — human-readable error message', () => {
      expect(byName['error']?.optional).toBe(false);
      expect(byName['error']?.typeStr).toBe('string');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['error', 'requestId', 'sessionId', 'type']);
    });
  });

  // ── afk.request (AfkRequestMessage) ── ADR-11 §4.1 ─────────────────────────
  describe('afk.request (AfkRequestMessage)', () => {
    const body = getInterfaceBody(protocolSource, 'AfkRequestMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is afk.request', () => {
      expect(byName['type']?.typeStr).toBe("'afk.request'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['lastAssistantExcerpt', 'sessionId', 'type']);
    });

    it('lastAssistantExcerpt is optional string', () => {
      expect(byName['lastAssistantExcerpt']?.optional).toBe(true);
      expect(byName['lastAssistantExcerpt']?.typeStr).toBe('string');
    });
  });

  // ── back.request (BackRequestMessage) ── ADR-11 §4.3 ───────────────────────
  describe('back.request (BackRequestMessage)', () => {
    const body = getInterfaceBody(protocolSource, 'BackRequestMessage');
    const fields = parseInterfaceFields(body);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    it('discriminant is back.request', () => {
      expect(byName['type']?.typeStr).toBe("'back.request'");
      expect(byName['type']?.optional).toBe(false);
    });

    it('sessionId is required string', () => {
      expect(byName['sessionId']?.optional).toBe(false);
      expect(byName['sessionId']?.typeStr).toBe('string');
    });

    it('no undeclared fields — extra fields must be rejected', () => {
      const names = fields.map((f) => f.name).sort();
      expect(names).toEqual(['sessionId', 'type']);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #8 — mirror.input SDK API drift regression guard
//
// SDK v0.2.2: session.send() returns Promise<string> (message ID), NOT an
// async iterable. The extension must use the event-emitter streaming pattern:
//   - session.on('assistant.message_delta', ...) for chunks
//   - session.on('session.idle', ...) for completion
//   - session.send({ prompt: text }) as fire-and-forget
//
// These tests catch any regression back to the old `for await ... of send()`
// pattern, which crashes at runtime with "not async iterable".
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #8 regression — extension.mjs SDK send() API contract', () => {
  it('does NOT use for-await over sdkSession.send (old async-iterable pattern — breaks on SDK v0.2.2)', () => {
    expect(extensionSource).not.toMatch(/for\s+await\s*\([^)]+of\s+sdkSession\.send\s*\(/);
  });

  it('subscribes to assistant.message_delta for streaming chunks (SDK v0.2.2 event-emitter pattern)', () => {
    expect(extensionSource).toMatch(/sdkSession\.on\s*\(\s*['"]assistant\.message_delta['"]/);
  });

  it('calls send() with MessageOptions object { prompt: ... } not a bare string (SDK v0.2.2 API)', () => {
    expect(extensionSource).toMatch(/sdkSession\.send\s*\(\s*\{\s*prompt:/);
  });

  it('subscribes to session.idle to detect stream completion', () => {
    expect(extensionSource).toMatch(/sdkSession\.on\s*\(\s*['"]session\.idle['"]/);
  });
});
