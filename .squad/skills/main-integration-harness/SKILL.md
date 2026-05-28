# Skill: main() Integration Harness

**Owner:** Jun (Test Engineer)  
**Created:** 2026-05-27T23:48:20-07:00  
**First used:** Phase 8 P1 sprint (A8 + N3) — `tests/integration/main-composition.test.ts`

---

## Purpose

Build a lightweight integration harness for `main()` (or any composition-root function)
that mocks all external module dependencies at their import boundaries, then verifies
the two or more behavioral branches without starting any real network, file I/O, or
process.exit paths.

Use this skill whenever:
- A composition root function wires 5+ modules together
- You need to assert **which branches execute** (early-return, fallback, normal path)
- You need to assert **how dependency constructors are called** (arguments, option shapes)
- Full integration tests are too expensive (network, pipes, OS resources)

---

## Pattern

### 1. Use `vi.hoisted()` for shared mock instances

Mock instances that must be shared between `vi.mock()` factories AND test assertions
must be created via `vi.hoisted()`. This runs before vi.mock factories, making the
instances available in both places.

```ts
const { mockBridgeStart, MockAfkModeController, mockRegisterHandlers } = vi.hoisted(() => {
  const mockBridgeStart = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const MockAfkModeController = vi.fn().mockImplementation(() => ({}));
  const mockRegisterHandlers = vi.fn().mockReturnValue({ dispose: vi.fn() });
  return { mockBridgeStart, MockAfkModeController, mockRegisterHandlers };
});
```

### 2. `vi.mock()` factories reference hoisted instances

Factories can safely close over hoisted variables:

```ts
vi.mock('../../src/bridge/extensionBridge.js', () => ({
  ExtensionBridge: vi.fn().mockImplementation(() => ({
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
}));
vi.mock('../../src/bot/afkMode.js', () => ({
  AfkModeController: MockAfkModeController,
}));
```

### 3. Import the system under test AFTER all vi.mock() calls

```ts
import { main } from '../../src/main.js';
import { parseEnv } from '../../src/config/env.js';
// Also import all mocked constructors you need to assert on
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
```

### 4. `beforeEach` MUST re-establish ALL mock implementations

**Critical:** `vi.restoreAllMocks()` in `afterEach` sets `implementation = void 0` on
EVERY `vi.fn()`, including those created inline inside `vi.mock()` factories and all
hoisted instances. Failure to re-establish produces silent failures — inline constructor
mocks return `{}` (no methods), downstream `.start()` calls are `undefined`, and tests
fail with misleading "Cannot read properties of undefined" errors.

```ts
beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish hoisted mock implementations
  mockBridgeStart.mockResolvedValue(undefined);
  mockCleanupPipeAuth.mockResolvedValue(undefined);
  MockAfkModeController.mockImplementation(() => ({}));
  mockRegisterHandlers.mockReturnValue({ dispose: vi.fn() });
  // Re-establish inline mock implementations via vi.mocked()
  vi.mocked(ExtensionBridge).mockImplementation(() => ({
    start: mockBridgeStart,
    stop: mockBridgeStop,
  }));
  vi.mocked(SessionRegistry).mockImplementation(() => ({ load: vi.fn().mockResolvedValue(undefined) }));
  // Console suppression
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks(); // restores console spies; OK because beforeEach re-establishes all
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});
```

### 5. Use fixture helpers to build config objects

```ts
function makePairingConfig(): EnvConfig {
  return { token: 'test-token', chatId: undefined, isPairingMode: true, ... };
}
function makeNormalConfig(overrides: { allowedUserIdSet?: ReadonlySet<number> } = {}): EnvConfig {
  return { token: 'test-token', chatId: 12345, isPairingMode: false, ..., ...overrides };
}
```

### 6. Assert on constructor call arguments for wiring tests

```ts
// Verify arg index 5 (options) of AfkModeController constructor
const ctorOptions = MockAfkModeController.mock.calls[0][5] as { allowedUserIds?: ReadonlySet<number> };
expect(ctorOptions).toMatchObject({ allowedUserIds: configAllowedIds });
```

---

## Scope boundaries

This harness tests **wiring behavior** (which branches execute, which constructors are
called with which args). It does NOT:
- Test the internal logic of any dependency (those belong in unit tests)
- Test `parseEnv()` config-file branch behavior (belongs in `tests/config/env.test.ts`)
- Boot real network connections

---

## Known gotcha: `vi.restoreAllMocks()` + inline vi.fn()

`vi.restoreAllMocks()` is equivalent to `mockRestore()` on each tracked mock:
```
mockReset() → sets implementation = () => void 0
state.restore() → restores tinyspy internal state
implementation = void 0  ← OVERWRITES the no-op, leaves undefined
```

After this, calling the mock returns `undefined` (falls back to the original no-op `() => {}` via
`state.getOriginal()`). Any constructor mock that returns `{}` instead of `{ start, stop, ... }`
will silently produce a broken bridge/bot/registry object. Always re-establish in `beforeEach`.

---

## Reference implementation

`tests/integration/main-composition.test.ts` — Phase 8 A8 + N3 harness (7 tests)
