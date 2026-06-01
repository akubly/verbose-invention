# Reach State Storage Unification — Design Doc

**Author:** Noble Six (Lead / Architect)
**Date:** 2026-05-31
**Branch:** user/aaron/phase9 (PR #10)
**Status:** DRAFT — awaiting Aaron approval

---

## TL;DR

**Recommend Option D — `~/.reach/` (`os.homedir()/.reach/`).** Cost: **S** (small — ~30 LOC across 4 files). Phase 10 ready: **yes** — single root works unchanged on macOS/Linux. Migration cost: effectively zero (Aaron-only install).

---

## 1. Today's Layout — What Lives Where

| File | Windows path | Root function | Durable? | Notes |
|------|-------------|---------------|----------|-------|
| `config.json` | `%APPDATA%\reach\config.json` | `getReachDataDir()` → `getConfigPath()` | ✅ durable | Chat ID, allowed users, knownCwds |
| `registry.json` | `%APPDATA%\reach\registry.json` | `getReachDataDir()` → `env.ts:43` | ✅ durable | Session registry |
| `bridge-auth.json` | `%LOCALAPPDATA%\reach\bridge-auth.json` | `getAuthFilePath()` | ❌ transient | Regenerated every daemon start (ADR-10) |

**Extension (not state — lives in Copilot's own tree):**

| File | Windows path | Owner |
|------|-------------|-------|
| `extension.mjs` | `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs` | `copyExtension.ts` |

Citations:
- `src/config/config.ts:32-37` — `getReachDataDir()` uses `%APPDATA%`
- `src/bridge/pipeAuth.ts:38-41` — `getAuthFilePath()` uses `%LOCALAPPDATA%`
- `src/config/env.ts:42-43` — `configPath` and `registryPath` both derive from `getReachDataDir()`
- `src/install/uninstall.ts:59-91` — `--wipe` only targets `%LOCALAPPDATA%\reach`

---

## 2. Why the Split Happened

**Root cause: two authors, two defaults, no ADR.**

- `config.ts` was written first and used `%APPDATA%` — the Node.js community default for "user data" on Windows. The code even has a Unix fallback to `~/.config/reach/` (XDG style). This suggests the author was thinking cross-platform but picked the Windows-idiomatic root.
- `pipeAuth.ts` (ADR-10, Phase 8) used `%LOCALAPPDATA%` — likely intentional because `bridge-auth.json` is **transient, per-machine** state that should not roam. The docstring explicitly calls out "user-scoped file" and the `%LOCALAPPDATA%` comment references non-roaming.
- Nobody noticed the split because `--wipe` was written assuming everything was in `%LOCALAPPDATA%`, and the README was written to match `--wipe`.

**Was the APPDATA choice for config intentional (roaming)?** Almost certainly not. Reach is a single-machine daemon. Config contains a `telegramChatId` (global) and `knownCwds` (local filesystem paths) — roaming the latter would produce broken paths on another machine.

**Was the LOCALAPPDATA choice for bridge-auth intentional?** Yes — ADR-10 says "per-run" and "regenerated every daemon start." LOCALAPPDATA is correct for transient per-machine state. But the *right* answer is "bridge-auth shouldn't dictate the root — it should live wherever all Reach state lives."

---

## 3. Options Analysis

### Option A — Unify under `%LOCALAPPDATA%\reach`

| Dimension | Assessment |
|-----------|-----------|
| Code changes | `config.ts:getReachDataDir()` → use `LOCALAPPDATA`. ~5 LOC. |
| Docs changes | README lines 65, 67, 172, 180 — already say LOCALAPPDATA, mostly correct. |
| Migration | Delete `%APPDATA%\reach\` after copying 2 files. Trivial. |
| Phase 10 | ❌ `LOCALAPPDATA` doesn't exist on macOS/Linux. Need platform switch. |
| --wipe | ✅ Already correct. |
| Things that could go wrong | 1 (forgot to migrate on existing install) |
| Implementation hours | 1h |

### Option B — Unify under `%APPDATA%\reach`

| Dimension | Assessment |
|-----------|-----------|
| Code changes | `pipeAuth.ts:getAuthFilePath()` → use `getReachDataDir()`. ~3 LOC. |
| Docs changes | README must change LOCALAPPDATA → APPDATA in 4 places. |
| Migration | Move `bridge-auth.json` — but it's transient, so no migration needed. |
| Phase 10 | ❌ `APPDATA` doesn't exist on macOS/Linux. Same platform-switch problem. |
| --wipe | ❌ Must rewrite `wipeLocalData()` to target APPDATA. |
| Roaming risk | ⚠️ bridge-auth.json would roam. Per-machine token on another machine = broken auth. |
| Things that could go wrong | 2 (roaming corruption, --wipe rewrite) |
| Implementation hours | 1.5h |

### Option C — Leave the split, fix --wipe + README

| Dimension | Assessment |
|-----------|-----------|
| Code changes | `uninstall.ts` — add `wipeRoamingData()` targeting `%APPDATA%\reach`. ~15 LOC. |
| Docs changes | README must document both roots accurately. |
| Migration | None. |
| Phase 10 | ❌ Two roots × three platforms = 6 paths to reason about. Cognitive tax compounds. |
| --wipe | Must target both roots. |
| Things that could go wrong | 1 (low — minimal change) |
| Implementation hours | 0.5h |
| **Hidden cost** | Permanent "why two dirs?" question for every future contributor. |

### Option D — `~/.reach/` (os.homedir()/.reach/) ⭐ RECOMMENDED

| Dimension | Assessment |
|-----------|-----------|
| Code changes | `config.ts:getReachDataDir()` → `path.join(os.homedir(), '.reach')` (remove platform switch). `pipeAuth.ts:getAuthFilePath()` → use `getReachDataDir()`. `uninstall.ts:wipeLocalData()` → target `~/.reach/`. ~25 LOC across 4 files. |
| Docs changes | README: replace all `%LOCALAPPDATA%\reach` with `~/.reach/` (4 lines). |
| Migration | Aaron deletes `%APPDATA%\reach\` and `%LOCALAPPDATA%\reach\`. Zero-user-cost. |
| Phase 10 | ✅ **Works unchanged on macOS/Linux.** `os.homedir()` returns `/Users/aaron` or `/home/aaron`. No platform switch needed anywhere. |
| --wipe | Simplifies — one `rmSync` on one root. |
| Precedent | `~/.aws/`, `~/.kube/`, `~/.docker/`, `~/.npm/`, `~/.cargo/` — this is the dominant CLI tool pattern. |
| Things that could go wrong | 1 (home dir clutter — mitigated: dotfile is invisible by default) |
| Implementation hours | 1.5h |

---

## 4. Trade-Off Summary

```
                    Cross-platform   Cognitive    Migration   --wipe
                    readiness        simplicity   cost        correct?
Option A (LOCAL)    ❌ needs switch   ✅ one root   trivial     ✅ already
Option B (APPDATA)  ❌ needs switch   ✅ one root   trivial     ❌ rewrite
Option C (split)    ❌ 6 paths        ❌ two roots  zero        ❌ rewrite
Option D (~/.reach) ✅ zero-switch    ✅ one root   trivial     ✅ simplifies
```

---

## 5. Recommendation: Option D — `~/.reach/`

**Why D wins:** It is the only option that eliminates the platform switch entirely. `os.homedir()` is the one path function that returns a sane, writable, user-scoped directory on every OS Node.js supports. Every other option kicks the cross-platform can to Phase 10.

**Why not A?** A is the runner-up. It fixes the immediate split and `--wipe` is already correct. But it hardcodes a Windows-ism (`LOCALAPPDATA`) that Phase 10 must undo. If we're touching `getReachDataDir()` anyway, we should land on the final answer now.

**Why not C?** C has the lowest implementation cost but the highest ongoing cognitive cost. "Where is my Reach state?" should have a one-word answer, not "it depends on which file."

**Why not B?** B is the worst option. Roaming `bridge-auth.json` is actively harmful (per-machine token on another machine = auth failure).

**The "not idiomatic Windows" concern:** Windows tools like VS Code (`~/.vscode/`), Git (`~/.gitconfig`), and SSH (`~/.ssh/`) already use home-dir dotfiles. The pattern is well-established even on Windows. `%APPDATA%` is more common for GUI apps with installers; CLI tools lean toward `~/`.

---

## 6. Implementation Sketch (for Carter)

**Total: ~25 LOC changed across 4 files.**

### 6.1 `src/config/config.ts` — Simplify `getReachDataDir()`

```typescript
// BEFORE (lines 32-37):
export function getReachDataDir(): string {
  if (os.platform() === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'reach');
  }
  return path.join(os.homedir(), '.config', 'reach');
}

// AFTER:
export function getReachDataDir(): string {
  return path.join(os.homedir(), '.reach');
}
```

Update module docstring: replace `%APPDATA%\reach\` / `~/.config/reach/` with `~/.reach/`.

### 6.2 `src/bridge/pipeAuth.ts` — Use shared root

```typescript
// BEFORE (lines 38-41):
export function getAuthFilePath(): string {
  const localAppData =
    process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'reach', 'bridge-auth.json');
}

// AFTER:
import { getReachDataDir } from '../config/config.js';

export function getAuthFilePath(): string {
  return path.join(getReachDataDir(), 'bridge-auth.json');
}
```

Remove now-unused `os` and `path` imports if they become orphaned (keep `path` — still used for `path.dirname`).

### 6.3 `src/install/uninstall.ts` — Target `~/.reach/`

```typescript
// BEFORE (line 60-65):
const localAppData = process.env['LOCALAPPDATA'];
...
const localDir = path.join(localAppData, 'reach');

// AFTER:
import { getReachDataDir } from '../config/config.js';
// ...
const reachDir = getReachDataDir();  // ~/.reach/
```

Update comments, JSDoc, and the `console.log` hints (lines 119-120) to reference `~/.reach/`.

### 6.4 `README.md` — 4 lines to update

| Line | Before | After |
|------|--------|-------|
| 65 | `%LOCALAPPDATA%\reach\` | `~/.reach/` (or `%USERPROFILE%\.reach\` for Windows clarity) |
| 67 | `%LOCALAPPDATA%\reach\bridge-auth.json` | `~/.reach/bridge-auth.json` |
| 172 | `%LOCALAPPDATA%\reach\` | `~/.reach/` |
| 180 | `%LOCALAPPDATA%\reach\` | `~/.reach/` |

### 6.5 Tests — Grep for LOCALAPPDATA/APPDATA mocks

Search `tests/` for any mocks of `process.env.APPDATA` or `process.env.LOCALAPPDATA` in config/pipeAuth test files. Update mock values to use `os.homedir()` paths. (The `MOCK_APPDATA` constant in copyExtension tests is unrelated — it's for the Copilot extension dir, not Reach state.)

---

## 7. Service Interaction (ADR-5)

**Does `~/.reach/` work when the daemon runs as a Windows Service?**

Yes. Per ADR-5 and `src/service/install.ts:11`, the service runs as the **logged-in Windows user** (not SYSTEM). When a service runs under a named user account:
- `os.homedir()` resolves to that user's `C:\Users\<username>` — same as interactive login.
- `%USERPROFILE%`, `%APPDATA%`, and `%LOCALAPPDATA%` are all set correctly by SCM for user-account services.

No adjustment needed. The service sees the same `~/.reach/` as the interactive user.

---

## 8. Open Question for Aaron (1)

**Should we add an env-var override (`REACH_DATA_DIR`) for power users who want state elsewhere?**

This is a ~3 LOC addition (`process.env.REACH_DATA_DIR ?? path.join(os.homedir(), '.reach')`). It's free insurance against edge cases (corporate machines with redirected home dirs, etc.). Recommendation: yes, add it now. But this is a convenience — not blocking.

---

*End of design doc.*
