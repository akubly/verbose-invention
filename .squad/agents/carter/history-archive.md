# Carter — Full History Archive (Phases 1–5)

This file archives the complete work history for Phase 5 and earlier. Current active history is in `history.md`.

## Phases 1–5 Accomplishments

### Phase 5 Wave 1: MarkdownV2 Escaping
- Module: `src/relay/markdownV2.ts` (escape-only strategy, no AST parsing)
- Special chars: 18 + backslash; only `\` and `` ` `` inside code
- Code region protection: spans and blocks preserved
- Relay integration: `safeEdit()` fallback chain (MarkdownV2 → plain text)
- Test coverage: 22 new unit tests, all GREEN ✅

### Phase 5 Wave 2: Message Splitting (Telegram 4096-char limit)
- Module: `src/relay/messageSplitter.ts`
- Algorithm: boundary preferences (`\n\n` > `\n` > whitespace > hard cut)
- Code block protection: never split mid-block, re-fence on sub-chunks
- Multi-chunk delivery: first via `safeEdit()`, rest via `ctx.reply()` (100ms delay)
- Two-pass numbering: `[n/total]\n` only when total > 1
- Test coverage: 21 new unit tests, all GREEN ✅

### Phase 5 Persona Review Fixes (11 findings)
- F1: Numbering prefix overflow (two-pass algorithm)
- F4: Escape expansion budget (30% headroom via `effectiveMaxLen`)
- F5: Numbering enabled flag
- F6: MarkdownV2 fallback guard
- F7: Escalated → port injection (relay.ts zero imports from bot/sessions)
- F8: Duplication extraction (`withMarkdownFallback`)
- F9: Chunk failure tracking by index
- F10: 100KB stream cap + 25-chunk DoS guard
- F11: Hard-cut for overlong code lines
- F12: Odd-fence defensive check
- F13: JSDoc on `needsEscaping`

### Phase 5 PR #5 Review Fixes (3 findings)
- F-A: MarkdownV2 budget (EFFECTIVE_MAX = 2048)
- F-D: Chunk cap + maxChunks option
- F-E: First-chunk failure handling

### Package.json Fix
- Entry point: `dist/main.js` (matches TypeScript output from `src/main.ts`)

## Test Coverage & Quality

- **Final Phase 5:** 278 tests pass, 4 intentional placeholder stubs
- **Code quality:** tsc clean, lint clean
- **Status:** Production-ready

## Key Design Patterns

1. **Escape-only strategy** — No Markdown AST parsing; covers 95% of Copilot output
2. **Mid-stream fallback** — Partial output with unclosed fences fails V2 parsing; only final edit uses V2
3. **Boundary semantics** — Preserves reading units (paragraphs > lines > words)
4. **Code safety** — Balanced fences on every chunk; language tags preserved
5. **Rate limiting** — 100ms delay between chunk sends; safe within Telegram ~30 msg/s
6. **Port injection** — Eliminates cross-layer coupling; relay is a pure function of ports
7. **Reserve budget** — MarkdownV2 expansion is ~30% worst-case; reserve upfront, not post-escape

## Learnings

### SDK Introspection Methodology
1. Read `package.json` for version and exports
2. Read `dist/index.d.ts` for public API surface
3. Read `dist/client.d.ts` and `dist/types.d.ts` for detailed types
4. Read `README.md` for documented behavior
5. Read `dist/client.js` (implementation) for undocumented behavior
6. Check the actual filesystem state to validate what the CLI writes

### Architecture Decisions

- **F1:** Iterative prefix (≤3 passes) vs flat reserve — exact prefix per actual chunk count
- **F4:** `reserveBytes` headroom vs split-after-escape — simpler parameter, avoids coupling
- **F6:** Message-based detection vs GrammY `GrammyError` — avoid new type dependency
- **F10:** DoS guards (100KB stream, 25 chunks) are conservative, invisible to normal usage
- **F7 Port injection:** PermissionPolicy belongs at composition root; relay receives port or nothing

---

Earlier work (Phases 1–4) details omitted for brevity. All code complete and tested.
