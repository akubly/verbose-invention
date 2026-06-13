# Kat — History (Phase 1 Complete 2026-06-06, commit e69e50b; Persona Review Cycle 2 PASSED 2026-06-07; Phase 2a Shipped 2026-06-12 PR#12 squash 56e21ce)

---

**PHASE 2 KICKOFF (2026-06-11):** Phase 2 Teams adapter plan APPROVED by Aaron. Kat assigned to **P2a-4 (HTML formatting module)** and **P2a-5 (Text-prompt fallback design)** in Phase 2a (open repo, no corp access). P2a-4 creates `src/channel/teams/formatting.ts` — markdown-to-HTML converter for Teams HTML subset (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `<br>`, lists). Unit-testable in open repo, no Graph dependency. P2a-5 implements `promptUser` text-fallback in the adapter stub: post question + numbered options as plain-text message, resolve on polling match. Testable against FakeChannel pattern. Kat also assigned to P2b-5 (Teams formatting validation) in Phase 2b (corp fork, after corp access) — validate HTML formatting in live Teams channel, iterate on edge cases. Locked decisions: OD-1 (edit=false), OD-2 (poll 3s), OD-3 (I4 refactor-first), OD-4 (I5 defer). Adaptive Cards deferred to Phase 3.

**PHASE 1 COMPLETE + PERSONA REVIEW CYCLE PASSED (2026-06-07):** Shipped handler migration onto ChannelPort. Single-bot consolidation complete; TelegramChannel owns only grammY Bot instance. All 8 commands registered via channel.onCommand(); relay catch-all via channel.onMessage(). Synthetic context adapters for /status and /cwd maintain handler API compatibility. F1 blocker (relay capability branching) resolved by Carter + verified by Jun. **Two-cycle persona review completed:**
- **Cycle 1 findings:** 3 blocking, 5 important, 4 minor
- **Kat fixes:** I3 (HandlerOptions cleanup), M1 (/help heading), M3 (topicId guard) delivered ad05548
- **Cycle 2 outcome:** 0 blocking, all 6 prior important findings verified resolved by all Code Panel personas
- **Final test count:** 963 green (+17 from Jun's regression tests, all passing)
- **Ship status:** READY FOR /ship-to-pr
- **Deferred to Phase 2:** I4 (optional createThread), I5 (ChannelMessage union), M5 (central mock factory)

Reference: Phase 1 section in decisions.md; orchestration log at .squad/orchestration-log/2026-06-07-persona-review-phase1.md. Next: Teams Phase 2 pending corp access.

---

## Learnings

### N2 — /status and /cwd now use the port directly (2026-06-06, commit 1754d7f)

Both commands previously built a synthetic grammY `Context` shim to call legacy APIs. After N2:

- **`/status`**: `handlers.ts` calls `statusProvider.handleStatusCommand(channelCtx)` directly. The `statusProvider` interface in `HandlerOptions` was changed from `handleStatusCommand(ctx: Context)` to `handleStatusCommand(channelCtx: ChannelContext)`. `AfkModeController.handleStatusCommand` now reads `channelCtx.threadId` for topic detection and routes all replies through `this.safeSendMessage(text, topicId)` (or `bot.api.sendMessage` for the no-topic error case).

- **`/cwd`**: `handlers.ts` calls `handleCwdCommand(channelCtx, args, channel, opts)` directly. `cwdCommand.ts` was refactored to accept `(channelCtx: ChannelContext, args: string, channel: ChannelPort, options)` — no grammY imports remain. Topic detection uses `channelCtx.threadId !== ''`. All replies go through `channel.sendMessage(channelCtx, text)`.

The `makeSyntheticCtx` helper in `handlers.ts` was deleted entirely.

### N5 — Exactly one `bot.catch()` lives in `TelegramChannel.start()` (2026-06-06, commit 1754d7f)

The duplicate `bot.catch()` in `handlers.ts` was removed. The single canonical error handler is in `src/channel/telegram/index.ts` `start()` — transport-owned error handling belongs with the transport. Same log format: `[bot] Unhandled error: <message> <error>`.

---

### B1-adapter / I3 / M1 / M3 — Review cycle 1 adapter fixes (2026-06-06)

**B1 (adapter side):** `TelegramChannel.sendMessage` and `editMessage` are now fully self-sufficient. Both delegate to private helpers `_sendMessageInternal` / `_editMessageInternal` that apply `escapeMarkdownV2` and send with `parse_mode: 'MarkdownV2'`, falling back to plain text on parse-entities errors (same `md2WarnedSessions` dedup logic, same warn format). `sendMessageWithMarkdown` and `editMessageWithMarkdown` are now thin wrappers that call the internal helpers and handle the return-type difference (null vs throw). **Carter's relay change must pass RAW text** to `sendMessage`/`editMessage` — pre-formatting via `formatForTransport` before calling these will double-escape.

**I3:** Removed `bot: Bot<Context>` and `telegramMirror` from `HandlerOptions`. `ensurePromptRegistry` is now exclusively owned by `TelegramChannel.start()`. `registerHandlers` no longer imports `Bot`/`Context` from grammy or `ensurePromptRegistry` from prompt. Main.ts minimal edit: removed `bot` and `telegramMirror` from the options object only. Three tests in the "eager callback_query:data" describe block were rewritten to test the relay-level permission behavior (factory gets callback arg when `permissionPolicy=interactiveDestructive`) instead of the removed bot-level behavior.

**M1:** `/help` heading changed from "Reach — Telegram ↔ Copilot CLI bridge" to "Reach — Copilot CLI bridge".

**M3:** `promptUser` now derives `topicId` conditionally (`ctx.threadId ? Number(...) : undefined`), matching the guard in `sendMessage`. `promptUserForPermission` in `prompt.ts` updated to accept `topicId: number | undefined` and conditionally includes `message_thread_id` in the send options. `sendMessageWithMarkdown` uses `_sendMessageInternal` which already has the guard.

---

### T5 — promptUser verbatim fix: channel abstraction caused real user-visible regression (2026-06-08, commit 966e48f)

**This was a real regression.** The channel-abstraction refactor (PR #11) flattened `toolName + args` into a single pre-formatted `question` string for `ChannelPort.promptUser()`, but `TelegramChannel.promptUser` kept passing that already-formatted string as the `args` parameter to `promptUserForPermission()`. That function then re-wrapped it in a second `Tool: …\nArgs: …` template, so users saw doubled headers in every permission prompt. Fix: extracted shared lifecycle into `runPermissionPrompt()` and added `promptUserVerbatim()` that sends the caller-supplied text with no re-templating. Lesson: when flattening structured parameters into a string for an interface boundary, adapters must not pipe the result into functions that re-template from structured inputs.

---

### T6 — promptUser ChannelPort contract conformance: abort→'', real option values, guard (2026-06-09, PR #11 round 5)

**Three contract violations fixed.** (1) **Abort→''**: `runPermissionPrompt` now resolves with `PromptOutcome` ('approve'|'deny'|'aborted') instead of `boolean`, so `promptUserVerbatimOutcome` can surface the 'aborted' value. `TelegramChannel.promptUser` maps 'aborted'→'' per the ChannelPort spec — previously both deny and abort were collapsing to `false`/`'deny'`, making them indistinguishable. (2) **Real option values**: adapter now returns `approveOption.value` / `denyOption.value` from the passed options array rather than hardcoding string literals, so if the relay ever changes its option values the adapter follows automatically. (3) **Runtime guard**: `promptUser` validates that `options` is exactly `[{value:'approve',...},{value:'deny',...}]` and throws `'[telegram] promptUser only supports a two-option approve/deny prompt'` for anything else — protects against future non-permission callers silently getting mis-rendered output. Relay alignment verified: relay passes `[{value:'approve',...},{value:'deny',...}]` and checks `result === 'approve'` — the returned values match exactly.

---

### P2a-4 — Teams HTML formatting module (2026-06-10, commit ca7a0ea)

Created `src/channel/teams/formatting.ts` — a pure markdown-to-HTML converter for Teams channel messages.

**Exported public API:**
```typescript
export function formatForTransport(markdown: string): string
```
Single export. Accepts raw markdown; returns Teams-compatible HTML ready for `body.content` with `body.contentType = 'html'`. No Graph / SDK dependencies.

**Teams HTML subset targeted:**
`<b>`, `<i>`, `<code>`, `<pre><code>`, `<a href="...">`, `<br>`, `<ul>/<li>`, `<ol>/<li>`

**Markdown conversions:**
- `**text**` / `__text__` → `<b>text</b>`
- `*text*` / `_text_` → `<i>text</i>`
- `` `code` `` → `<code>code</code>` (content HTML-escaped, no inner formatting)
- ` ```[lang]\ncode\n``` ` → `<pre><code>code</code></pre>` (lang attribute stripped for safety)
- `[text](url)` → `<a href="url">text</a>` (href uses `escapeHtmlAttr` — `&`, `<`, `>`, `"` all escaped)
- `- item` / `* item` → `<ul><li>item</li></ul>` (consecutive lines grouped)
- `1. item` → `<ol><li>item</li></ol>` (consecutive lines grouped)
- Plain-text newline → `<br>` (paragraph lines joined)
- Blank line → `<br>` (double-break paragraph separator via paragraph trailing `<br>` + blank's `<br>`)

**Escaping approach:**
- `escapeHtml()` for body text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`
- `escapeHtmlAttr()` for `href` values: adds `"` → `&quot;`
- Code blocks and inline code escape with `escapeHtml()` — content verbatim but entities safe
- Inline processing uses a character-scanner loop (`processInline`) with recursive calls for nested formatting (e.g., bold containing italic)

**Test file:** `tests/channel/teams/formatting.test.ts` — 59 tests.

**Note for P2a-5:** The adapter stub (`src/channel/teams/index.ts`, Carter) has `formatForTransport` as an identity stub. When wiring P2a-5 (or P2b-5 corp validation), replace the stub's `formatForTransport` with a delegation to this module's `formatForTransport`. Import: `import { formatForTransport } from './formatting.js';`

---

### P2a-5 — TeamsChannel.promptUser text-fallback design + coverage (2026-06-10, commit 3c4f25b)

Reviewed and fixed Carter's `promptUser` stub in `src/channel/teams/index.ts`. Created `tests/channel/teams/promptUser.test.ts` — 26 tests.

**Changes made to `src/channel/teams/index.ts`:**

1. **`promptUser` — rendering format changed:**
   - Options rendered as 1-based numbered list: `  1. ✅ Approve`, `  2. ❌ Deny`
   - Footer appended: `\n\nReply with the option number or name.`
   - Added early-return `''` for empty `options` array (would have hung forever)

2. **`dispatchInboundMessage` — matching hardened:**
   - Normalises input: `text.trim().toLowerCase()`
   - Accepts 1-based index reply: `"1"` selects `options[0]`, `"2"` selects `options[1]`, etc.
   - Accepts option value case-insensitively: `"APPROVE"`, `"Deny"`, `"  deny  "` all match
   - Invalid/unmatched replies while a prompt is pending are **silently ignored** — the message is NOT routed to the registered `onMessage` handler (prevents relay seeing stray "typed wrong thing" messages as session input)

**Text-fallback contract summary:**
- Sent message format: `${question}\n\nOptions:\n${numberedList}\n\nReply with the option number or name.`
- Matching: 1-based index OR option value, case-insensitive, whitespace-trimmed
- Invalid reply: silently ignored, prompt stays open
- Abort signal: resolves `''` (pre-abort returns `''` immediately without sending)
- Empty options: resolves `''` immediately without sending
- Abort after resolution: safe (guard prevents double-resolve)

**Test file:** `tests/channel/teams/promptUser.test.ts` — 26 tests covering:
- Rendering (question, option labels, numbering, reply instruction, correct ctx)
- Valid reply: exact value, by index "1"/"2"/"3"
- Case-insensitive: UPPERCASE, mixed-case, whitespace-padded values and indices
- Invalid reply: stays pending, no messageHandler call, accepts valid after invalid, out-of-range indices ignored
- Abort signal: pre-aborted, mid-wait, no double-resolve
- No-options edge case: resolves `''` instantly, no message sent (with and without signal)
- onMessage interaction: routes normally when no prompt pending; does not fire for matched prompt reply

**Public signature (stable — unchanged):**
```typescript
async promptUser(
  ctx: ChannelContext,
  question: string,
  options: readonly PromptOption[],
  signal?: AbortSignal,
): Promise<string>
```

---

### Review Cycle 1 — B + C fixes in formatting.ts (2026-06-11, commit 674ee11)

**Finding B (BLOCKING — XSS, link scheme allowlist):**
Added `isSafeUrl()` helper. URL scheme extracted by trimming leading whitespace (`trimStart()`), finding the first `:`, and testing the scheme against `/^(https?|mailto|tel)$/i`. Allowed schemes: `http`, `https`, `mailto`, `tel` (case-insensitive). Disallowed schemes (javascript:, data:, vbscript:, and bypasses like leading spaces or mixed case) cause the link to render as plain escaped text — no `<a>` element is emitted. Embedded non-letter chars in the scheme prevent allowlist match naturally.

**Finding C (important — italic word-boundary guard):**
Added `isWordChar()` helper (`/\w/.test(ch)`). Single `*` and `_` italic only fires when: (1) the char immediately BEFORE the opening marker is not `\w` (or is absent), AND (2) the char immediately AFTER the closing marker is not `\w` (or is absent). `snake_case_var`, `TEAMS_CLIENT_ID`, `a_b_c` are now literal. `_italic_` and `*italic*` as standalone words still produce `<i>`. `**bold**` / `__bold__` are unaffected (handled in the `**`/`__` branch before single-marker code is reached).

---

### PR #12 Copilot review — href and isSafeUrl must use the same trimmed URL (2026-06-11)

`isSafeUrl` internally trimmed the raw URL before scheme extraction, but the emitted `href` used the untrimmed `rawUrl`. A link like `[x]( https://example.com)` passed the allowlist check but produced `href=" https://example.com"` (leading space). Fix: trim once at the call site (`text.slice(...).trim()`), then pass the trimmed value to both `isSafeUrl` and `escapeHtmlAttr`. The validated scheme and the emitted href now always refer to the identical string.