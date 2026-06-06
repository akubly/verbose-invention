# Carter — PR #10 Cycle 15 Decisions

**Date:** 2026-06-06  
**Thread:** T1 — Secret prompt echoes bot token to terminal (`src/install/index.ts:92-99`)

---

## D1: Masking approach — blank vs asterisk

**Decision: blank (option a) — no echo at all.**

Blank masking (fully suppressed output) is chosen over asterisk masking (`*` per char). Rationale:
- Standard behavior for secret entry (matches `sudo`, Python `getpass`, SSH passphrases)
- Does not leak token length (asterisks reveal how many chars were typed)
- Simpler implementation — one-liner suppressor vs char-counting echo

Pattern used: `(rl as any)._writeToOutput` override with a function that writes the prompt text through on the first call and swallows all subsequent writes (echoed keystrokes). This is the **same idiom already used in `src/service/install.ts` `promptPassword()`**. Consistent with established codebase practice.

---

## D2: New helper — `promptSecret`

Added `promptSecret(message)` alongside existing `promptLine(message)` in the prompt helpers block. Used for `TELEGRAM_BOT_TOKEN` prompt only. `TELEGRAM_ALLOWED_USER_IDS` is not a secret (numeric user IDs, not credentials) and keeps `promptLine`.

`promptSecret` is intentionally not exported; it's local to the install wizard, same as `promptLine`.

---

## D3: Non-TTY degradation

No special handling needed in `promptSecret` itself. The wizard already gates on `process.stdin.isTTY` before any prompting:

```typescript
if (needsPrompt && !process.stdin.isTTY) {
  // exits with instructions
  process.exit(1);
}
```

`promptSecret` is only called inside the `if (!botToken)` block, which is only reached after the non-TTY gate. Safe by design.

---

## D4: Sibling audit findings

- **`src/install/uninstall.ts`**: No readline prompts at all. Clean.
- **`src/service/install.ts` `promptPassword()`**: Already has `_writeToOutput` masking (cycle predates this fix). No action required.
- **Token echo-back**: After capturing the bot token, the wizard logs `[reach] Written to <envPath>` — the path only, not the token value. No accidental echo. Clean.

---

## D5: Test observability limitation

The readline mock (`vi.mock('readline', ...)`) returns a plain object with a synchronous `question` stub. The mock has no real TTY output stream, so the `_writeToOutput` suppression cannot be observed by watching stdout content.

Mitigation: `capturedWriteFns` array added to hoisted mock state. The mock's `question` stub captures `rl._writeToOutput` at call time, allowing tests to assert the suppressor function was in place during the bot token prompt (IX18) and absent for the subsequent non-secret prompt (IX19).

The output-stream content assertion (IX19 comment) documents this limitation explicitly.
