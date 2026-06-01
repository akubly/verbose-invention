# Carter — PR #10 Cycle 3 Storage Migration Decisions

**Date:** 2026-05-31  
**Branch:** user/aaron/phase9  
**Author:** Carter (Bridge Dev)

---

## Migration Approach: Option A (Explicit)

**Decision:** Approach A — `migrateLegacyDataDir()` is an explicit function called from two entry points: `src/install/index.ts` (`runInit`) and `src/main.ts` (`main`).

**Reasoning over Option B (lazy / first-call):**
- Explicit call sites are easier to test: tests can call the function directly and assert side effects without going through `getReachDataDir()`.
- The module-level `migrationAttempted` flag in Option B couples migration state to module lifecycle, making reset tricky in test environments (requires `vi.resetModules()`). In Option A the flag lives in `migrate.ts` which can be independently reset.
- Explicit call sites make it obvious in the install and daemon startup that "migration runs here" — future maintainers don't need to know that `getReachDataDir()` has side effects.
- Aaron's install is single-machine; the extra explicitness costs nothing.

**Tradeoff accepted:** If someone adds a third entry point and forgets to call `migrateLegacyDataDir()`, migration won't run there. Acceptable: the two call sites (install + daemon start) cover the entire install lifecycle.

---

## REACH_DATA_DIR Resolution Rules

| Input | Behavior |
|-------|----------|
| Not set | `path.join(os.homedir(), '.reach')` |
| Empty string `""` | Treated as absent — uses default |
| Whitespace only `"   "` | `.trim()` → empty → treated as absent — uses default |
| Absolute path | `path.resolve(value.trim())` — resolved as-is |
| Relative path | `path.resolve(value.trim())` — resolved relative to `process.cwd()` |

**Rationale:** `.trim()` before empty-check prevents accidental whitespace (e.g., trailing newline in a `.env` file) from being used as a path. `path.resolve()` normalises both relative and absolute paths, making the output always absolute.

---

## Hardcoded Path Strings Found Beyond Initial Scope

Grepped `src/` for `LOCALAPPDATA`, `APPDATA.*reach`, and `\\reach\\`. Found:

| File | Pattern found | Action taken |
|------|--------------|--------------|
| `src/config/config.ts` | `%APPDATA%\reach` in docstring + code | ✅ Updated docstring + simplified function |
| `src/bridge/pipeAuth.ts` | `%LOCALAPPDATA%\reach\bridge-auth.json` in docstring + `getAuthFilePath()` | ✅ Updated to use `getReachDataDir()` |
| `src/install/uninstall.ts` | `%LOCALAPPDATA%\reach` in comments, `LOCALAPPDATA` env var in two functions | ✅ Removed both; uses `getReachDataDir()` |
| `src/install/copyExtension.ts` | `%APPDATA%\GitHub Copilot\...` in docstring | ⏭️ Left untouched — this is the extension dir, not Reach state (explicitly out of scope per design doc §1) |

No additional hardcoded path strings found outside these four files.

---

## Cross-Platform / ADR-5 Confirmation

`os.homedir()` returns the correct user home directory on Windows when the daemon runs as a service per ADR-5 (service runs as the logged-in user account, not SYSTEM). When a named-user Windows service starts:
- `os.homedir()` → `C:\Users\<username>` (same as interactive shell)
- `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` are all populated by SCM

This is documented in Noble Six's design doc §7 and confirmed by `src/service/install.ts:11`. A dedicated service-context test is deferred to Phase 10 (noted in `history.md`).

---

## Files Changed

| File | Change |
|------|--------|
| `src/config/config.ts` | `getReachDataDir()` rewritten to `~/.reach/` + `REACH_DATA_DIR` override |
| `src/config/migrate.ts` | **New** — `migrateLegacyDataDir()` one-shot migration helper |
| `src/bridge/pipeAuth.ts` | `getAuthFilePath()` → `getReachDataDir() + '/bridge-auth.json'`; import added |
| `src/install/uninstall.ts` | `wipeLocalData()` targets `getReachDataDir()`; no-wipe hint updated; `LOCALAPPDATA` code removed |
| `src/install/index.ts` | `migrateLegacyDataDir()` called at start of `runInit()` |
| `src/main.ts` | `migrateLegacyDataDir()` called at start of `main()` |
| `tests/config/config.test.ts` | `getReachDataDir()` + `getConfigPath()` tests rewritten for new behaviour |
| `tests/config/migrate.test.ts` | **New** — migration unit tests (MIG1–MIG6) |
| `tests/install/uninstall.test.ts` | Updated for new path structure; UN10 added |
