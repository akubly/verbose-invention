# Decisions Archive

**Last updated:** 2026-05-08

---

# Carter — Phase 5 Review Fixes Decision Summary

**Date:** 2026-05-02  
**Author:** Carter (Bridge Dev)  
**Scope:** relay.ts, markdownV2.ts, messageSplitter.ts  
**Trigger:** 6-persona panel review of Phase 5 (MarkdownV2 escaping + message splitting)

---

## Finding Disposition

| ID | Severity | Title | Decision | Notes |
|----|----------|-------|----------|-------|
| F1 | BLOCKING | Numbering prefix overflows maxLen | ACCEPT | Two-pass algorithm with iterative prefix reservation |
| F4 | IMPORTANT | Splitter budget vs. escape expansion | ACCEPT | Option (b): \eserveBytes\ headroom (~30%) |
| F5 | IMPORTANT | Numbering not enabled | ACCEPT | Added \
umbering: true\ to relay call |
| F6 | IMPORTANT | Fallback over-catches all errors | ACCEPT | \isParseEntitiesError\ guard; only parse errors fall back |
| F7 | IMPORTANT | Layering violation (relay→bot/sessions) | ESCALATE | See below |
| F8 | IMPORTANT | safeEdit/safeSend duplication | ACCEPT | Extracted \withMarkdownFallback\ private helper |
| F9 | IMPORTANT | Chunk failure log omits index | ACCEPT | \safeSend\ returns boolean; loop tracks failures + summary |
| F10 | IMPORTANT | Unbounded \ccumulated\ stream | ACCEPT | 100KB cap + 25-chunk cap |
| F11 | IMPORTANT | Overlong code line in splitCodeBlock | ACCEPT | Hard-cut at \lineCapacity = maxLen - overhead\ |
| F12 | MINOR | Code-block detector mis-pairs fences | ACCEPT | Odd-fence count defensive check in \scapeMarkdownV2\ |
| F13 | MINOR | \
eedsEscaping\ export lacks JSDoc | ACCEPT | JSDoc added |
| F4 | IMPORTANT | Splitter budget vs. escape expansion | ACCEPT | Option (b): `reserveBytes` headroom (~30%) |
| F5 | IMPORTANT | Numbering not enabled | ACCEPT | Added `numbering: true` to relay call |
| F6 | IMPORTANT | Fallback over-catches all errors | ACCEPT | `isParseEntitiesError` guard; only parse errors fall back |
| F7 | IMPORTANT | Layering violation (relay→bot/sessions) | ESCALATE | See below |
| F8 | IMPORTANT | safeEdit/safeSend duplication | ACCEPT | Extracted `withMarkdownFallback` private helper |
| F9 | IMPORTANT | Chunk failure log omits index | ACCEPT | `safeSend` returns boolean; loop tracks failures + summary |
| F10 | IMPORTANT | Unbounded `accumulated` stream | ACCEPT | 100KB cap + 25-chunk cap |
| F11 | IMPORTANT | Overlong code line in splitCodeBlock | ACCEPT | Hard-cut at `lineCapacity = maxLen - overhead` |
| F12 | MINOR | Code-block detector mis-pairs fences | ACCEPT | Odd-fence count defensive check in `escapeMarkdownV2` |
| F13 | MINOR | `needsEscaping` export lacks JSDoc | ACCEPT | JSDoc added |

---

## F7 Resolution: Port injection (implemented)

**Decision:** Introduce src/relay/ports.ts with SessionLookup and PermissionPrompter ports; inject via constructor.

**Ports defined:**
- SessionLookup: resolve(topicId) → ResolvedSession | undefined
- PermissionPrompter: prompt(chatId, topicId, toolName, args) → Promise<boolean>
- ResolvedSession: { sessionName: string; model?: string }

**Layering result:** grep -rE "from '\.\.(bot|sessions)" src/relay/ → zero hits.

---

# Kat — Phase 5 Review Fixes Decision Summary

**Date:** 2026-05-02  
**Author:** Kat (Bot Dev)  

## F2 — Name Uniqueness Strategy

**Decision: Approach A — Enforce at registration.**

Duplicate names rejected on new registration. Existing on-disk duplicates preserved with warning.

## F3 — Atomic Move Primitive

**Decision: Add move() to ISessionRegistry.**

Single persist() call; rollback guarantee on failure.

---

# Carter — PR #5 Copilot Review Fix Decisions

**Date:** 2026-05-03  
**Author:** Carter (Bridge Dev)  
**Scope:** relay.ts, messageSplitter.ts  
**Trigger:** Copilot review of PR #5 (Phase 5 Telegram UX QoL)

---

## F-A: MarkdownV2 Budget API Choice

### Problem
The old `MARKDOWN_ESCAPE_RESERVE_BYTES = 1229` was a fixed delta subtracted from
`maxLen` (4096 − 1229 = 2867 effective max). This leaves insufficient headroom:
a chunk composed entirely of MarkdownV2 special characters (``_ * [ ] ( ) ~ ` > # + - = | { } . ! \``)
gets one backslash prepended per character, nearly doubling the byte count. A 2867-char
all-specials chunk escapes to ~5734 chars — far over Telegram's 4096-char limit.

### Decision: Option (b) — rename to `effectiveMaxLen`

**Rationale:** The new constant `MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048` represents the
desired working budget directly (≈ 4096 ÷ 2, accounting for worst-case 2× expansion).
Exposing this as `effectiveMaxLen` in `SplitOptions` is cleaner than `reserveBytes` because:

1. **No caller arithmetic.** With `reserveBytes`, callers must know `maxLen` and compute
   `maxLen - desiredBudget` themselves. With `effectiveMaxLen`, they pass the ceiling directly.
2. **Contract clarity.** `effectiveMaxLen: 2048` reads "chunks are at most 2048 chars", not
   "subtract 2048 from the limit" — which is the actual semantic.
3. **API shape matches `safeSend`'s boolean shape** — both are positive, forward-facing values.

The old `reserveBytes` field is removed (not kept for backward compat) since `messageSplitter`
is an internal module with no external callers outside the relay.

**Values:**
- `MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048` (= `Math.floor(4096 / 2)`)
- Passed as `effectiveMaxLen: MARKDOWN_ESCAPE_EFFECTIVE_MAX` in `splitForTelegram` call

---

## F-E: First-Chunk Failure Semantics

### Problem
`safeEdit()` previously returned `Promise<void>` and swallowed errors internally.
If the first chunk's edit failed (network error, Telegram unavailable), the relay
continued sending chunks 2..N via `ctx.reply()` — orphaning the user with chunk 2
onward but no chunk 1, while the original `…` placeholder remained stuck.

### Decision: safeEdit returns `Promise<boolean>`

**Shape chosen:** `boolean` (matching `safeSend`'s existing shape), where `true` = success,
`false` = failure. This avoids introducing a new error type and keeps both edit/send methods
parallel in their failure signaling.

**Failure path on first-chunk failure:**
1. Log `console.error('[relay] First-chunk edit failed — aborting follow-up chunks for topic N; updating placeholder')`
2. **Abort** the follow-up chunk loop (return early) — no orphaned chunks 2..N.
3. **Best-effort placeholder update:** call `safeEdit` (plain text, no markdown) with
   `'_(failed to render reply — see logs)_'` so the user sees an error instead of `…`.
4. If even that secondary edit fails, `safeEdit` logs a `console.warn` and returns `false`
   — accepted silently (we've already logged the primary error and can't do more).

**Mid-stream throttle edits:** These also call `safeEdit` but their boolean return value is
intentionally ignored — a transient throttle-edit failure doesn't abort streaming, only
the final first-chunk delivery does.

**Error message choice:** `_(failed to render reply — see logs)_` uses MarkdownV2 italic
syntax but is sent as plain text (no `tryMarkdown`). The underscores appear literally in
plain-text mode, which is acceptable for an error fallback.

---

## F-D Re-review: `maxChunks` in Splitter

### Problem
The F-D fix (post-split slice+append in relay.ts) applied the cap AFTER `splitForTelegram`
had already composed `[n/26]` prefixes and appended the footer to the original last chunk.
Truncated responses therefore delivered:
- Chunks 1..24 with stale `[n/26]` labels (total never delivered)
- A bare truncation marker with no numbering prefix and no HUD footer
- The footer lost entirely (it was on the dropped chunk 25)

### Decision: push the cap into `splitForTelegram` via `maxChunks?: number`

**Why inside the splitter, not relay:** The splitter owns the invariant that returned chunks
have consistent numbering and correct footer placement. Any cap that happens after the splitter
runs violates that invariant. Moving `maxChunks` into the splitter keeps the contract
self-consistent: callers get back chunks where every element respects size, numbering, and
footer rules regardless of truncation.

**When the cap fires:**
1. After the two-pass numbering split (chunk bodies are correctly sized for the natural prefix)
2. Before footer/numbering composition: `chunks = [...chunks.slice(0, maxChunks - 1), TRUNCATION_MARKER]`
3. Footer then appended to `chunks[chunks.length - 1]` (the truncation marker)
4. Numbering applied with `total = chunks.length` (= `maxChunks` when capped)

**Why the two-pass split can still run with the natural total before capping:**
The two-pass split sizes chunks for the natural prefix `[26/26]\n` (9 chars). After capping
to 25, the prefix becomes `[25/25]\n` (also 9 chars) — no re-sizing needed. More generally,
capping can only decrease the total, which decreases or maintains prefix length. Chunks sized
for the larger prefix always fit with the smaller one.

**Relay change:** `splitForTelegram` call gains `maxChunks: MAX_CHUNKS`; the post-split
`allChunks` slice/append is removed entirely. The relay uses `chunks` directly.

---

# Kat — PR #5 Copilot Review Fixes Decision Summary (Copilot Review)

**Date:** 2026-05-03
**Author:** Kat (Bot Dev)
**Scope:** `src/bot/handlers.ts`, `src/sessions/registry.ts`
**Trigger:** Copilot code review on PR #5 — findings F-B and F-C

---

## Finding Disposition

| ID  | Severity  | Title                                         | Decision | Notes                                            |
|-----|-----------|-----------------------------------------------|----------|--------------------------------------------------|
| F-B | IMPORTANT | `/resume` silently picks wrong legacy dup     | ACCEPT   | `findAllByName` + refuse-if->1 in handler        |
| F-C | IMPORTANT | `move()` not atomic vs concurrent `register`  | ACCEPT   | Destination-unbound check inside `move()` itself |

---

## F-B — `/resume` legacy duplicate resolution

**Problem:** `findByName` returns the first linear match. When a legacy registry file has two entries with the same `sessionName`, `/resume` would silently move whichever one happened to be iterated first — potentially rebinding the wrong session.

**Decision: Add `findAllByName` and refuse on >1 match.**

- `findAllByName(name): SessionEntry[]` added to `ISessionRegistry` and `SessionRegistry`.
- `/resume` switches to `findAllByName`; if `length === 0` → existing not-found path; if `length > 1` → refuse with a list of all matching `topic #N (chatId C)` entries and instruct the user to `/rename` or `/remove`.
- `findByName` retained for callers that genuinely want first-match (e.g., `/new`'s duplicate-name guard), since uniqueness is enforced at registration so new entries cannot create duplicates.

**Alternatives considered:**
- Prompt user to pick one: rejected — single-purpose command semantics; no disambiguation prompts.
- Auto-pick by most-recent `createdAt`: rejected — silently correct is still silently wrong if user intended the other entry.

---

## F-C — `move()` atomic destination check

**Problem:** `/resume` checked `registry.resolve(toTopicId)` before calling `move()`, but that check was outside any atomic section. A concurrent `/new` or `/resume` could bind `toTopicId` in the window between the check and the mutation, silently clobbering the new binding.

**Decision: Move the destination-unbound check inside `move()` itself.**

- At the top of `move()`, before any `entries.delete`/`entries.set` mutation, check `this.entries.get(toTopicId)`. If bound, throw `Error('Destination topic N is already bound to "name"')`.
- The existing UX pre-check in `/resume` (`registry.resolve(topicId)` before calling `move()`) is preserved as a fast path with a friendlier error message.
- `move()`'s check is the authoritative gate; the pre-check is advisory UX only.
- `/resume` catch block detects `already bound to` in the error message and emits a clean ⚠️ advisory instead of the generic `❌ Failed to resume session`.

**Alternatives considered:**
- External mutex/lock: overkill for a single-process daemon; Map mutations are synchronous, so the check-then-mutate pattern within `move()` is safe for concurrent async callers on the same event loop.
- Return an error code vs throw: throw is consistent with the rest of the registry's error surface.

---

# Noble Six — Dogfood Readiness Verdict

**Date:** 2026-05-04  
**Author:** Noble Six (Lead/Architect)  
**Context:** Phases 1–5 complete. PR #5 merged (commit de4a196). No open issues.

---

## Verdict: Ship It

Reach is ready for personal dogfooding **today**. No blocking gaps.

---

## What Works End-to-End

| Capability | Status |
|---|---|
| Bot command surface (`/new`, `/list`, `/remove`, `/resume`, `/help`, `/pair`) | ✅ |
| Session registry with disk persistence | ✅ |
| Copilot SDK relay with streaming + edit-throttle (800ms) | ✅ |
| MarkdownV2 formatting with plain-text fallback | ✅ |
| Message splitting (4096-char limit, code block protection, 25-chunk cap) | ✅ |
| Permission policies (`approveAll`, `denyAll`, `interactiveDestructive`) | ✅ |
| Windows Service install/uninstall (auto-restart on crash) | ✅ |
| Graceful shutdown (SIGINT/SIGTERM) | ✅ |
| Pairing mode (no chat ID needed at first boot) | ✅ |
| DoS guards (100KB stream cap, 25-chunk cap) | ✅ |
| Test suite | 278 pass, 4 intentional placeholder stubs |

---

## Gaps — None Block Dogfooding

### Nice-to-Have (not blocking)

1. **No `/status` or `/ping` command** — Aaron cannot verify from Telegram that Reach is alive without querying Windows Service Manager. This is a 1-hour Carter task. Worth doing in first week of dogfood feedback.

2. **Phase 4 Wave 3 never scoped** — operator runbook, logging improvements, error recovery enhancements were marked "TBD" and never completed. Real-world use will reveal what actually matters here; don't pre-build.

3. **4 placeholder test stubs** in `tests/copilot/impl.test.ts` (exponential backoff, permission handler coverage). Inconsequential for runtime behavior.

---

## Setup Steps (from README)

1. **Create Telegram bot** via [@BotFather](https://t.me/BotFather); save token
2. **Create supergroup** with Topics enabled; add bot as admin
3. **Create `.env`** from `.env.example`:
   ```env
   TELEGRAM_BOT_TOKEN=<token>
   TELEGRAM_CHAT_ID=<supergroup-id>   # optional; skip for pairing mode
   REACH_PERMISSION_POLICY=interactiveDestructive  # recommended for real use
   ```
4. `npm install` (already done in repo)
5. `npm run build`
6. **As admin:** `npm run service:install`
7. If no `TELEGRAM_CHAT_ID` set: open supergroup, send `/pair <code>` (code printed to console)

**Recommended first-run order:**
- Start in foreground (`npm start`) to verify pairing and first session work
- Then switch to service install once confirmed working

---

## What to Watch During Dogfooding

- **MarkdownV2 fallback rate** — if plain-text fallback fires constantly, the escaper has a gap. Log line to watch: `[relay] MarkdownV2 rejected`.
- **Idle session eviction** — 5-min default; adjust `IDLE_TIMEOUT_MS` if too aggressive.
- **Service crash frequency** — Windows Event Viewer → Application log. If it crashes more than once/day in first week, escalate to Carter for crash recovery investigation.

---

## Routing Recommendations

- **Carter:** Post-dogfood Week 1 — add `/status` command (Relay health check, session count, uptime). Small lift, high daily value.
- **Noble Six:** Watch dogfood feedback; convene Phase 6 scope after 1–2 weeks of real use.

---

# Noble Six — Phase 6 Proposal: Session Attach/Detach & Multi-Repo Support (v1)

**Date:** 2026-05-04  
**Author:** Noble Six (Lead/Architect)  
**Status:** SUPERSEDED  
**Superseded by:** See below — Phase 6: Session 0 Control Plane + Data Plane Topics (2026-05-08)

*[v1 archived for traceability; see v2 LOCKED proposal for current Phase 6 design.]*

---

# Noble Six — Phase 6: Session 0 Control Plane + Data Plane Topics

**Date:** 2026-05-08  
**Author:** Noble Six (Lead/Architect)  
**Status:** LOCKED  
**Supersedes:** `Phase 6 Proposal: Session Attach/Detach & Multi-Repo Support (v1)` (2026-05-04)  
**Trigger:** Aaron + Coordinator iteration on the v1 broker model

---

## 1. TL;DR

Reach is a remote i/o channel, not a session manager. A single "Session 0"
lives in the Telegram General topic and provides a command-only control plane
with two modes: silent (desktop) and interactive (AFK). Data-plane topics are
created on-demand when the user attaches a live CLI session during AFK mode,
giving each topic a 1:1 pipe to a CLI process on the host.

---

## 2. The Model

```
Reach Daemon (single host)
│
├── Session 0  ── General topic (permanent, never deleted)
│   ├── Desktop mode (default): silent. Only accepts /afk.
│   └── AFK mode: full control surface (/list, /attach, /new, /kill, /back)
│
└── Data-plane topics (created during AFK, on-demand)
    └── 1:1 mapping: topic ↔ live CLI process
        ├── User messages → piped to CLI stdin
        └── CLI stdout → streamed to topic
```

### Mode lifecycle

```
                ┌──────────────────────────────┐
                │                              │
  ┌─────────┐  │  /afk (desktop or phone)  ┌──▼──────┐
  │ DESKTOP ├──┘                           │   AFK   │
  │  MODE   │◄─────────────────────────────┤  MODE   │
  └─────────┘  /back (any topic) or        └────┬────┘
               desktop activity detected        │
                                                │ /attach <session>
                                                ▼
                                         ┌────────────┐
                                         │ Data-plane │
                                         │   topic    │
                                         └────────────┘
                                         auto-archives on:
                                         • /back
                                         • CLI session dies
```

- **Default = Desktop mode.** Reach is silent. Group stays clean.
- **/afk** (typed at desktop CLI or sent to Session 0 from phone) → AFK mode.
  Session 0 becomes interactive. User picks which CLI sessions to bring along.
- **Attach** creates a data-plane topic named after the CLI session. Messages
  in the topic pipe to/from the CLI process.
- **/back** (from any topic, or auto-detected desktop activity) → all data-plane
  topics auto-archive. Session 0 returns to silent. No historical replay if
  the session is re-attached later — treat as fresh.

---

## 3. Locked Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Session 0 is **command-only** (slash commands). No conversational AI. | Conversational Session 0 is Phase 7. Keep the control plane predictable. |
| 2 | **1 topic : 1 CLI process**, enforced. Second attach to same session rejected. | Eliminates fan-out ambiguity. One pipe, one destination. |
| 3 | Data-plane topics created **on-demand** from Session 0, not auto-created for every live CLI session. | User chooses what's worth managing remotely. Don't pollute the group with 15 shadow topics. |
| 4 | Session 0 lives in **General topic**, permanently. Mode state is the daemon's, not the topic's. Phone-side `/afk` works for cold start. | General topic always exists. No bootstrapping problem. |
| 5 | Topic naming uses **CLI's session name** (SDK auto-generated or user's `/rename`). Fallback: `{repo}-{branch}-{id4}`. | Consistent with what the user already sees on desktop. |

---

## 4. Open Technical Questions (Gate Implementation)

### Q1 — Discovery: How does Reach see live desktop CLI sessions?

Three plausible mechanisms:

| Mechanism | Requires CLI cooperation? | Risk |
|-----------|--------------------------|------|
| SDK API (session listing endpoint) | No | SDK may not expose this |
| Breadcrumb files (CLI writes state to disk) | Yes (convention) | CLI must write them; we must find the path |
| IPC socket (CLI exposes a local endpoint) | Yes (protocol) | Highest coupling; breaks on CLI crash |

**Action:** Carter spike, 1–2 days. Determine which mechanism exists or is
cheapest to implement. SDK API is the friendly path; breadcrumbs are the
realistic fallback.

### Q2 — Attach semantics: What happens to the desktop TUI?

When Reach attaches to a running CLI session, the desktop terminal is still
open. Options:

- **Shared output** — both desktop and Telegram see output (simplest)
- **Handoff** — desktop goes read-only, Telegram owns input
- **Exclusive** — desktop TUI disconnects

This depends entirely on what the SDK supports. Same spike answers both Q1
and Q2.

**If the friendly path (SDK API + shared/handoff) doesn't exist**, the fallback
is a breadcrumb-based one-way mirror: Reach can read CLI output but can't inject
input. `/new` (spawn a fresh CLI subprocess) becomes the only bidirectional path.

---

## 5. MVP Scope (Week 1 — Assumes SDK Friendly Path)

### New files

| File | Purpose |
|------|---------|
| `src/control/session0.ts` | Command router for General topic. Owns mode state machine (desktop ↔ AFK). Routes `/afk`, `/back`, `/list`, `/attach`, `/new`, `/kill`. |
| `src/discovery/cliDiscovery.ts` | Find live CLI sessions on the host. Wraps whichever mechanism the spike confirms. Returns `CliSession[]` with id, name, status. |

### Changed files

| File | Change |
|------|--------|
| `src/sessions/registry.ts` | Semantics shift: **attach to existing CLI session**, not create a Reach-owned SDK session. Drop name-uniqueness enforcement (CLI names are authoritative). Track lifecycle state (`attached` / `detached`). Entry becomes `topicId → cliSessionId`. |
| `src/bot/handlers.ts` | Split routing: General topic → `session0.ts`; forum topics → data-plane relay. Enforce mode gates (desktop mode rejects everything except `/afk`). Existing `/new` and `/list` move to Session 0 command surface. |
| `src/relay/relay.ts` | I/O piping for an **attached CLI session**, replacing per-Reach SDK session creation. Input: topic message → CLI stdin. Output: CLI stdout → topic stream. Existing streaming/splitting/MarkdownV2 infrastructure reused. |

### Config

| Key | Purpose |
|-----|---------|
| `REACH_MODE_DEFAULT` | `desktop` (default) or `afk`. Controls startup state. |
| `REACH_AFK_AUTO_TIMEOUT_MS` | Optional. If set, auto-detect desktop inactivity and trigger AFK. Phase 7 candidate; wire the config now, leave the detector unimplemented. |

---

## 6. Explicitly Out of Scope (Phase 6)

- Conversational Session 0 (AI in General topic)
- Per-session git worktrees
- Same-repo-different-branch handling beyond "user beware"
- Multi-host support (one daemon per host)
- Auto `/afk` on desktop idle detection (Phase 7 candidate)
- Historical replay on re-attach (fresh pipe every time)

---

## 7. Division of Labor

| Agent | Scope | Deliverable |
|-------|-------|-------------|
| **Carter** | Spike discovery + attach mechanisms (1–2 days). Then refactor `relay.ts` + `registry.ts` around attach semantics. Build `session0.ts` command router. | Working attach/detach for one CLI session. |
| **Kat** | Bot routing changes: General-topic command surface, mode-gated handlers, topic lifecycle (create on attach, archive on detach/death). | `/afk`, `/back`, `/attach`, `/kill` commands wired through mode gates. |
| **Jun** | Integration tests: mode transitions (desktop → AFK → desktop), attach/detach cycles, graceful degradation when discovery fails or CLI session dies mid-conversation. | Test suite covering the state machine and failure paths. |

**Sequencing:**
- Day 1–2: Carter spike (discovery + attach). Jun writes test skeletons against the proposed interfaces.
- Day 3–5: Carter builds `session0.ts` + relay refactor. Kat builds routing + topic lifecycle. Jun fills tests.

---

## 8. Risks & Accepted Trade-offs

| Risk | Mitigation / Acceptance |
|------|------------------------|
| **Attach may not be technically possible** via SDK. | Fallback: breadcrumb-based one-way mirror. `/new` (spawn CLI subprocess) for true bidirectional. Architecture is the same either way — only the discovery adapter changes. |
| **Same-repo-different-branch foot-gun.** | Accepted. Reach doesn't add risk vs. desktop; we just don't subtract it. Not our problem to solve. |
| **"Create from phone" gets harder** — requires spawning a CLI process on the host. | Accepted. Aaron's data: he overwhelmingly resumes existing sessions. Phone-initiated creation is rare. Worth the trade for a cleaner model. |
| **No historical replay on re-attach.** | Accepted. CLI owns history. If the user wants context, they scroll up in the CLI or start fresh. Reach is a pipe, not a database. |





