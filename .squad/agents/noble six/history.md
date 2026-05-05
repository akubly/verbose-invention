# Noble Six — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Lead / Architect
- **Joined:** 2026-04-12T06:02:10.439Z

## Current Phase: Phase 5 — Telegram UX QoL Scoping & Prioritization (2026-05-01)

### What I Delivered

**Phase 5 Scope Definition** (`decisions.md`):

1. **Message Splitting** — Telegram's 4096-char limit handling with semantic boundary preservation
   - Boundary preference: `\n\n` > `\n` > whitespace > hard cut
   - Code block protection: never split mid-block, re-open/close fences on sub-chunks
   - Multi-chunk delivery: first via edit, rest via reply with 100ms delay

2. **MarkdownV2 Parse Mode** — Legacy Markdown upgrade
   - Escape-only strategy (no AST parsing): 18 special chars + `\` in plain text
   - Code region protection: only `\` and `` ` `` escaped inside code
   - Plain-text fallback on rejection

3. **/resume <name> Command** — Session mobility
   - Move semantics: unbind old topic, bind to new
   - Registry enhancement: `findByName()` for reverse lookup
   - Model carry-forward from original entry

### Dependency Analysis & Wave Sequencing

**Dependency Graph:**
```
MarkdownV2 ──┐
             ├─ Integration (relay.ts)
Splitting   ──┘
/resume     ─── Independent (handlers.ts + registry.ts)
```

**Rationale:** MarkdownV2 before splitting because escaping changes text length; splitting must account for post-escape length.

**Recommended Sequencing:**
- Wave 1 (parallel): MarkdownV2 (Carter) + /resume (Kat)
- Wave 2 (after V2): Message Splitting (Carter, depends on V2 length calculations)
- Tests: Jun writes all three test suites in parallel (pure functions + TDD)

### Aaron's 6 Open Questions (ANSWERED)

| Q | Answer | Implementation |
|---|--------|-----------------|
| Chunk numbering `[n/total]`? | No | Two-pass omits on single-chunk; never `[1/1]` |
| Max chunks cap? | 10 chunks, truncate | Acceptable (typical responses shorter) |
| Max chunks cap? | 25 chunks, truncate | Acceptable (DoS-guard hard cap in relay) |
| HTML fallback? | No | MarkdownV2 → plain text only |
| Accept degradation? | Yes | Fallback chain allows graceful fallback |
| `/resume` move semantics? | Option A (move) | Unbind old, bind new; SDK cache handles stale |
| `/resume --model`? | Defer | Model carried forward, no override flag |

### Current Status

- Scope locked and documented in `decisions.md`
- All 4 decisions inbox files merged
- Inbox cleared
- Wave 1 & 2 agents (Carter, Kat, Jun) ready to execute

## Recent Learnings (Active)

### 2026-05-01 — Phase 5: Scope Design & Coordination

Delivered comprehensive phase scope covering three interconnected UX features:

**Design decisions made:**
1. Wave sequencing based on dependency analysis
2. Move semantics for `/resume` (simpler invariant: 1 session = 1 topic always)
3. Escape-only strategy for MarkdownV2 (covers 95% of real output, avoids AST brittleness)
4. Boundary preference ordering (preserves semantic structure)

**Coordination patterns:**
- Scoped multiple agents in parallel (Carter Waves 1&2, Kat, Jun)
- Locked contracts early (test-first approach)
- Documented all edge cases and risk mitigations

### 2026-05-02 — Phase 5 Complete (Team Update by Scribe)

Phase 5 complete. All decisions merged to `decisions.md`; inbox cleared. 235 tests pass, tsc clean, lint clean.

**Noble Six's contributions:**
- Scoped and prioritized Phase 5 (3 UX improvements)
- Analyzed dependencies and recommended wave sequencing
- Answered 6 of Aaron's open questions
- All scope decisions successfully applied by implementation agents

**Team coordination:** Wave-based execution enabled parallel work (Wave 1: MarkdownV2 + /resume); Wave 2 (message splitting) built on Wave 1 foundations.

**Next phase:** Ready for production. Phase 5 UX improvements provide foundation for future features.

## Learnings

### 2026-05-04 — Dogfood Readiness Assessment

**Assessed by:** Noble Six  
**Trigger:** Aaron asked "What's left, or are we ready to dogfood?"

**Verdict: Ship it.** Reach is feature-complete and ready for personal use today.

**Evidence:**
- 278 tests pass (15 test files), 4 are intentional placeholder stubs — not gaps
- Clean tsc + ESLint
- Full command surface functional: /new, /list, /remove, /resume, /help, /pair
- Windows Service install with auto-restart
- Message splitting + MarkdownV2 + /resume all live in Phase 5

**Only gaps found (none blocking):**
1. No `/status`/`/ping` command — can't verify liveness from Telegram. Carter task, post-dogfood Week 1.
2. Phase 4 Wave 3 (operator runbook, logging polish) was never scoped. Real use will drive what actually matters.

**Architecture note:** Port injection (F7 from Carter's Phase 5 review) was applied — `relay.ts` has zero direct deps on `bot/` or `sessions/`. Layering is clean.

**Recommendation filed:** `.squad/decisions/inbox/noble six-dogfood-readiness.md`

---

## Archive

Earlier work (before 2026-05-01) is archived in `history-archive.md` for reference.

---

## Phase 6 Planning (Post-Dogfood)

**Noble Six's role:** Monitor dogfood feedback during Week 1–2. Convene team for Phase 6 scope definition based on real-world usage patterns.

**Watch areas:**
- MarkdownV2 fallback frequency (log: `[relay] MarkdownV2 rejected`)
- Session eviction timing (5-min default; may need tuning)
- Service stability (crash rate in Event Viewer)
