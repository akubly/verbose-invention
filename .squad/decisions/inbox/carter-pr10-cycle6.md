# Carter — PR #10 Cycle 6 Decisions

**Date:** 2026-06-01  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle6)

---

## T1 — Orientation Race: Option A (flag-first, no catch rollback)

**Decision:** Set `binding.orientationSent = true` BEFORE `await safeSendMessage(...)`, and do NOT roll back on failure.

**Reasoning:**

- **Why A over B:** The race window only opens if we set the flag after the await. The callers check `!binding.orientationSent` and skip if already set; with flag-first, a second concurrent caller sees the flag immediately and skips — even while the first send is still in flight. Option B (rollback in catch) would reopen the race window on transient failures, which defeats the purpose of the guard.
- **On failure semantics:** `safeSendMessage` already swallows errors internally (logs a warning, never throws). Even if the send fails, the orientation state is conceptually "attempted for this AFK cycle." Retrying on the next `activate()` call after a failure would require a new AFK cycle, which resets `orientationSent` anyway. So keeping the flag true on failure is correct.
- **No retry-on-failure pattern found:** Searched the codebase — no pattern of rolling back state flags and retrying on transient errors in the AFK module. `withRateLimitRetry` covers rate-limit retries at the send layer, not flag rollback at the coordination layer.

---

## T2 — Double `[reach]` Prefix Audit

**Decision:** Strip `[reach]` from `Error.message` bodies in `src/service/install.ts`. The logger owns context.

**Single internal Error message with `[reach]` found and fixed:**

```
Line 346 (before): new Error('[reach] Service uninstall timed out after 60 s — uninstall event never fired')
Line 346 (after):  new Error(`Service uninstall timed out after ${UNINSTALL_TIMEOUT_MS / 1000} s — uninstall event never fired`)
```

**Audit result — other `[reach]` occurrences in install.ts:**  
All other `[reach]` occurrences are in `console.log`, `console.error`, and `console.warn` calls — these are correct (the logger adds context). There are NO other `new Error('[reach] ...')` patterns in `src/service/install.ts` or `src/install/*`.

The only violator was the timeout error message. The call-site `console.error('[reach] Service uninstall failed: ${err.message}')` correctly prefixes context at the boundary.

---

## Cluster 1 — redactSecrets Regex Final Shape

**Pattern change:** Added a 4th capture group `(["']?)` after the value in both KEYWORD_PATTERN and ENV_ASSIGNMENT_PATTERN to capture the optional trailing quote.

**KEYWORD_PATTERN (final):**
```
/\b(token|key|secret|...)\b(\s*[:=]?\s*['"]?)([A-Za-z0-9_\-.+/=]{16,})(["']?)/gi
```
Groups: `(keyword)(separator+openQuote)(value)(closeQuote)`

**ENV_ASSIGNMENT_PATTERN (final):**
```
/\b([A-Z][A-Z0-9_]*(?:TOKEN|...))\b(\s*=\s*['"]?)([^\s'"]{8,})(["']?)/g
```
Groups: `(varName)(separator+openQuote)(value)(closeQuote)`

**Replacement shape:**
```ts
(_match, kw, sep, _value, closeQuote) => `${kw}${sep}[REDACTED]${closeQuote}`
```

**Why independent `(["']?)` instead of backref `\3`:**
Conservative bias rule — false negatives (missed secrets) are worse than false positives. With backref, a mismatched-quote value (`token="secret'`) might fail to match and leak. With independent capture, the trailing character (whatever it is) is always consumed and re-emitted. Downstream pass 3 (HIGH_ENTROPY_PATTERN) provides an additional backstop.

**Mismatched quote behavior:** `token="abc123longvalue1234'` → value redacted, trailing `'` re-emitted as-is. Output is malformed like the input was — acceptable for a best-effort redactor.
