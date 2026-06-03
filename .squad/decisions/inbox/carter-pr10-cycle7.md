# Carter — PR #10 Cycle 7 Decisions

**Date:** 2026-06-02  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle7)

---

## T1 — `src/config/migrate.ts`: win32 platform gate

**Decision:** Option (b) — explicit `if (process.platform !== 'win32') return;` at the
top of `migrateLegacyDataDir()`, before the `migrationAttempted` flag check.

**Rationale:**

Pre-Phase 8.5 Reach was Windows-only. The legacy paths (`%APPDATA%\reach\`,
`%LOCALAPPDATA%\reach\`) are Windows-specific constructs. There has never been a
Unix install of Reach: prior code used `process.env.APPDATA` which is undefined on
Unix, meaning the codebase would have crashed or produced no-op behavior. There is
no Unix legacy state to migrate FROM.

The Copilot reviewer's premise ("previous default was ~/.config/reach") is incorrect.
Pre-Cycle 3 code did not fall back to `~/.config/reach` — it used `process.env.APPDATA`
with a fallback to `path.join(os.homedir(), 'AppData', 'Roaming')` (a Windows path
convention even when APPDATA is unset). This fallback only makes sense on Windows.

**Why Option (b) over (a):** Option (a) (do nothing) leaves the function silently
inspecting `AppData\Roaming\reach` on a future Unix target, which would always be
absent but is confusing. Explicit gate + documentation makes the Windows-only
assumption clear to Phase 10 contributors. The comment explicitly warns: "When Phase
10 adds cross-platform support, there will be no legacy Unix paths to migrate FROM."
This prevents a future contributor from adding a `~/.config/reach` migration branch
without understanding that no such legacy state ever existed.

**Platform gate position:** Before `migrationAttempted` — this means on non-Windows,
the function returns without setting the flag. This is correct: the flag is only
meaningful for Windows execution flow, and returning before it is set does not create
double-call issues (the function is still a no-op on non-Windows regardless of how
many times it is called).

---

## T2 — `src/install/uninstall.ts`: `import 'dotenv/config'` added

**Decision:** Add `import 'dotenv/config'` as the first import in `uninstall.ts`.

**Rationale:**

`runUninstall()`/`wipeLocalData()` calls `getReachDataDir()`, which honors the
`REACH_DATA_DIR` environment variable. The daemon loads `.env` via `dotenv/config`
(in `src/main.ts`), but the uninstall script did not. A user with
`REACH_DATA_DIR=D:\custom\reach` in `.env` would find that `npm run uninstall -- --wipe`
deletes `~/.reach` (the default) instead of their actual state directory, because the
custom path was only in `.env` and never loaded.

This is a real data-integrity bug: the daemon has been writing to one directory and
the uninstall script is wiping a different one.

---

## T2 Audit — Sibling install entry points

**`src/install/index.ts` (`npm run init`):** ✅ ALSO FIXED.

`runInit()` calls `migrateLegacyDataDir()` → `getReachDataDir()`. If a user has
`REACH_DATA_DIR` in `.env` (e.g., an upgrade on a system with a custom data dir),
the migration would target `~/.reach` instead of the custom dir, potentially
failing to find or copy the legacy data to the right place. Added
`import 'dotenv/config'` as the first import.

Additionally, `runConfigWizard()` reads Telegram vars from `process.env` with
`readEnvFile()` as fallback. With `dotenv/config` loaded, `process.env` is already
populated from `.env` before the wizard runs. The wizard's `getVal()` function reads
`process.env` first anyway, so behavior is consistent — this doesn't change wizard
semantics, it just makes `REACH_DATA_DIR` (and any other process-level config in
`.env`) available through `process.env` uniformly.

**`src/install/copyExtension.ts` (`npm run install:extension`):** ✅ NOT needed.

`copyExtension()` does not call `getReachDataDir()`. It only uses:
- `process.env['APPDATA']` — Windows system env var, always in `process.env`, never in `.env`
- `process.env['NODE_ENV']` — set at CLI invocation (`NODE_ENV=development npm run ...`), not via `.env`

No `dotenv/config` added.

---

## Test coverage added

- **MIG7** (`tests/config/migrate.test.ts`): non-Windows platform mock (`process.platform = 'linux'`),
  asserts `existsSync` is never called — the gate fires before any fs access.
- **UN13** (`tests/install/uninstall.test.ts`): comment-level integration test note documenting
  the manual verification procedure. Unit-level assertion confirms the `vi.mock('dotenv/config')`
  stub is exercised (i.e., the import is present in the production module).
- **dotenv mock** added to both `tests/install/uninstall.test.ts` and `tests/install/index.test.ts`
  to prevent dotenv from attempting real `.env` reads during the test run.
