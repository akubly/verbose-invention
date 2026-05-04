# Carter — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Bridge Dev
- **Joined:** 2026-04-12T06:02:10.440Z

## Current Phase: Phase 5 — Telegram UX QoL (2026-05-01–2026-05-02)

### What I've Delivered

**Wave 1: MarkdownV2 Parse Mode Upgrade**
- New module: `src/relay/markdownV2.ts`
- Escape strategy: escape-only (no AST parsing)
- Special chars escaped (18 + backslash): `_ * [ ] ( ) ~ ` > # + - = | { } . ! \`
- Code region protection: only `\` and `` ` `` inside code spans/blocks
- Relay integration: `safeEdit()` fallback chain (MarkdownV2 → plain text)
- Per-session logging to avoid spam on persistent formatting issues
- Test coverage: 22 new unit tests, all GREEN ✅

**Wave 2: Message Splitting (Telegram 4096-char Limit)**
- New module: `src/relay/messageSplitter.ts`
- Function: `splitForTelegram(text, opts?)` with boundary preferences
- Boundary order: `\n\n` > `\n` > whitespace > hard cut
- Code block protection: never split mid-block, re-open/close fences on sub-chunks
- Spanning block detection: explicit handling when block crosses chunk boundaries
- Multi-chunk delivery: first chunk via `safeEdit()`, rest via `ctx.reply()` with 100ms delay
- Two-pass numbering: `[n/total]\n` prefix only when total > 1
- Footer overhead: reserved from last chunk budget
- Test coverage: 21 new unit tests, all GREEN ✅

### Key Design Patterns

1. **Escape-only strategy** — No Markdown AST parsing; covers 95% of Copilot output
2. **Mid-stream plain text** — Partial output with unclosed fences would fail MarkdownV2 parsing; only final edit uses V2
3. **Boundary semantics** — Preserves reading units (paragraphs preferred, then lines, then words)
4. **Code safety** — Balanced fences on every chunk, language tags preserved across splits
5. **Footer integration** — Passed without `\n\n`; module adds separator internally
6. **Rate limiting** — 100ms delay between chunk sends stays within Telegram's ~30 msg/s limit

### Current Status

- Wave 1 complete: MarkdownV2 escaping live and tested
- Wave 2 complete: Message splitting live and tested
- PR #5 review fixes complete (F-A, F-D, F-E + re-review F-D chained)
- Total Phase 5: 263 tests pass, lint clean
- Pushed to `user/aaron/phase5-telegram-ux`

## Phase 5 PR #5 Cycle 3 Review Fix (2026-05-03)

**G-B: Truncation marker not budgeted for footer/prefix (messageSplitter.ts:95)**
- Root cause: `TRUNCATION_MARKER` was appended raw as the last chunk during maxChunks capping.
  Footer (`\n\n` + footer text) and numbering prefix (`[N/N]\n`) were then layered on top.
  For tight `maxLen` values, the final chunk could exceed the advertised limit.
- **Fix:** Added `MIN_TRUNCATION_MARKER = '_(truncated)_'` constant. When applying the maxChunks
  cap, compute `available = effectiveMax - markerPrefixLen - footerOverhead`. Select:
  - Full marker if `available >= TRUNCATION_MARKER.length`
  - Minimum marker if `available >= MIN_TRUNCATION_MARKER.length`
  - Throw `Error("maxLen too small...")` if neither fits (defensive; requires absurdly small maxLen)
- Prefix computed worst-case as `[${maxChunks}/${maxChunks}]\n`.length (only when numbering).
- New tests (4): full marker fits with tight maxLen+footer+numbering; minimum marker fallback;
  throw branch; final chunk length ≤ maxLen assertion.
- Total: 267 tests pass (264 new passing vs 263 baseline + 4 new splitter tests), lint clean.
- Commit: `d0f82f5` — pushed to `user/aaron/phase5-telegram-ux`.



Chained issue caught in Copilot re-review of PR #5 F-D fix:

**F-D (re-review): Stale `[n/total]` and missing footer on capped responses**
- Root cause: the post-split cap in relay.ts sliced chunks AFTER `splitForTelegram` had
  already composed `[n/26]` prefixes and appended the footer to the (now-dropped) last chunk.
  Result: users saw `[1/26]…[24/26]` (stale totals) + a bare truncation marker (no footer).
- **Fix:** Added `maxChunks?: number` to `SplitOptions` in `messageSplitter.ts`. When set,
  the cap is applied inside `splitForTelegram` AFTER the two-pass split but BEFORE
  numbering/footer composition: raw chunks are trimmed to `maxChunks-1` + truncation marker,
  then numbered with `[n/maxChunks]` totals, then footer appended to the (truncation) last chunk.
- Relay now passes `maxChunks: MAX_CHUNKS` directly; post-split slice/append removed.
- New splitter tests: 6 covering `maxChunks` (no-op when under limit, exact count, marker,
  consistent numbering, footer on marker, no footer on earlier chunks).
- Decision appended: `.squad/decisions/inbox/carter-pr5-review-fixes.md`

## Phase 5 PR #5 Copilot Review Fixes (2026-05-03)

Three findings from Copilot review of PR #5, all addressed:

**F-A: MarkdownV2 budget (relay.ts:20)**
- `MARKDOWN_ESCAPE_RESERVE_BYTES = 1229` was insufficient: a 2867-char all-specials chunk
  escapes to ~5734 chars, blowing Telegram's 4096 limit.
- **Fix:** Replaced with `MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048` (= 4096 ÷ 2 worst-case ratio).
- Renamed `reserveBytes` → `effectiveMaxLen` in `SplitOptions` for cleaner caller API.
- Decision file: `.squad/decisions/inbox/carter-pr5-review-fixes.md`

**F-D: Chunk cap off-by-one (relay.ts:137)**
- Old: `slice(0, MAX_CHUNKS)` + marker = 26 chunks total (1 over cap).
- **Fix:** `slice(0, MAX_CHUNKS - 1)` + marker = exactly 25 chunks total.

**F-E: First-chunk failure leaves orphaned follow-ups (relay.ts:155)**
- `safeEdit()` returned `void` and swallowed errors; loop continued sending chunks 2..N.
- **Fix:** `safeEdit` returns `Promise<boolean>`; on `firstOk === false`, abort follow-up loop
  and best-effort update placeholder with `_(failed to render reply — see logs)_`.

## Recent Learnings (Active)

### 2026-05-01 — Phase 5 Wave 1: MarkdownV2 Upgrade

Replaced legacy `parse_mode: 'Markdown'` with `parse_mode: 'MarkdownV2'` in `safeEdit()`.

**Implementation highlights:**
- Walks text identifying code spans (`` `...` ``) and blocks (` ``` ... ``` `)
- Escapes only backslash and backtick inside code
- Escapes 18 MarkdownV2 special chars + backslash in plain-text regions
- Unclosed fences handled defensively: treated as plain text and fully escaped
- Per-session fallback logging (Set<string>) prevents spam

**Fallback chain:** MarkdownV2 → plain text (legacy Markdown removed)

**Test integration:** Carter's 22 base tests + Jun's 3 real-world Copilot output tests (code review, HUD footer, mixed identifiers)

### 2026-05-01 — Phase 5 Wave 2: Message Splitting

Implemented `splitForTelegram` in `src/relay/messageSplitter.ts` and wired multi-chunk delivery.

**Core algorithm:**
- `doSplit(text, maxLen, lastBudget)` — main splitting loop
- `parseCodeBlocks(text)` — identifies all ` ```lang...``` ` ranges
- `findBestSplit(text, maxBudget)` — applies boundary preference order
- `splitCodeBlock(lang, innerLines, maxLen)` — packs lines with balanced fences
- Two-pass numbering: split first, count total, prepend prefix only if total > 1

**Relay integration:**
- Final edit: calls `splitForTelegram(body, { footer })`
- First chunk: `safeEdit()` replaces placeholder
- Subsequent chunks: `safeSend()` via `ctx.reply()` with `message_thread_id`
- Delay: 100ms between sends (rate limit safety)

**Contract locked:** `splitForTelegram(text, opts?: SplitOptions): string[]`

### 2026-05-02 — Phase 5 Complete (Team Update by Scribe)

Phase 5 complete. All decisions merged to `decisions.md`; inbox cleared. 235 tests pass, tsc clean, lint clean.

**Carter's Wave 1 & 2 completion:**
- MarkdownV2 escaping: 22 tests GREEN, integration solid
- Message splitting: 21 tests GREEN, multi-chunk delivery seamless
- Both features coordinate: V2 length affects split points; no relay logic breaks

**Team coordination:** MarkdownV2 (Wave 1) enables accurate split calculations for Wave 2. `/resume` (Kat) runs independent. All features tested and ready.

**Next:** Production deployment. Monitor MarkdownV2 edge cases; fallback in place. Future: `/model` command.

## Archive

Earlier work (before 2026-05-01) is archived in `history-archive.md` for reference.

### 2026-05-02 — Phase 5 Review Triage (6-Persona Panel Fixes)

Triage round from 6-persona panel review. Addressed 10 findings (ACCEPTED), escalated 1 (F7), rejected 0.

**F1 — Numbering prefix overflow (BLOCKING → FIXED)**
Root cause: `splitForTelegram` added `[n/total]\n` AFTER splitting, meaning numbered chunks could exceed 4096.
Fix: two-pass algorithm in `splitForTelegram`. Preliminary split determines if numbering is needed; if yes, re-split with `[total/total]\n` prefix length subtracted from `effectiveMax`. Converges in ≤3 iterations (digit-count changes only at 10/100/1000 chunks).

**F4 — Escape expansion overflows budget (IMPORTANT → FIXED)**
Root cause: Splitter budgeted on raw text length; MarkdownV2 escaping adds ~5-10% (up to ~100% for degenerate text), pushing escaped chunks past 4096.
Fix: Added `reserveBytes?: number` to `SplitOptions`. In relay, pass `MARKDOWN_ESCAPE_RESERVE_BYTES = 1229` (~30% of 4096). `effectiveMax = maxLen - reserveBytes` is used for all split boundaries.

**F5 — Numbering not enabled (IMPORTANT → FIXED)**
Simple: Added `numbering: true` to the `splitForTelegram` call in relay.ts. F1 fix was landed first.

**F6 — MarkdownV2 fallback over-catches (IMPORTANT → FIXED)**
Added `isParseEntitiesError(err)` function. Only falls back to plain text when `err.message` contains `"can't parse entities"` or `"parse entities"`. Network/429/permission errors now rethrow to the outer handler.

**F7 — Layering violation (IMPORTANT → ESCALATED)**
relay.ts imports from `../bot/prompt.js` and `../sessions/registry.js`. Escalated to coordinator — may be intentional design (dynamic import for prompt, interface boundary for registry). Not touched.

**F8 — safeEdit/safeSend duplication (IMPORTANT → FIXED)**
Extracted `private async withMarkdownFallback(sessionLabel, tryMd, fallback)` helper. Both `safeEdit` and `safeSend` are now thin wrappers calling it. The helper owns the try/catch and `md2WarnedSessions` gate.

**F9 — Chunk failure log omits index (IMPORTANT → FIXED)**
`safeSend` now returns `Promise<boolean>` (success/failure). Loop tracks `failedChunks` count. Each `safeSend` call receives `chunkNumber` and `totalChunks`. Log: `[relay] reply failed (topic=42, chunk=2/3)`. Summary warn at end: `[relay] N of M chunks failed — response may be truncated for topic X`.

**F10 — Unbounded accumulated stream (IMPORTANT → FIXED)**
Added `MAX_ACCUMULATED_BYTES = 100_000` cap in stream loop with truncation message. Added `MAX_CHUNKS = 25` post-split cap; excess chunks replaced with `_(response truncated — too many chunks)_`.

**F11 — Overlong code line in splitCodeBlock (IMPORTANT → FIXED)**
Added `lineCapacity = maxLen - overhead` guard. Lines exceeding capacity are hard-cut into `Math.ceil(line.length / lineCapacity)` segments via `Array.from`. Each segment then goes through normal group-packing logic.

---

## PR #5 Cycle 4 — 2026-05-03

### H-C Finding: advancePast() drops separator newline after code blocks (FIXED)

**Bug:** `advancePast()` consumed the `\n` immediately following a closing ` ``` ` fence. When a code block was followed by normal text, that separator newline was eaten, causing the next chunk to start with the text directly stuck to the closing fence with no blank line — breaking Markdown paragraph structure.

**Root cause:** The original implementation was `blockEnd < text.length && text[blockEnd] === '\n' ? blockEnd + 1 : blockEnd` — it explicitly skipped one character past the fence if it was a newline.

**Fix:** Simplified `advancePast()` to `return blockEnd` — advance exactly to `block.end` (past the ` ``` `) and leave all subsequent whitespace/newlines for the normal paragraph splitter to handle.

**Test added:** Regression test verifies `'some text\n\n\`\`\`js\nconst x = 1;\n\`\`\`\nmore text'` preserves the newline between the fence and `more text`.

**Results:** 268 tests pass (267 prior + 1 new), tsc clean, lint clean. Commit `1c3261e`.


**F12 — Code-block detector mis-pairs fences (MINOR → FIXED)**
Added odd-fence count check at end of `escapeMarkdownV2`. If `(result.match(/```/g) ?? []).length % 2 !== 0`, return `escapePlain(text)` immediately.

**F13 — needsEscaping JSDoc (MINOR → FIXED)**
Added `/** Utility for callers that want to skip escaping overhead on clean text. Currently used in tests only. */` above the export.

**Test results:** 245 passed | 4 skipped. tsc clean. lint clean.

**Key design choices:**
- F1: Used iterative (≤3 passes) rather than worst-case (8-char flat reserve) — exact prefix per actual chunk count, avoids wasting budget.
- F4: Chose option (b) — `reserveBytes` headroom — over option (a) split-after-escape. Reason: option (a) requires coupling the splitter to escape format (avoiding mid-escape splits), whereas option (b) is a simple parameter. 30% headroom (1229 bytes) handles even pathological all-special-char inputs up to ~2867 chars raw.
- F6: Chose message-based detection (`includes("can't parse entities")`) rather than importing GrammY's `GrammyError` class, avoiding a new type dependency in the relay.
- F10: DoS guards are sized conservatively: 100KB stream cap, 25 chunk cap. These are invisible to normal usage (typical Copilot responses are 1-10KB).


## F7 Refactor: Port injection for relay layer (session N+1)

**Task:** Aaron directed: introduce port interfaces so elay.ts has zero imports from ../bot/ or ../sessions/.

**Approach:** 
- Created src/relay/ports.ts with three exported types: ResolvedSession (minimal session shape), SessionLookup (esolve() only), PermissionPrompter (prompt method).
- Rewrote Relay constructor from (registry: ISessionRegistry, factory, model, bot?: Bot, permissionPolicy?: PermissionPolicy) to (sessionLookup: SessionLookup, factory, model, permissionPrompter?: PermissionPrompter).
- SessionEntry is NOT imported by ports.ts or relay.ts — ResolvedSession defines only the two fields relay actually uses (sessionName, model).
- Removed const PERMISSION_PROMPT_MODULE = '../bot/prompt.js' and the dynamic import. handlers.ts now statically imports promptUserForPermission and wraps it in a PermissionPrompter closure at the composition root.
- handlers.ts creates a SessionLookup adapter over ISessionRegistry (which satisfies the shape structurally).
- PermissionPolicy removed from relay imports entirely — presence of permissionPrompter determines interactive-mode behavior.

**Test updates:**
- makeStubRegistry in relay tests simplified to { resolve: vi.fn(...) } typed as SessionLookup.
- "interactiveDestructive wiring" describe block renamed to "permission prompter wiring"; "bot wiring missing" test replaced with "proceeds without prompting" test; "chat context missing" test updated to use injected prompter.
- Integration test updated in parallel.

**Verification:** 	sc --noEmit PASS, itest run 245 passed | 4 skipped, lint PASS (0 warnings).

**Key lessons:**
- The PermissionPolicy concept belongs at the composition root, not in the relay. The relay should not know about policy names — it just receives a prompter or it doesn't.
- Static import in handlers.ts vs dynamic import in relay.ts: dynamic import was originally used to avoid loading bot modules in non-interactive contexts. After injection, the static import in handlers.ts is fine — handlers already lives in the bot layer.
- ResolvedSession vs re-exporting SessionEntry: define only what the relay needs. This insulates relay from future additions to SessionEntry (like chatId, createdAt).

---

## Phase 5 Persona Review Resolution (2026-05-02)

**Persona Panel Results:**
- correctness: 2 findings (F1 technical correctness, F2 numbering logic) → ACCEPT
- skeptic: 3 findings (F4 escape tradeoff, F6 error detection, F7 layering) → ACCEPT F4/F6, ESCALATE F7
- craft: 4 findings (F8 duplication, F9 logging, F11 hard-cut, F13 JSDoc) → ACCEPT
- compliance: 2 findings (F5 numbering flag, F10 stream guard) → ACCEPT
- security: 2 findings (DoS surface analysis + caps) → ACCEPT
- architect: F7 critical escalation (relay→bot/sessions imports)

**Carter Triage Disposition (11 findings):**
- F1: ACCEPT + implement iterative prefix reservation
- F4: ACCEPT + headroom reserve (30% = 1229 bytes)
- F5: ACCEPT + enable numbering flag
- F6: ACCEPT + implement isParseEntitiesError guard
- F7: ESCALATE → introduced ports.ts (SessionLookup, PermissionPrompter)
- F8: ACCEPT + extract withMarkdownFallback helper
- F9: ACCEPT + track chunk failures by index
- F10: ACCEPT + 100KB cap + 25-chunk DoS guard
- F11: ACCEPT + lineCapacity hard-cut
- F12: ACCEPT + odd-fence defensive check
- F13: ACCEPT + JSDoc on needsEscaping

**F7 Resolution:** ports.ts abstraction eliminates all cross-layer imports. relay.ts now has zero imports from ../bot/ or ../sessions/. Composition root (handlers.ts) manages port injection.

**Verification:** 245 tests pass, tsc clean, lint clean.
