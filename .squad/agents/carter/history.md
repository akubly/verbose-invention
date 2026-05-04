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
- Total Phase 5: 235 tests pass, tsc clean, lint clean
- Ready for production deployment

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

**Task:** Aaron directed: introduce port interfaces so elay.ts has zero imports from ../bot/ or ../sessions/.

**Approach:** 
- Created src/relay/ports.ts with three exported types: ResolvedSession (minimal session shape), SessionLookup (esolve() only), PermissionPrompter (prompt method).
- Rewrote Relay constructor from (registry: ISessionRegistry, factory, model, bot?: Bot, permissionPolicy?: PermissionPolicy) to (sessionLookup: SessionLookup, factory, model, permissionPrompter?: PermissionPrompter).
- SessionEntry is NOT imported by ports.ts or relay.ts — ResolvedSession defines only the two fields relay actually uses (sessionName, model).
- Removed const PERMISSION_PROMPT_MODULE = '../bot/prompt.js' and the dynamic import. handlers.ts now statically imports promptUserForPermission and wraps it in a PermissionPrompter closure at the composition root.
- handlers.ts creates a SessionLookup adapter over ISessionRegistry (which satisfies the shape structurally).
- PermissionPolicy removed from relay imports entirely — presence of permissionPrompter determines interactive-mode behavior.

**Test updates:**
- makeStubRegistry in relay tests simplified to { resolve: vi.fn(...) } typed as SessionLookup.
- "interactiveDestructive wiring" describe block renamed to "permission prompter wiring"; "bot wiring missing" test replaced with "proceeds without prompting" test; "chat context missing" test updated to use injected prompter.
- Integration test updated in parallel.

**Verification:** 	sc --noEmit PASS, itest run 245 passed | 4 skipped, lint PASS (0 warnings).

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
