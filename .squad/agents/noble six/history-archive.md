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

### 2026-05-19 — Lock Wire Schemas Before Parallel-Spawning Implementer + Tester

**Pattern:** When two agents build both sides of a protocol in parallel (implementer + test-double author), the wire message shapes MUST be locked in the ADR before Day 1 begins — not just the transport framing (JSON-Lines, pipe path, max size).

**What happened:** ADR-3 locked the transport but left message shapes unspecified. Carter and Jun each designed reasonable but incompatible schemas. Carter's single-shot `session.command-result` would have destroyed the streaming UX that Phase 5 built. Jun's `inject`/`stream`/`requestId`/`chunk`/`done` preserved it.

**Root cause:** The ADR specified "what" (JSON-Lines, multiplexed by sessionId) but not "how" (exact type names, field sets, streaming vs. single-shot). When two agents fill that gap independently, they diverge.

**Rule for future phases:** Any protocol ADR that will be implemented by parallel agents must include a complete message catalog with type names, field names, and sample JSON for every message direction. If the catalog isn't ready, serialize the work: lock the schema first, then parallelize.

**Cost of the miss:** ~1 day of Carter migration work (8 changes across 2 files) + 1 ADR-8 reconciliation session. Caught before relay integration, so no cascading damage. But if this had been caught after Day 3–4 relay refactor, three files would have needed rework.

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

### 2026-05-19 — Phase 6 Day 1: Protocol Drift Reconciliation — ADR-8 Canonical Schema

**Trigger:** Carter and Jun completed Day 1 parallel implementation. Both shipped code; both passed all 296 tests. Protocol drift detected: 6 of 8 message types/fields differ.

**What I delivered:**
- **ADR-8: Canonical Pipe Wire Protocol** — Reconciled protocol drift via systematic analysis of each divergence
- **Decision:** Adopt Jun's streaming schema (\inject\/\stream\/\equestId\/\chunk\/\done\) as canonical
- **Rationale:** Streaming UX preservation (Phase 5 Telegram placeholder editing), request correlation (\equestId\), terminology consistency, forward compatibility
- **Consequences:** Carter has ~8 migration changes (Day 2); Jun has 1 addition; both pass full test suite post-migration

**Key technical insight:** ADR-3 locked framing (JSON-Lines, single pipe, multiplexed by sessionId) but left message shapes open. Both agents designed independently and converged on valid but divergent protocols. Early reconciliation via systematic comparison is the right move — fixing now is cheaper than after relay refactor when three code paths depend on the protocol.

**Routed Day 2 tasks:** Carter migration (~8 changes, ~2 hours); Jun addition (1 change, ~15 minutes); both run full 296-test suite. Days 3–4 relay integration.

**Decision filed:** \.squad/decisions.md\ (merged from 4 inbox files: carter-pipe-protocol.md, jun-test-doubles-contract.md, kat-service-host.md, noble-six-adr8-wire-protocol.md)



---

# Phase 1-6 (Archived 2026-05-28)

# Noble Six — History (Summarized 2026-05-19)

## Identity & Role

- **Agent:** Noble Six (Lead/Architect, Opus 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architecture, design decisions, protocol reconciliation, ADR documentation
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Day 1 Complete.** All 8 ADRs locked (ADRs 1–7 architectural + ADR-8 protocol reconciliation). Protocol drift reconciled. Day 2 migration tasks assigned.

**2026-05-24 Dogfooding Kickoff:** ADR-10 (pipe auth) finalized and merged into canonical decisions.md. Review 1 dispositions consolidated. Spawned background for dogfooding go-live checklist (Option A from now.md).

---

## Recent Context

### Phase 6 Architecture Decision (2026-05-09 to 2026-05-19)

**Spike Outcome (2026-05-09):**
Aaron chose Option B (extension-bridge) for Phase 6 MVP. This circumvents the port-discovery gap by using the Copilot CLI extension API (@github/copilot-sdk/extension) for push-based session registration over a named pipe.

**ADRs 1–7 Finalized (2026-05-19T22:13:42Z):**
- **ADR-1:** Copilot CLI Extension API for session attach (push-based registration, no port discovery)
- **ADR-2:** Push-based discovery with listSessions() fallback
- **ADR-3:** Single named pipe \\.\pipe\reach-bridge, JSON-Lines, multiplexed by sessionId
- **ADR-4:** Extension crash = session unreachable (no auto-recovery)
- **ADR-5:** Daemon runs as logged-in user (fixes LookupAccountName bug)
- **ADR-6:** Extension reconnect = exponential backoff
- **ADR-7:** Heartbeat = ping/pong (30s/5s/15s) + pipe-teardown detection

**Key Insight:** Aaron's single-user scope decision simplified three architectural problems into one: pipe security, session scoping, and install.ts bug all collapse when daemon runs as logged-in user.

### Phase 6 Day 1 Implementation (2026-05-19)

**Parallel Task Delivery:**
- **Carter:** src/bridge/extensionBridge.ts (pipe server), xtension.mjs (skeleton) — both compile, tests green
- **Jun:** 	ests/helpers/FakeDaemon.ts, FakeExtensionClient.ts, 15-test smoke suite — all green
- **Kat:** src/service/install.ts refactored to user-account install per ADR-5 — all 22 install tests green
- **Full test suite:** 296 passed, 4 skipped, 0 failed ✅

**Protocol Drift & ADR-8 Reconciliation:**
Carter and Jun independently designed different message protocols (both valid per ADR-3 framing spec). ADR-8 systematically reconciles:
- **Decision:** Adopt Jun's streaming schema as canonical (inject/stream/equestId/chunk/done)
- **Rationale:** 
  1. Preserves Phase 5 streaming UX (Telegram placeholder real-time edits at 800ms intervals)
  2. equestId correlation is critical for daemon-relay message routing
  3. Terminology consistency (Jun's hello aligns with ADR-2/ADR-6)
  4. Forward compatibility (retaining session.event for future event types)
- **Consequences:** Carter Day 2 migration (~8 changes), Jun Day 2 addition (1 type), both pass full test suite

---

## Key Design Principles

1. **Early reconciliation beats late refactor.** Detecting and resolving protocol drift on Day 1 is cheaper than discovering incompatibilities after the relay refactor depends on three code paths.

2. **Systematic comparison over gut calls.** Each of the 6 protocol divergences was analyzed independently (edge cases, performance impact, UX consequences, forward compatibility). The decision wasn't "streaming is better" — it was "streaming is required for Phase 5 UX AND request correlation AND self-describing messages AND forward compatibility."

3. **Constrain scope to simplify architecture.** Single-user scope (Aaron's decision) eliminated the need for cross-integrity-level pipe security tricks, multi-user session isolation, and install.ts account resolution complexity.

---

## Next Steps (Day 2+)

**Day 2:** Carter migration (~8 changes, ~2 hours) + Jun addition (1 change, ~15 min) + full test suite green

**Days 3–4:** Relay integration — ridge.on('stream', ...) feeds Telegram placeholder edits, equestId correlation for in-flight responses, 800ms throttle window applied unchanged

**Day 5+:** End-to-end testing, dogfooding, production readiness

---

---

## Phase 6 Day 2 (2026-05-20)

**Status:** ADR-8 operationalization complete. Protocol migration validated.

**Outcomes:**
- ✅ **Carter:** 8 mechanical migration changes (extensionBridge.ts + extension.mjs) → ADR-8 canonical schema
- ✅ **Jun:** SessionEventMessage type added to InboundMessage union (forward-compat)
- ✅ **Verification:** 296 passed / 4 skipped / 0 failed | tsc + lint clean
- ✅ **Decision records:** 2 inbox entries (sendCommand API, session.event shape) merged into decisions.md
- ✅ **Archive:** Old decisions (>7 days) purged from decisions.md; baseline preserved

**Key Insight:** Day 1 protocol reconciliation (ADR-8) proves out on Day 2 with zero regressions. All bridges now speak canonical schema. Ready for relay integration (Days 3–4).

---

## Learnings

**2026-05-22 — Protocol v3 uses fire-and-forget notifications for permission requests; there is no CLI-side clock ticking.**  
In Copilot SDK v3, the CLI dispatches `void this._executePermissionAndRespond(...)` — a fire-and-forget broadcast notification. No open JSON-RPC request is held on the CLI side. There is no RPC-level deadline for the daemon to beat. The SDK awaits `handlePendingPermissionRequest` asynchronously after the handler resolves, however long that takes. This is architecturally significant: v2 used `connection.onRequest` (synchronous RPC), which in theory could have a CLI-imposed RPC timeout. v3 eliminated that risk. When verifying SDK timeout behavior, the protocol dispatch pattern (notification vs. synchronous RPC) is the first thing to check.

**2026-05-22 — SDK regression check pattern: grep near the handler call site, not for a constant.**  
The absence of a `permissionTimeout` constant doesn't guarantee absence of a timeout — the timeout could be inlined. The correct check is: `grep -n "setTimeout\|Promise.race\|AbortController" session.js | grep -A2 -B2 "permissionHandler\|executePermissionAndRespond"`. If nothing matches near the handler invocation, no timeout exists. Carter's probe test (`tests/exploratory/sdk-permission-timeout.test.ts`) is the regression harness — run it against new SDK versions to catch any introduced timeout before it reaches production.

**2026-05-22 — No-timeout is architecturally valid for permission prompts; the timeout is a proxy for uncertainty, not a technical requirement.**  
A `permissionCallback` Promise that resolves in 3 days is semantically identical to one that resolves in 3 seconds — the SDK awaits both. During the wait: event loop runs, heartbeat fires, other sessions unaffected. The auto-deny-on-timeout failure mode (wrong decision made without the user) is worse than indefinite wait for async users. One concrete blocker: Copilot SDK's internal `onPermissionRequest` timeout, if any. `setTimeout(fn, Infinity)` fires immediately in Node.js (coercion to 0) — no-timeout requires removing the timer entirely, not passing Infinity. AbortSignal on disconnect (Q3) is mandatory infrastructure for no-timeout mode.

**2026-05-22 — Telegram inline keyboard buttons work indefinitely; the 15-second window is for `answerCallbackQuery` FROM THE TAP, not from message send.**  
A prompt sent Friday is fully functional Monday. Each button tap generates a fresh `callback_query_id`. `answerCallbackQuery` (loading indicator dismissal) has a ~15s window from the tap, but our code wraps it in `.catch(() => {})` anyway. The button routing and `callback_query:data` event are not affected by message age. This means no-timeout works at the Telegram layer with no modifications.

**2026-05-22 — Inline keyboard (A) beats reply keyboard (B) on concurrent-prompt architecture, not implementation cost.**  
Reply keyboard is one keyboard per conversation. N concurrent permission prompts require N independently resolvable affordances — inline keyboard scales trivially (each message has its own buttons + requestId); reply keyboard cannot support this at all. The crash-recovery failure mode (leaked keyboard on process death with no automatic recovery) is a second disqualifier. B has one genuine advantage (overlay visibility regardless of scroll position) that doesn't outweigh these structural problems. When evaluating UX options, check data model compatibility with N-concurrent use cases before evaluating single-prompt ergonomics.

**2026-05-22 — "Allow-always" store should be an injectable interface from day one, even when Phase 6 ships in-memory.**  
The right eventual answer for real users is per-tool-global-persisted (survives daemon restarts). The cost of designing an `AllowAlwaysStore` interface at the start is ~10 extra LOC; the cost of retrofitting it later (after `BridgeSession` has a hardcoded `Set<string>`) is medium. Design for replaceability when you know the upgrade path exists.

**2026-05-22 — Post-timeout behavior determines whether a generous timeout is safe.**  
A clean post-timeout outcome (auto-deny, session continues, Telegram prompt edits in-place, late taps gracefully rejected) means timeout duration is a pure UX tuning knob — there is no "stuck state" risk from a longer timeout. Establish the post-timeout invariants before debating the number. The right timeout (120s) follows from Aaron's actual usage pattern (multitasking, async), not from the default in the existing implementation (60s was set without this knowledge).

**2026-05-22 — `allow-always` scope: per-session in-memory is the right default for solo dogfooding.**  
A `Set<toolName>` on `BridgeSession` instance is the correct Phase 6 default: zero disk I/O, natural expiry on session boundary, upgrade path to persisted (per-tool-global) is medium cost when the user actually asks for it. Do not persist until Aaron explicitly requests it.

**2026-05-22 — Wire protocol should be UX-agnostic; daemon owns UX shape.**  
`permission.request` on the pipe needs only `{toolName, args, permissionId}`. The daemon decides whether to show inline buttons, reply keyboard, or free-text. This means ADR-9's bridge path can reuse `promptUserForPermission()` from `prompt.ts` with zero UX changes — the function already handles correlation, cleanup, and timeout-to-outcome.

**2026-05-22 — `AbortSignal` on `PermissionPrompter.prompt()` should be added before Kat ships BridgeSession.**  
It's a non-breaking optional parameter (~15 LOC across 3 files). Without it, a pending `promptUserForPermission()` stays open in `pendingByRequestId` for up to `timeoutMs` after session disconnect, even if BridgeSession races against it internally. The cost of retrofitting it after the interface is shipped is medium (all callers must update). Add it now.

**2026-05-22 — The timeout discrepancy between ADR-9 (30s) and the existing `prompt.ts` (60s) is a real inconsistency to fix.**  
ADR-9 was drafted with 30s; `promptUserForPermission()` already defaults to 60s. Bridge sessions and SDK sessions sharing a topic should behave identically on timeout. ADR-9 must be amended to `timeoutMs = 60_000` daemon / `65_000` extension before Kat implements. Always check the existing implementation's defaults before proposing new timeout values in an ADR.

**2026-05-22 — Permission prompting is a two-sided async protocol.**  
The extension holds the SDK `permissionCallback` open as a suspended `Promise`; the daemon must resolve it remotely via a request/response pair over the existing pipe. Key insight: the extension's local timeout (e.g., 30s) must be slightly longer than the daemon's user-facing grace period (25s), so `permission.response` always beats the extension's auto-fire. The daemon abort-on-disconnect invariant is critical: any pending `PermissionPrompter.prompt()` must be cancelled when `session.disconnected` fires, or the Telegram prompter can remain open for a dead session indefinitely.

**2026-05-22 — In-stream interleaving is the right pattern for control-plane messages.**  
Interleaving `permission.request`/`permission.response` with `stream` chunks on the same pipe (Alt C) preserves ADR-3's ordering guarantee at the cost of BridgeSession complexity. The ordering guarantee is the deciding factor: `permission.request` for tool N is guaranteed to arrive before stream output from tool N, because the SDK's `permissionCallback` is synchronous-before-execution. A separate pipe (Alt A) loses this guarantee and doubles reconnect complexity.

**2026-05-21 — Triage: extension-side work can leap ahead of the spec.**  
Phase 6 Day 2 triage revealed that `extension.mjs` had already implemented full per-chunk streaming (`handleInject`) — originally spec'd as a stub until Days 3–4. The code was complete, self-contained, and green. Lesson: when a deliverable is "ahead of plan" and passes tests, commit it. The completed extension-side streaming reduced Kat's Days 3–4 scope to relay/daemon-side only, not both sides. **Don't revert work that already passes — triage it and update the plan.**

**2026-05-21 — Adapter > rewrite when the abstraction already fits.**  
Days 3–4 relay integration choice: `relay.ts` was already written against `CopilotSession.send() → AsyncIterable<string>`. The bridge emits `stream` events. A `BridgeSession` adapter (~60 LOC) bridges the gap and inherits 140+ LOC of throttle/edit/fallback logic at zero cost. The principle: when an existing abstraction's shape matches the new integration point, use an adapter before considering a rewrite.

---

## Phase 6 Live Dogfooding Preparation (2026-05-24)

**Date:** 2026-05-24T04:10:11Z  
**Outcome:** Checklist prepared; ready for live phone dogfooding tonight.

**Status before dogfooding:**
- ✅ All 410 tests green (32 test files, 4 skipped)
- ✅ Build succeeds, tsc clean, lint clean
- ✅ Phase 6 merged to main (commit c2c347f), workflows activated
- ✅ ADR-9 hardened against 11 edge cases (eviction, TTY, backpressure, etc.)
- ✅ Named pipe bridge listening, no startup errors

**Critical Findings for Dogfooding:**
1. **No production blockers identified.** Code is ready for end-to-end validation.
2. **ADR-10 (pipe auth) is documented but not yet implemented.** Current code uses randomized pipe name only, no token validation. Not a blocker for solo dogfooding, but marks the pre-production gap.
3. **Inbox has 9 unmerged files** awaiting Scribe (cloud-review findings, reconciliation notes). No new issues surfaced; all are pre-dogfood housekeeping.
4. **Dogfood gate criteria (implicit):** After tonight's end-to-end test, success = permission prompting works over real pipe, no-timeout verified, concurrent prompts don't interfere, safe/destructive tool classification correct in extension.

**Dogfooding Artifacts:**
- `.copilot/reach-dogfood-checklist.md` — 14.7 KB, 250-line checklist with 8 sections:
  1. Pre-flight checks (env vars, Telegram setup, bridge auth)
  2. Build & startup sequence (copy-pasteable commands)
  3. Phone-side validation (chat-ID guard, session lookup, prompt round-trip)
  4. ADR-9 scenarios (6 concrete prompts: safe tool, destructive allow, deny, allow-always, no-timeout, concurrent)
  5. Known gaps & risks (9 inbox items, ADR-10 not yet impl'd, runtime surprises)
  6. Rollback & diagnostics (clean kill, inspect state, hard reset)
  7. Success criteria (8-point validation checklist)
  8. Appendix (command reference)

**Next Session Actions (if dogfooding succeeds):**
1. Append findings to history.md under "## Dogfooding Results"
2. Decide on Phase 7 scope (extend classifier? implement persistent store? ship ADR-10?)
3. Scribe drains 9 inbox files into decisions.md
4. Plan for production readiness (telemetry, monitoring, rollback procedure)

---

## /afk Realignment Analysis (2026-05-24)

**Date:** 2026-05-24T20:12:39-07:00  
**Outcome:** Gap analysis of CLI-initiated `/afk`/`/back` story vs. current Telegram-initiated architecture. Identified 4 missing capabilities, 3 open architectural questions. Recommended pausing Phase 6 tail work to spike ADR-11 and pivot to Phase 7 = `/afk` MVP. Written to `decisions/inbox/noble-six-afk-realignment.md`.

**2026-05-24T22:19-07:00:** Surfaced 16 remaining opens after Aaron's /afk answers — 3 need his call, 1 needs a research spike, 12 have recommendations. Written to `decisions/inbox/noble-six-afk-mode-opens.md`.

**2026-05-24T22:40-07:00:** Drafted ADR-11 (/afk Mode + Multi-Session Mirror Bridge) — 12 sections, 8 new message types, full protocol spec. Written to `decisions/inbox/noble-six-adr11-afk-mode.md`.

**2026-05-24T22:50-07:00:** Amended ADR-11 §3 and §12 Q1 — skill spike resolved: SKILL.md infeasible (prompt-augmentation only), entry point is SDK `commands` field on `JoinSessionConfig` in extension.mjs.

---
