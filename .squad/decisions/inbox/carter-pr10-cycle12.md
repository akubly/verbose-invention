# carter-pr10-cycle12: Wipe Markers Audit + Quoted Session Name Fix

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 12

---

## T1: registry.json Added to wipeLocalData() Marker List

### Markers added

`registry.json` added to the `markerFiles` array in `wipeLocalData()` (`src/install/uninstall.ts:64`).

**Source:** `src/config/env.ts:43` — `path.join(getReachDataDir(), 'registry.json')`. The file
is a direct child of the data dir (not nested). No exported constant exists for the basename, so
`'registry.json'` is inlined — consistent with how `'config.json'` and `'bridge-auth.json'` are
already expressed.

### Full marker audit against `<dataDir>/` state files

| File | Source | In marker list before? | Action |
|---|---|---|---|
| `config.json` | `src/config/config.ts` `getConfigPath()` | ✓ yes | no change |
| `bridge-auth.json` | `src/bridge/pipeAuth.ts` `getPipeAuthPath()` | ✓ yes | no change |
| `registry.json` | `src/config/env.ts` `registryPath` | ✗ missing | **added** |

No other `<dataDir>/…` constructions found in the codebase. `src/config/migrate.ts` copies from
legacy dirs into `<dataDir>` but introduces no new files beyond the three above. The marker list is
now exhaustive for all known Phase 9 state files.

**Broadening concern:** All three markers are specific Reach JSON files. A random directory
containing an unrelated `registry.json` (e.g. an npm package) would be a false positive, but the
combination check (`some`) means _any_ of the three triggers a pass — the safety check is already
using a low-confidence bar by design (fail-closed on inspection error). Adding one more
Reach-specific name is appropriate.

---

## T2: Unified Whitespace Check for Session Name

### Decision: Unify both paths (`sessionParts.length > 1` replaced by `/\s/.test(sessionName)`)

**Chosen approach:** Replace the `sessionParts.length > 1` guard with a single `/\s/.test(sessionName)`
check applied to the final resolved session name.

**Rationale:**
- The root invariant is: _a session name must not contain whitespace_, regardless of how the
  whitespace got there (unquoted split vs. quoted single token).
- `sessionName = sessionParts.join(' ').trim()` already collapses all session parts into one string.
  Testing that string for `\s` catches both paths:
  - Unquoted `my session` → two tokens → `sessionName = 'my session'` → `\s` fires ✓
  - Quoted `"my session"` → one token `'my session'` → `\s` fires ✓
- The unified check is shorter, has one fewer code path, and its intent is self-evident.
- Error message is identical between both cases — callers see consistent semantics.

**Alternative considered:** Add a second guard after the existing `sessionParts.length > 1` check.
Rejected — two parallel checks with the same error string are redundant and invite drift.
