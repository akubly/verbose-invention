# Jun Cycle 4 Phase 8 Backlog

Items deferred from the Cycle 4 review wave to keep scope contained. Tracked
here for follow-up planning before or during Phase 8.

Updated after Cycle 5 (architect5 findings incorporated).

---

## ✅ CLOSED — A8 / F1 / I5-3 — Composition root extraction

`main.ts` was 221 LOC at the start of Cycle 5. Kat's I5-3 (`src/config/env.ts`,
`src/bot/pairing.ts`) reduced it to ~90 LOC. The A8 watch item is resolved.
Carter's I5-2 (`src/bin.ts`) also cleaned up the entry-point boundary.

---

## Open items

### A2 — ERROR_CODES namespacing

As the relay feature lands and relay error codes are added, `ERROR_CODES` should
be namespaced to avoid a flat, collision-prone object. Proposed shape:

```ts
ERROR_CODES.AFK.*   // existing afk codes
ERROR_CODES.RELAY.* // relay codes (when relay arrives)
```

Defer until the first relay error code is added; a single rename commit at that
point is cheaper than pre-partitioning now.

### A7 — Extend drift test to inbound message shapes

The existing M6 drift test (Carter) checks outbound protocol message shapes.
Inbound shapes (afk.request, back.request, hello, pong, stream.*) are not
covered. Add assertions for these in the drift test before Phase 8 ships.

### F4 watch — Compensation pattern extraction

When a second compensation path appears (e.g., relay activation rollback) OR
`afkMode.ts` exceeds 700 LOC, extract `compensatePartialActivation` into a
shared utility. Currently a single-use internal method; premature extraction
would obscure the data flow without benefit.

### F5 watch — AfkBridgePort split

`AfkBridgePort` currently carries 5 event types. When the count reaches 8 or
the interface spans two unrelated domains, split into focused sub-ports. Track
the current count when adding relay events.

### F8 — AuthorizationPort interface for dynamic auth

When `/approve` commands or dynamic allow-list management land, the inline
`allowedUserIds` option on `AfkModeOptions` will not scale. Extract an
`AuthorizationPort` interface so the auth strategy is injectable and testable
independently.

### N2 — Deny-all misconfiguration: `allowedUserIds: Set([])`

ADR-11 D3 notes that `allowedUserIds: Set([])` is an explicit deny-all state
and should be treated as a misconfiguration, not as unset. The current startup
check catches the empty-string case at the env-var layer (`TELEGRAM_ALLOWED_USER_IDS=""`
after trim → fatal exit), but `Set([])` produced by config JSON `telegramAllowedUserIds: []`
is not detected. A follow-up should add a guard:

```ts
if (allowedUserIdSet !== undefined && allowedUserIdSet.size === 0) {
  console.error('[reach] Fatal: allowedUserIds is empty — this would deny all users. Unset to allow all, or provide at least one ID.');
  process.exit(1);
}
```

The current behavior is documented by the `N2 (backlog)` test in
`tests/config/env.test.ts` (M5-4).

Env-var test coverage should include a test for `TELEGRAM_ALLOWED_USER_IDS=,`
(all tokens empty after split → current fatal path) and a separate test for a
future `size === 0` guard.

### N3 — Config-layer allowed IDs: integration coverage

`telegramAllowedUserIds` in `config.json` sets `allowedUserIdSet` via the
`else if` branch in `parseEnv()`. The happy-path and invalid-config guard are
now covered by `tests/config/env.test.ts` (M5-4 direct tests). A follow-up
integration test should verify the end-to-end path through `main()` to confirm
the config-file branch is wired correctly in the composition root.

---

## Architect Watch (ongoing)

### Module isolation for `main.ts`

`tests/config/env.test.ts` now imports `parseEnv` directly, removing the
13-mock `main.ts` wrapper for env tests (M5-4). If future `main.ts` tests need
to vary mock implementations per-test (e.g., different `loadConfig` responses),
use `vi.resetModules()` + dynamic `await import(...)` for fresh module instances.
