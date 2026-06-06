# Carter — PR #10 Cycle 13 Decisions

**Branch:** user/aaron/phase9  
**Date:** 2026-06-05  
**Commit scope:** test (test-only changes)

---

## T1/T2 — Fake-token constant

**Constant chosen:** `FAKE_GH_TOKEN = 'not-a-real-token-0000'`

**Rationale:**  
T1 and T2 both exercise the ENV-assignment pass (`GITHUB_TOKEN=<value>` /
`GITHUB_TOKEN="<value>"`). `ENV_ASSIGNMENT_PATTERN` requires the value to match
`[^\s'"]{8,}` — at least 8 non-space, non-quote characters. The original
`ghp_abcdefghijklmnopqrstuvwxyz12345678` is a `ghp_`-prefixed 40-char value
that GitHub secret scanning recognises as a real PAT shape (prefix + length +
charset).

`not-a-real-token-0000` (21 chars) satisfies `[^\s'"]{8,}`, contains `-` which
is never present in a real GitHub PAT, and is lexically unmistakeable as fake.
It is reused verbatim for the quoted C6-4 variant so both tests reference a
single constant, making intent clear.

No change to what the tests assert — just the fixture value inside the quotes.

---

## T3 — Bare-value restructuring (high-entropy charset guard)

**Problem (Copilot review):** The original test used
`AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`. Because
`AWS_SECRET_ACCESS_KEY` matches `ENV_ASSIGNMENT_PATTERN` (the `ACCESS_KEY`
suffix), the ENV pass redacts the value on Pass 2 *regardless* of whether the
high-entropy charset is correct. If someone reverted the cycle-8 `/`+`+` charset
extension in `HIGH_ENTROPY_PATTERN`, this test would still pass — false safety.

**Fix:** Drop the `AWS_SECRET_ACCESS_KEY=` prefix entirely. The new fixture is:

```
FAKE+Xm3z9pQr/vNsLwD7hYc+E4aOjZtFu1Ii/8bGn  (42 chars)
```

This bare value is only reachable by `HIGH_ENTROPY_PATTERN` (Pass 3).

**Why this value specifically:**
1. Length 42 ≥ 39 threshold — matches as a single run. ✓
2. Contains `/` (position 13) and `+` (positions 4, 24) — the chars added in
   cycle-8.
3. Contains no keyword words (`token`, `key`, `secret`, …) at word boundaries,
   so `KEYWORD_PATTERN` (Pass 1) does not fire first. (Earlier draft used
   `…/aws/key/…` which caused `\bkey\b` to match and produce
   `…/aws/key[REDACTED]` instead of `[REDACTED]`.)
4. Starts with `FAKE` — obviously not a real credential; won't trip AWS secret
   scanning (which looks for `AWS` prefix + length + alphanumeric pattern).

**Charset-regression proof:** If `HIGH_ENTROPY_PATTERN` reverted to
`[A-Za-z0-9_\-]{39,}` (no `/`, no `+`), the 42-char value fragments at each
`/` and `+`:
- `FAKE` (4), `Xm3z9pQr` (8), `vNsLwD7hYc` (10), `E4aOjZtFu1Ii` (12), `8bGn` (4)
- Longest fragment: 12 chars — far below the 39-char threshold.
- Neither `not.toContain(bare)` nor `toBe('[REDACTED]')` would hold → test FAILS.

**Companion assertion added:** `expect(result).toBe('[REDACTED]')` — verifies the
whole 42-char run was matched as one token, guarding against the fragmentation
scenario above.

---

## Sibling `ghp_` scan

Grepped all `tests/**/*.ts` for `ghp_`. Only two occurrences found, both in
`tests/bot/redactSecrets.test.ts` (lines 60 and 154) — both fixed by T1/T2
above. No sibling fixtures elsewhere.
