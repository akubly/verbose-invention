# Carter — PR #10 Cycle 9 Decisions

**Date:** 2026-06-05  
**Branch:** user/aaron/phase9  
**Threads:** T1 (atomic legacy migration), T2 (excerpt truncation off-by-one)

---

## T1 — Atomic legacy migration (`src/config/migrate.ts:84-107`)

### Options considered

| Option | Description | Risk |
|--------|-------------|------|
| A | Atomic temp+rename per-dir | Cross-device rename concern on Windows; complex partial-cleanup path |
| B | Per-dir retry: remove early-return, check each legacy dir individually | Minimal; idempotent copy handles re-runs cleanly |
| C | Sentinel file `.reach-migration-complete` | More state to manage; doesn't address partial dir failure |
| D | Combine B + A | Most robust; added complexity justified only if cross-device risk is a concern |

### Decision: **Option B**

**Rationale:** The reported bug is precisely the early return `if (fs.existsSync(newRoot)) return;`. Removing it is sufficient — the existing per-dir loop already handles partial states correctly:
- `mkdirSync` with `{ recursive: true }` is a no-op if the dir already exists.
- Each legacy dir is checked for existence before attempting copy.
- If a legacy dir was already successfully migrated (and removed), it is absent from disk and simply skipped.
- Re-copying already-migrated files (overwrite) is harmless and idempotent.

Option D (temp+rename) would guard against mid-copy crashes, but on Windows a rename (MoveFile) within the same volume is atomic and would require a scratch dir under `newRoot`. Given Phase 8.5 scope and the low frequency of mid-copy crashes, this complexity is not justified. The retry path (Option B) closes the actual failure mode: a partial migration that left `newRoot` on disk with only some legacy dirs copied.

### Trade-offs / limitations

- A crash between `copyFileSync` and `rmSync` on a single file leaves the legacy dir intact, which is safe (next run re-copies, then removes).
- A crash between the last successful `rmSync` and process exit leaves no legacy dir and is fully clean.
- The `migrationAttempted` in-process flag still prevents double-migration within one process, which is correct and unchanged.

### Files changed

- `src/config/migrate.ts`: removed `if (fs.existsSync(newRoot)) return;`, updated doc comment.
- `tests/config/migrate.test.ts`: added MIG8 — partial migration retry scenario.

---

## T2 — Off-by-one in excerpt truncation (`src/bot/afkMode.ts:128-130`)

### Decision: apply `slice(0, MAX_EXCERPT_LENGTH - 1) + '…'`

`'…'` is one Unicode character (U+2026). The previous `slice(0, MAX_EXCERPT_LENGTH)` produced 500 chars then appended the ellipsis, storing 501 chars total — exceeding the documented 500-char protocol limit.

Fix: `slice(0, MAX_EXCERPT_LENGTH - 1)` = 499 chars + `'…'` = **500 chars**, matching the limit exactly.

### Files changed

- `src/bot/afkMode.ts`: off-by-one corrected.
- `tests/bot/afkMode.staleExcerpt.test.ts`: added `storedExcerpt.length ≤ 500` assertion to C8 truncation test.
