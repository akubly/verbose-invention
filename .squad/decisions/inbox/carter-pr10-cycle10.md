# Decision: Full process.argv save/restore in isDirectRun tests

**Date:** 2026-06-05  
**PR:** #10, Cycle 10  
**Thread:** T1 — `tests/install/isDirectRun.test.ts:20-32`  
**Author:** Carter (Bridge Dev)

## Decision

Replace the cycle-6 `argv[1]`-only save/restore pattern with a full-array
save/restore in `isDirectRun.test.ts`.

**Before (cycle-6 pattern):**
```ts
let savedArgv1: string | undefined;
beforeEach(() => { savedArgv1 = process.argv[1]; });
afterEach(() => {
  if (savedArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = savedArgv1;
  }
});
```

**After:**
```ts
let savedArgv: string[];
beforeEach(() => { savedArgv = process.argv.slice(); });
afterEach(() => { process.argv = savedArgv; });
```

## Rationale

Cycle 6 fixed a state leak caused by the original `afterEach` not handling the
case where `argv[1]` was `undefined` (it would write `undefined` back as a
string). The cycle-6 fix saved/restored only `argv[1]`.

IDR5 (added later) calls `process.argv.splice(1)` which mutates the **array
length** — removing all elements from index 1 onward. Restoring only `argv[1]`
does not undo the splice; any elements beyond index 1 remain absent. This can
cause order-dependent flakiness in tests that run after IDR5 and rely on
`process.argv` having its normal shape.

A full-array `slice()` snapshot at `beforeEach` and full reference restore at
`afterEach` handles:
- `argv[1]` being `undefined` (naturally preserved in the slice)
- `argv[1]` being `''` (distinguished correctly, same as cycle-6)
- `splice`-based length mutations (restored by reference reassignment)

## Supersedes

Cycle-6 `argv[1]`-only pattern. The full-array pattern is strictly more
correct and no more complex.
