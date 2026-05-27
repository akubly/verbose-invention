# Jun Cycle 4 Phase 8 Backlog

Items deferred from the Cycle 4 review wave to keep scope contained. Tracked
here for follow-up planning before or during Phase 8.

## N2 — Deny-all misconfiguration: `allowedUserIds: Set([])`

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

Env-var test coverage should include a test for `TELEGRAM_ALLOWED_USER_IDS=,`
(all tokens empty after split → current fatal path) and a separate test for a
future `size === 0` guard.

## N3 — Config-layer allowed IDs: integration coverage

`telegramAllowedUserIds` in `config.json` sets `allowedUserIdSet` via the
`else if` branch (lines 82-88 of `src/main.ts`). There is currently no unit or
integration test exercising this path. A follow-up should add tests that:
- Load a config mock with `telegramAllowedUserIds: [999]`
- Verify `allowedUserIdSet` is populated and the ALL-users warn is suppressed
- Verify the `!Array.isArray` / non-positive-integer guard fires on bad config

## Architect Watch — Module isolation for `main.ts`

`tests/main/env-parsing.test.ts` uses a static import of `main` protected by
the `VITEST !== 'true'` guard at the bottom of `main.ts`. If future test cases
need to vary the mock implementations per-test (e.g., different `loadConfig`
responses), they will need `vi.resetModules()` + dynamic `await import(...)` to
get fresh module instances. The current tests can share a single static import
because all four cases use the same mock configuration; this note flags the
pattern before it becomes a footgun.
