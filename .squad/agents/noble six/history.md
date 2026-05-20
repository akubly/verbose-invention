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

### 2026-05-19 — Evolving a Locked Architecture on Spike Evidence

**Pattern:** A LOCKED architectural proposal should be treated as a hypothesis, not a commitment. When a spike returns evidence that changes the feasibility picture, the correct response is a formal revision — not an ad-hoc patch.

**What I did:**
1. Re-evaluated the LOCKED Phase 6 against two new inputs: Carter's spike (attach blocked by port-discovery gap) and Carter's follow-up (extension API viable, gap eliminated).
2. Steelmanned both options (defer attach vs. extension bridge) with explicit trade-off dimensions: install footprint, upgrade story, failure modes, security surface, value delivered.
3. Produced a revised proposal that supersedes the LOCKED version, preserving carried-forward decisions (1–5) and adding new ones (6–10) + 4 ADRs.
4. Called out team-member scope deltas explicitly so downstream agents know what changed for them.

**Key learning:** The "LOCKED" label means "this was our best design given what we knew." It does not mean "don't revisit." When new evidence arrives, the architect's job is to update the design formally, not to defend the prior version. The revision should make the evidence chain visible: what changed, why the old design no longer holds, and what the new design gains.

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

### 2026-05-04 — Phase 6 Requirements & Proposal

**Trigger:** Aaron's dogfooding revealed cwd/branch-binding limitation. He proposed /afk /back commands. I analyzed his actual session data (30 days) to derive real requirements.

**Requirements identified from session data:**
1. Multi-repo routing (15 repos in active rotation, not 1)
2. Branch safety (concurrent sessions on same repo, different branches)
3. Resume-primary mode (sessions live 13–37 hours, some 16 days; resume is the norm)
4. Idle-then-mobile (40+ turn-pairs with >2hr gaps in 14 days)
5. Concurrent sessions (2–4 simultaneous sessions across repos)
6. Desktop remains primary (Telegram is the remote terminal, not the birthplace)

**Recommended approach: Option C — Hybrid Broker + /afk overlay.**
- Reach discovers existing desktop CLI sessions and exposes them as Telegram topics
- Topics are durable viewports into sessions, not session factories
- /afk is optional UX sugar, not load-bearing architecture
- Desktop activity auto-reclaims relay (no explicit /back required)

**Trade-off accepted:** Building session discovery before confirming SDK supports listing sessions. Fallback (breadcrumb files) is cheap and architecture-identical.

**Trade-off rejected:** IPC-to-CLI approach (Option A). Requires modifying software we don't own; breaks when CLI crashes.

**MVP scope:** Registry gains per-session cwd/branch, new discovery module, /attach command, factory accepts per-session cwd. No /afk in MVP.

**Proposal filed:** `.squad/decisions/inbox/noble six-phase6-proposal.md`

### 2026-05-09 — Phase 6 Spike Complete (Carter)

**Spike status:** Days 1–2 complete. Q1 SOLVED ✅. Q2 BLOCKED ⚠️.

**Technical outcomes:**
- **Q1 Discovery:** SDK `client.listSessions()` API is real, works today, returns all sessions from shared disk store. HIGH confidence.
- **Q2 Attach:** Blocked on port breadcrumb gap. True bidirectional attach requires CLI in `--ui-server` mode; no mechanism writes port to disk today.

**Three attach paths evaluated:**
- **Path A (config-based):** Aaron sets `REACH_CLI_SERVER_URL` in config + launches CLI with matching `--ui-server --port`. Simplest for MVP. Requires Aaron coordination.
- **Path B (breadcrumb wrapper):** Wrapper script writes port to `~/.copilot/reach-server.json`. Cleaner long-term; needs adoption.
- **Path C (PID → port lookup):** Automatic; Windows-only + fragile (relies on lock file presence + TCP scan).

**Carter's recommendation:** MVP ships `/list` + `/new` only (drop `/attach`). Attach-to-live deferred as Phase 6 stretch item with Path A (config-based) if needed.

**Aaron's decision gate:** Which scope for Phase 6 MVP?
1. **Option 1:** Drop `/attach` to live sessions (cleanest MVP)
2. **Option 2:** Ship `/attach` with Path A (config-based port)
3. **Option 3:** Ship `/attach` with Path C (PID → port auto-discovery, Windows-only)

**Next:** Kat, Jun, Noble Six await Aaron's scope decision before implementation begins.

### 2026-05-09 — Phase 6 Spike Follow-Up (Extension API Viability)

**Spike status:** COMPLETE. New discovery: extension API viability confirmed.

**Carter's findings:**
- **Extension API CONFIRMED:** `@github/copilot-sdk@0.2.2` exports `joinSession()`, `session.send()`, `session.on()`. Production-ready.
- **Architecture:** Extension runs as forked Node child of CLI with full network access via JSON-RPC/stdio. No `--ui-server` port-discovery gap.
- **Capability:** Can inject prompts, stream events, register slash commands, async background work, full network access.
- **Attach bridge:** Bidirectional `/attach` to live desktop sessions becomes possible with extension bridge (extension opens named pipe/loopback socket to daemon).
- **Setup:** Single install to user extensions dir; can be automated in `reach install`.
- **Effort:** ~2 days on top of Option 1 (MVP).

**NEW OPTION B for Aaron's decision:**
- **Option A (Original MVP):** `/list` + `/new` only. Clean MVP. No extension bridge.
- **Option B (Extended MVP):** `/list` + `/new` + `/attach` via extension bridge. Full bidirectional attach. ~2 day add-on.

**Phase 6 plan likely shifts toward extension-based architecture if Aaron chooses Option B.** Design enables true session bridging without polling or breadcrumb fragility.

**Decision gate for Aaron:** Option A (MVP, defer extension work), or Option B (extended MVP with `/attach` via extension)?

**Recommendation:** Option A for MVP, Option B as first post-MVP feature. Cleaner separation; extension approach is solid but adds implementation surface.

**Files produced:** 
- Decision merged to `.squad/decisions.md`
- Orchestration log: `.squad/orchestration-log/2026-05-09T07-40-08Z-carter.md`
- Session log: `.squad/log/2026-05-09T07-40-08Z-cli-extension-bridge.md`
- New skill: `.squad/skills/sdk-extension-introspection/SKILL.md` (for future extension work)
- Updated `.squad/agents/carter/history.md`

### 2026-05-19 — Phase 6 Revised: Extension-Bridge Architecture

**Trigger:** Aaron requested revision of LOCKED Phase 6 proposal based on Carter's spike + extension-bridge findings.

**Decision made:** Extension-bridge is the right architectural call for Phase 6 MVP. Ship `/list` + `/new` + `/attach` via CLI extension, not the spike's Option 1 (defer `/attach`).

**Rationale:**
1. Aaron's session data shows resume-existing is the dominant use case (80%+). A factory-only MVP misses the primary value.
2. Extension-bridge is structurally simpler than port-discovery alternatives — push-based registration, no polling, no breadcrumb files.
3. SDK coupling risk is bounded: `joinSession()` is documented API in 0.2.2, extension is <100 LOC, pin-and-adapt strategy if 0.3.x breaks it.
4. Incremental effort (~2 days) is small relative to the value delta.

**Key architectural additions over LOCKED design:**
- Named pipe server (`\\.\pipe\reach-bridge`) for extension↔daemon IPC
- Push-based discovery (extension registers on startup) replaces poll-based
- `extension.mjs` as new install artifact, deployed by `reach install`
- 4 ADRs identified for locking before implementation

**Team impact:**
- Carter: Primary deliverable shifts from "spike then refactor" to extension bridge + named pipe + relay integration
- Kat: Gains `/attach` command handler + `install.ts` extension deployment
- Jun: Test surface expands to cover bridge protocol, registration lifecycle, pipe failure modes

**Proposal filed:** `.squad/decisions/inbox/noble six-phase6-revised.md`

### 2026-05-19 — Phase 6 ADRs Locked

**Trigger:** Aaron chose Option B (extension bridge) and resolved all three of Jun's architectural blockers via directive.

**What I delivered:**
- 7 ADRs finalized and ACCEPTED (ADR-1 through ADR-7)
- ADRs 1–4: Extension API, push-based discovery, single multiplexed pipe, crash = unreachable (carried from revised proposal, now formalized with full Context/Decision/Consequences)
- ADR-5: Daemon runs as logged-in user, not LocalSystem. Aaron's decision. This was the simplest blocker resolution — single-user-per-host scope eliminated the cross-integrity-level pipe security problem (EC-06) entirely. Also fixes the existing `LookupAccountName failed: 1332` bug.
- ADR-6: Exponential backoff reconnect (1s base, 2× factor, 300s ceiling, never give up). Resolves EC-02.
- ADR-7: Dual heartbeat — pipe teardown (fast path, <1s) + ping/pong (slow path, ≤50s worst case). Resolves EC-03.
- Routed Day 1 parallel tasks: Carter (pipe server skeleton), Kat (install.ts refactor), Jun (test doubles).

**Key insight:** Aaron's single-user scope decision simplified everything. Once the daemon runs as the logged-in user, three problems collapse into one solved problem: pipe security (same user = same integrity level), session scoping (daemon naturally sees only that user's sessions), and the install.ts bug (real user account, not LocalSystem). This is the kind of architectural simplification that comes from constraining scope correctly.

**Decision filed:** `.squad/decisions/inbox/noble six-phase6-locked.md`

---
