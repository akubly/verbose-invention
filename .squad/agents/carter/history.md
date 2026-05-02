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
