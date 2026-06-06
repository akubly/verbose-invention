# Carter — PR #10 Cycle 5 Decisions

**Date:** 2026-06-01  
**Commit:** TBD (fix(pr10-cycle5): fail-closed wipe inspection + log service uninstall errors)

---

## 1. Other silent-catch patterns found in install/service code

### `src/config/migrate.ts:113` — non-fatal empty-dir removal

```ts
try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
```

**Context:** This runs only when `copied.length === 0` — the legacy dir is already empty. The rmSync here is a cosmetic cleanup (remove the now-empty shell). If it fails, the migration has already succeeded and no data was left behind. This is a legitimate best-effort swallow: failure is genuinely non-fatal and calling out specific error paths would only add noise to migration logs.

**Assessment:** Leave as-is. Not a safety bug. Unlike `wipeLocalData`, there is no risk of an unintended wipe because the directory is provably empty at this point.

### No other silent-catch patterns found in `src/install/` or `src/service/`.

---

## 2. Final error-logging format

The format chosen for service uninstall errors (in both the CLI shim and `main()`):

```
[reach] Service uninstall failed: <error.message>
```

### Rationale

- **`[reach]` prefix** — Consistent with every other user-facing message in the install/service domain. Makes it easy to grep logs and correlate with other output.
- **`Service uninstall failed:`** — Noun-phrase subject. Action-oriented. Distinguishes this from filesystem step failures in `runUninstall()` which use `ERROR:` or `WARNING:` prefixes.
- **`<error.message>`** — The raw message from the Error object. No wrapping, no JSON, just the text. Avoids double-quoting and keeps copy-paste debugging simple.

### Standardization recommendation for Aaron

If other install commands (e.g., `install()` CLI shim) ever gain similar error-propagation, use the same pattern:

```ts
.catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reach] Service <action> failed: ${msg}`);
  process.exit(1);
});
```

Substitute `<action>` with `install`, `uninstall`, `start`, `stop`, etc.  
The consistent prefix makes it trivial to filter support logs: `grep '\[reach\] Service'`.

---

## 3. mockImplementationOnce pattern for fire-and-forget tests

When testing a `void`-returning function with an internal promise chain (fire-and-forget), and `process.exit` is mocked to throw globally, use `mockImplementationOnce` (not `mockImplementation`) to avoid leaking a non-throwing mock into subsequent tests. This pattern is now established and should be used whenever a similar fire-and-forget shim needs error-path testing.
