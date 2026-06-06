# Carter — PR #10 Cycle 4 Fix Decisions

**Wave:** Cycle 4 (PR #10, branch user/aaron/phase9)
**Date:** 2026-06-01
**Threads:** Thread 1 (uninstallService sync-throw timer leak), Thread 2 (hardcoded ~/.reach in no-wipe hint), Thread 3 (stale comment)

---

## Thread 1 — uninstallService sync-throw guard

**finish() helper:** Already existed from Cycle 3 (T2 fix). It calls `clearTimeout(timer)` then resolve/reject. I called it from the new catch block rather than refactoring inline — the helper already does all three required things (clears timeout, resolves/rejects). No refactor needed.

**Listener cleanup approach:** After `finish()` is called, `settled = true` is set before calling `finish()`, so all event handlers are neutered by the settled guard. Physical listener removal (`svc.removeListener`) was NOT added — the `ServiceInstance` interface does not expose `removeListener`, and the settled guard is sufficient. If physical removal is needed in the future, `ServiceInstance` must be extended.

**Mock impl leak fix:** SU tests set `mockSvcUninstall.mockImplementation(() => { throw ... })`. The outer `beforeEach` calls `vi.clearAllMocks()` (NOT `vi.resetAllMocks()`), which preserves mock implementations. Added `afterEach(() => { mockSvcUninstall.mockReset(); })` inside the `uninstallService()` describe block to prevent the throw impl from leaking into subsequent `main()` tests.

---

## Thread 2 — hardcoded ~/.reach in no-wipe hint

**Fix applied:** Line 114 in `src/install/uninstall.ts`. The `reachDir` variable was already resolved on line 111 via `getReachDataDir()`. Only the `Remove-Item` command line was hardcoded; the "Local state preserved" line (line 112) already used `reachDir`. Changed to template literal: `` `[reach]   Remove-Item -Recurse -Force "${reachDir}"` ``.

**Other hardcoded ~/.reach strings:** Grep across `src/**/*.ts` found other occurrences in:
- `src/config/config.ts` — JSDoc comments describing default dir. These are accurate descriptions of the *default*, not user-facing instructions. Left alone.
- `src/config/migrate.ts` — JSDoc/inline comments. Same reasoning. Left alone.
- `src/install/index.ts` — Migration comment. Describes legacy → new path. Left alone.
- `src/bridge/pipeAuth.ts` — JSDoc comment. Left alone.
- `src/install/uninstall.ts` JSDoc (`/** When true, also deletes ~/.reach/... */`) — This is describing the *default* behavior, not a runtime path. Left alone.

Only the **runtime user-facing console output** in the no-wipe branch was wrong.

---

## Thread 3 — stale comment

Comment at lines 100–101 in `src/install/uninstall.ts`. Old text claimed the service uninstaller "calls process.exit internally via node-windows events." Updated to accurately reflect the post-Cycle-3 architecture: uninstallService() returns a Promise, does not exit, and the orchestrator accumulates step results and exits at the end.
