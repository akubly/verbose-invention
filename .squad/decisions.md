# Decisions Archive

**Last updated:** 2026-05-19

---

## Phase 6 Architecture — LOCKED (2026-05-19)

**By:** Noble Six (Lead/Architect)  
**Status:** LOCKED (was PROPOSED)  

Aaron resolved all three architectural blockers. This document finalizes seven ADRs and locks the Phase 6 architecture for implementation.

### ADR-1: Use Copilot CLI Extension API for Session Attach

**Status:** ACCEPTED

Use the Copilot CLI extension API (`joinSession()`, `session.send()`, `session.on()`) as the sole attach mechanism. The extension runs as a forked Node child of the CLI process. It self-registers with the daemon over a named pipe on startup.

**Consequences:**  
✅ Push-based registration eliminates port-discovery gap entirely.  
✅ Extension lifecycle is tied to CLI lifecycle.  
✅ Bidirectional streaming is native.  
❌ Coupled to `@github/copilot-sdk@0.2.2`. Mitigation: pin 0.2.x, extension is <100 LOC.  
❌ Adds install surface (extension file deployed to user extensions dir).

---

### ADR-2: Push-Based Discovery with listSessions() Fallback

**Status:** ACCEPTED

Primary discovery is push-based. Each CLI extension instance opens a named pipe connection to the daemon and sends a `hello` message. Daemon maintains live-session map. `listSessions()` is used only as fallback for dormant sessions (on disk but no running extension).

**Consequences:**  
✅ Authoritative — daemon knows exactly which sessions have a live extension.  
✅ Low latency — registration is immediate on CLI startup.  
✅ No polling overhead.  
❌ Dormant sessions require `listSessions()` fallback. Two code paths for session enumeration.  
❌ If extension fails to register (daemon not running), session is invisible until daemon starts.

---

### ADR-3: Single Named Pipe, Multiplexed by sessionId

**Status:** ACCEPTED

A single named pipe (`\\.\pipe\reach-bridge`) serves all extension connections. Each message includes a `sessionId` field for routing. Protocol framing: UTF-8 JSON, newline-delimited. Max message size: 64 KB per line.

**Consequences:**  
✅ Single pipe simplifies firewall/security surface — one endpoint to secure.  
✅ Multiplexing by sessionId scales to 10+ concurrent sessions.  
✅ JSON-Lines is human-readable, debuggable, and trivial to parse.  
❌ Single pipe is a single point of failure. Mitigation: daemon auto-restarts (Windows service recovery), extensions reconnect.  
❌ 64 KB message limit means very large responses must be chunked. Acceptable — relay already chunks at 4096 chars for Telegram.

---

### ADR-4: Extension Crash = Session Unreachable (No Auto-Recovery)

**Status:** ACCEPTED

Extension crash marks the session as `unreachable` in the daemon's session map. Session remains in `/list` with an `[unreachable]` tag. No automatic re-fork — user restarts the CLI or opens a new session.

**Consequences:**  
✅ Simple, predictable failure mode.  
✅ Daemon stays healthy regardless of extension state.  
✅ Deterministic for testing.  
❌ User must manually restart CLI to re-establish the bridge. Acceptable — CLI restarts are fast.  
❌ `/attach` on unreachable session produces an error.

---

### ADR-5: Daemon Service Account — Logged-In User

**Status:** ACCEPTED

The Reach Windows service runs as the logged-in interactive user, not LocalSystem. `src/service/install.ts` determines the current user at install time via `whoami /upn` (preferred) or `wmic useraccount where name='%USERNAME%' get sid` (fallback). Installer prompts for password if required.

**Implementation notes:**
- `serviceaccount` block in `install.ts` sets `--username` and `--password` on service registration.
- If password prompt fails or is cancelled, installer exits with clear error: `"Service install requires your Windows password to run as your account."`
- UPN format (`user@domain`) preferred for compatibility.

**Consequences:**  
✅ Eliminates pipe DACL / integrity-level problem entirely.  
✅ Daemon sees only current user's CLI sessions.  
✅ Fixes existing `LookupAccountName failed: 1332` bug.  
❌ Service stops when user logs off. Acceptable — Reach is personal-host tool.  
❌ Multi-user-on-same-host requires one install per user. Acceptable — explicit single-user scope decision.  
❌ Requires user password at install time. Acceptable — one-time cost.

---

### ADR-6: Extension Reconnect Policy — Exponential Backoff

**Status:** ACCEPTED

Exponential backoff with parameters:
- **Base interval:** 1 second
- **Multiplier:** 2×
- **Ceiling:** 300 seconds (5 minutes)
- **Termination:** Never give up while CLI session is alive
- **Logging:** Each attempt logs attempt number, elapsed time, error message

Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s, 300s, …

On successful reconnect, extension re-sends `hello` message (re-registration) and resets backoff timer.

**Consequences:**  
✅ Daemon restarts don't require user intervention — extensions reconnect automatically.  
✅ Bounded worst-case reconnect latency: 5 minutes after backoff ceiling is reached.  
✅ Deterministic for tests — Jun can inject controlled delays and assert on attempt counts.  
✅ Logging on each attempt provides debuggability.  
❌ Stale extensions could attempt reconnects for hours if daemon down. Acceptable — CPU cost negligible (~one syscall per 5 minutes at ceiling).  
❌ Worst-case 5-minute reconnect delay after daemon restart. Acceptable — daemon restarts rare.

---

### ADR-7: Heartbeat Protocol — Ping/Pong + Pipe Teardown

**Status:** ACCEPTED

Use BOTH mechanisms:

1. **Fast path — Pipe teardown detection:** Daemon listens for `close` event on each extension's pipe connection. When CLI dies, OS closes pipe handle, daemon receives event. Detection latency: <1 second.

2. **Slow path — Ping/pong heartbeat:** Daemon sends `ping` every 30 seconds to each connected extension. Extension replies with `pong` within 5 seconds. If daemon misses one pong (30s cycle passes without pong), it waits 15s grace period before marking session `unreachable`.

**Protocol messages:**
```json
{"type": "ping", "id": "uuid-v4"}
{"type": "pong", "id": "uuid-v4"}
```

**Timing analysis:**
- **Pipe close (fast path):** <1s detection.
- **Missed pong (slow path):** Worst case = 30s + 5s + 15s = **50s**. Typical case = 5s + 15s = **20s**. Aaron's target of ≤45s is met in typical case; worst case is 50s (one cycle boundary overshoot). Acceptable.

**Consequences:**  
✅ Fast disconnect detection via pipe close — sub-second for normal CLI exits.  
✅ Catches network-style hangs.  
✅ Deterministic for tests.  
✅ UUID correlation prevents stale pongs after reconnect.  
❌ 30s background traffic per session (negligible — ~50 bytes per ping/pong pair per 30s cycle).  
❌ Worst-case detection is 50s, slightly above Aaron's 45s target. Acceptable — overshoot is boundary condition.

---

### Updated Phase 6 Status

| Dimension | Status |
|-----------|--------|
| **Architecture** | LOCKED |
| **Open architectural questions** | NONE — all gated decisions resolved |
| **ADRs** | 7 accepted (ADR-1 through ADR-7) |
| **Implementation gates** | Test doubles (`FakeDaemon`, `FakeExtensionClient`) needed Days 1–2 per Jun. Carter can start named-pipe server skeleton in parallel. Kat can start `install.ts` refactor in parallel. |

**Out of scope (Phase 6):**
- Multi-user-on-same-host (explicit single-user scope decision, ADR-5)
- Conversational Session 0 (command-only, Decision #1)
- Per-session git worktrees
- `/afk` / `/back` commands (deferred — not load-bearing)

---

### Day 1 Parallel Tasks

All three tasks below have **no hard data dependencies** and can start immediately in parallel.

**Carter — Named Pipe Server Skeleton + Extension Handshake**  
**Start:** Immediately  
**Deliverable:** `src/bridge/extensionBridge.ts` — pipe server on `\\.\pipe\reach-bridge`, accepts connections, parses JSON-Lines, handles `hello` → `session.registered` handshake. Stub `inject` and `stream` message handlers. Also `extension.mjs` skeleton — connects to pipe, sends `hello`, handles `ping`/`pong`, implements reconnect loop per ADR-6.

**Kat — install.ts Refactor for User-Account Service Install**  
**Start:** Immediately  
**Deliverable:** Refactored `src/service/install.ts` — service installs as current user (not LocalSystem) per ADR-5. `whoami /upn` primary, `wmic` fallback. Password prompt flow. Clear error on cancellation. Fixes existing `LookupAccountName failed: 1332` bug.

**Jun — FakeDaemon + FakeExtensionClient Test Doubles**  
**Start:** Immediately  
**Deliverable:** `test/helpers/FakeDaemon.ts` — spawns pipe server on random pipe name, accepts connections, sends/receives protocol messages, exposes assertion helpers. `test/helpers/FakeExtensionClient.ts` — connects to pipe, sends `hello`, responds to `ping`, exposes message log for assertions.

---

# Decisions Archive

**Last updated:** 2026-05-09

---

# Decisions Archive

**Last updated:** 2026-05-08

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






---

## 2026-05-19T22:13:42-07:00: User directives — Phase 6 architectural locks

### 2026-05-19T22:13:42-07:00: User directives — Phase 6 architectural locks

**By:** Aaron (via Copilot)

**What:**
1. **Phase 6 scope = Option B (extension bridge).** Ship `/list` + `/new` + `/attach` via the CLI extension. Full bidirectional viewport into live desktop sessions. Adopt Noble Six's revised proposal as the LOCKED Phase 6 design.
2. **Daemon service account = logged-in user, NOT LocalSystem.** A single Windows user's sessions are the only ones Reach should be able to attach. Cross-user attach is explicitly out of scope (and undesirable — you can't control another user's sessions). This resolves Jun's pipe-security blocker (EC-06) by eliminating the cross-integrity-level case entirely. The `src/service/install.ts` `serviceaccount` block must reflect this. The existing bug there (`OFFICE-DESKTOP\LocalSystem` causing `LookupAccountName failed: 1332`) gets superseded by this scope decision.
3. **Extension reconnect policy = exponential backoff, ceiling 5 minutes.** When the daemon is unreachable (restart, crash, not running), `extension.mjs` retries with exponential backoff (e.g., 1s → 2s → 4s → 8s → … capped at 300s). Never gives up while the CLI session is alive. Logs each attempt to its log file. Resolves Jun's EC-02 spec gap.
4. **Heartbeat = both ping/pong AND pipe-teardown detection (Jun's option c).** Daemon sends ping every 30s; extension responds with pong. Daemon also listens for pipe close events. EC-03 detection latency target: ≤5s via pipe teardown (fast path), ≤45s via missed-pong fallback (slow path). Both paths must mark the session "unreachable" the same way.

**Why:** User decision after the team's full review of Carter's extension-bridge spike + Noble Six's revised Phase 6 proposal + Kat's bot-side impact + Jun's test impact. Unblocks implementation kickoff.

**Implementation gates closed:**
- ✅ Noble Six's revised Phase 6 proposal moves from PROPOSED → LOCKED
- ✅ All three of Jun's hard blockers (pipe security, reconnect spec, heartbeat) now answered
- ⏳ Noble Six to finalize ADRs (1–4 from revised proposal + new ADRs for daemon account, reconnect policy, heartbeat protocol) before Carter starts coding
- ⏳ Test doubles (`FakeDaemon`, `FakeExtensionClient`) needed Days 1–2 per Jun

**Scope reminder:** Single-user-per-host model is now an explicit Phase 6 constraint. Multi-user-on-same-host is a Phase 7+ consideration if it ever comes up.




---

# Pipe Protocol — Carter (2026-05-19)

**To:** Jun (test doubles), Kat (install.ts)  
**From:** Carter  
**Date:** 2026-05-19

---

## Canonical Message Schema for `\\.\pipe\reach-bridge`

All messages are UTF-8 JSON, newline-delimited (JSON-Lines).  
Max frame size: **64 KB** (both directions).  
Pipe path: `\\.\pipe\reach-bridge`

---

### Inbound (extension → daemon)

#### `register` — first message sent by extension on every connect

```json
{ "type": "register", "sessionId": "<string>" }
```

- Must be the **first message** on every new pipe connection.
- `sessionId` = value of `SESSION_ID` env var (set by CLI).
- Daemon replies with `registered` or closes the connection on invalid sessionId.

#### `pong` — heartbeat reply

```json
{ "type": "pong", "id": "<uuid-v4>" }
```

- Must echo the exact `id` from the corresponding `ping`.
- Must arrive within the pong window (5 s) to avoid grace-period start.

#### `session.event` — CLI session event forwarded to daemon

```json
{ "type": "session.event", "sessionId": "<string>", "payload": { /* any object */ } }
```

- Extension sends this whenever a notable SDK session event occurs.
- `payload` shape TBD during relay refactor (Phase 6 Days 3–4).

#### `session.command-result` — result of a daemon-injected command

```json
{
  "type": "session.command-result",
  "sessionId": "<string>",
  "payload": { "text": "<response string>" }
}
```

Or on error:

```json
{
  "type": "session.command-result",
  "sessionId": "<string>",
  "payload": { "error": "<error message string>" }
}
```

---

### Outbound (daemon → extension)

#### `registered` — handshake acknowledgement

```json
{ "type": "registered", "sessionId": "<string>" }
```

- Sent immediately after a valid `register` is received.
- Signals that the extension is now the live relay for this sessionId.

#### `ping` — heartbeat probe (every 30 s)

```json
{ "type": "ping", "id": "<uuid-v4>" }
```

- Extension must reply with `pong` carrying the same `id` within 5 s.
- If no pong in 5 s: 15 s grace period begins. After grace: session evicted.

#### `session.command` — inject a message into the CLI session

```json
{
  "type": "session.command",
  "sessionId": "<string>",
  "payload": { "text": "<user message string>" }
}
```

- Extension calls `session.send(payload.text)` on the SDK session.
- Must reply with `session.command-result`.

---

## Connection Lifecycle

```
Extension                     Daemon
   │── connect ──────────────>│
   │── register ─────────────>│ (first message)
   │<── registered ───────────│
   │  (active, bidirectional) │
   │<── ping ─────────────────│ (every 30 s)
   │── pong ────────────────>│
   │<── session.command ──────│
   │── session.command-result>│
   │── session.event ─────────>│
   │── [pipe close] ──────────>│ (fast-path disconnect, <1 s)
```

---

## Jun: FakeDaemon implementation notes

- Spawn pipe server on a **configurable pipe name** (not hardcoded `reach-bridge`) so tests can run in parallel without collision.
- After accepting a connection: wait for `register`, then send `registered`.
- Expose `sendPing(sessionId)` → sends `ping` with new UUID, returns a Promise that resolves when `pong` arrives (with timeout).
- Expose `getMessages(sessionId)` → returns all inbound messages received from that session.
- Expose `sendCommand(sessionId, text)` → sends `session.command`.

## Jun: FakeExtensionClient implementation notes

- Connect to configured pipe name, send `register` with a test sessionId.
- Auto-reply to `ping` with matching `pong` (controllable: add `setPongEnabled(false)` to simulate missed heartbeat).
- Expose `getOutbound()` → all messages sent to daemon.
- Expose `waitForMessage(type)` → Promise that resolves on next message of given type.

---

## Kat: No protocol changes required

The bridge is completely isolated from `install.ts`. No action needed on this protocol.


---

# Test Doubles Contract — Message Schema

**Author:** Jun (Test Engineer)  
**Date:** 2026-05-19  
**Status:** DRAFT — awaiting Carter's `carter-pipe-protocol.md` to confirm alignment  
**Relates to:** ADR-3 (pipe protocol), ADR-7 (heartbeat), Phase 6 Day 1

---

## Purpose

This document records the exact message shapes used in `tests/helpers/FakeDaemon.ts`
and `tests/helpers/FakeExtensionClient.ts`. Carter should confirm that
`src/bridge/extensionBridge.ts` and `extension.mjs` use identical field names
and types. Any divergence is a contract break that will cause test doubles to
diverge from the real implementation.

---

## Wire Protocol

Per ADR-3:
- **Transport:** UTF-8 JSON, newline-delimited (JSON-Lines)
- **Framing:** One JSON object per line (`\n` delimiter, no embedded newlines in values)
- **Max line size:** 64 KB
- **Routing:** Every message includes a `sessionId` field

---

## Message Shapes

### Extension → Daemon (InboundMessage)

#### `hello` — extension registration (ADR-2)
```json
{
  "type": "hello",
  "sessionId": "string — Copilot CLI session ID",
  "sessionName": "string — human-readable name, e.g. 'reach-myapp'"
}
```
- Sent on connect and on every successful reconnect (ADR-6).
- Daemon responds with `session.registered`.

#### `pong` — heartbeat reply (ADR-7)
```json
{
  "type": "pong",
  "id": "string — must echo the UUID from the paired ping",
  "sessionId": "string"
}
```
- Must arrive within 5 s of the paired `ping`.
- Daemon matches by `id` to cancel the miss-detection timer.

#### `stream` — CLI response chunk (extension → daemon → relay)
```json
{
  "type": "stream",
  "sessionId": "string",
  "requestId": "string — correlates with the inject that triggered this response",
  "chunk": "string — partial response text",
  "done": "boolean — true on the final chunk of a response"
}
```

#### `stream.error` — CLI error notification
```json
{
  "type": "stream.error",
  "sessionId": "string",
  "requestId": "string",
  "error": "string — human-readable error description"
}
```

---

### Daemon → Extension (OutboundMessage)

#### `session.registered` — registration acknowledgement (ADR-2)
```json
{
  "type": "session.registered",
  "sessionId": "string"
}
```
- Sent immediately after a valid `hello` is received.

#### `ping` — heartbeat probe (ADR-7)
```json
{
  "type": "ping",
  "id": "string — unique ID for this ping (monotonic counter in FakeDaemon: 'ping-N')",
  "sessionId": "string"
}
```
- Sent every 30 s to each registered connection.
- Real implementation should use UUID v4; test double uses `ping-N` for readability.
- **Carter: confirm the real daemon uses `crypto.randomUUID()` here.**

#### `inject` — relay injects a message into the CLI session
```json
{
  "type": "inject",
  "sessionId": "string",
  "requestId": "string — unique per request, echoed in stream/stream.error replies",
  "text": "string — the Telegram message to send to Copilot"
}
```

---

## Heartbeat Timing (ADR-7)

| Parameter | Value | Controlled by |
|-----------|-------|---------------|
| Ping interval | 30 000 ms | `setInterval` in FakeDaemon.startHeartbeat() |
| Pong deadline | 5 000 ms | `setTimeout` set before _writeTo in _sendHeartbeat() |
| Grace period | 15 000 ms | `setTimeout` inside pong-deadline callback |
| Total worst-case | 50 000 ms | matches ADR-7 |

**Test-double note:** All timing uses standard `setTimeout`/`setInterval`.
Tests fake only those two (not `setImmediate`) so readline 'line' events still
fire synchronously through the in-memory PassThrough transport.

---

## Implementation Notes for Carter

1. **`hello` re-send on reconnect:** FakeExtensionClient calls `sendHello()`
   as a discrete step. The real `extension.mjs` must also re-send `hello`
   after every successful reconnect per ADR-6.

2. **Synchronous transport gotcha:** In the test doubles, PassThrough streams
   deliver data synchronously. The pong-deadline `setTimeout` handle must be
   registered in `pendingPings` *before* `_writeTo` is called, or the pong
   arrives and clears a handle that doesn't exist yet. Real named-pipe I/O is
   async so this race doesn't occur in production, but it's worth noting for
   local integration testing.

3. **`ping` id format:** Test double uses `ping-N` (monotonic counter).
   Production should use `crypto.randomUUID()`. Either format is valid as long
   as `pong.id === ping.id`.

4. **`requestId` generation:** Not specified in ADRs. Test double uses caller-
   supplied strings. Production should use `crypto.randomUUID()`.

---

## Files

| File | Role |
|------|------|
| `tests/helpers/FakeDaemon.ts` | In-process daemon double; in-memory transport |
| `tests/helpers/FakeExtensionClient.ts` | In-process extension double |
| `tests/helpers/fakePipe.smoke.test.ts` | 15-test smoke suite (all passing ✅) |

---

## Open Questions for Carter

- [ ] Confirm `ping.id` field name (docs say `id`, ADR-7 schema says `id` — matches ✅)
- [ ] Confirm `inject` message exists and uses field names `requestId` + `text`
- [ ] Confirm `stream.error` is the error shape (vs `error` top-level or embedded)
- [ ] Any additional message types in `extension.mjs` not captured above?
- [ ] Does `session.registered` carry any extra fields (e.g., timestamp)?


---

# Decision: install.ts Refactored to User-Account Service (ADR-5 Implementation)

**From:** Kat (Bot Dev)  
**To:** Carter (Pipe Server), Team  
**Date:** 2026-05-19  
**Status:** IMPLEMENTED

---

## What Changed

`src/service/install.ts` now installs Reach as a Windows Service running under the currently logged-in user account, not NetworkService/LocalSystem. This is the implementation of ADR-5.

### Key changes

- `install()` is now `async` — it resolves the current user then prompts for a Windows password before calling the SCM.
- `resolveCurrentUser()` uses `os.userInfo().username` + `process.env.USERDOMAIN` (no `LookupAccountName`, no spawned processes).
- `createService()` now accepts an optional `account: ServiceAccount` field. When provided, `logOnAs` is set in the node-windows config. When omitted (uninstall path), no `logOnAs` block is written.
- `promptPassword()` uses readline with echo suppressed via the `_writeToOutput` override pattern.
- `main()` is now `async` and wraps the top-level call in `.catch()`.

### API additions (exported)

```typescript
export interface ServiceAccount { username, domain, password }
export function resolveCurrentUser(): { username, domain }
export async function promptPassword(prompt): Promise<string>
```

---

## Impact on Carter (Named Pipe Server)

**The service now runs in the user's session.** This is the whole point of ADR-5:

- The named pipe `\\.\pipe\reach-bridge` will be created in a user-session context, not the LocalSystem/NetworkService context. This eliminates the DACL/integrity-level barrier that was blocking extension connections.
- The daemon process sees the current user's environment, so `%USERPROFILE%`, `%APPDATA%`, and any user-specific paths are correct.
- The service stops on logoff (expected behaviour for a single-user personal tool).

**No pipe protocol changes required** — this is purely a service account change.

---

## Trade-off Documented (Password Prompt)

`node-windows` requires a Windows account password to register a service under a user account (Windows SCM API requirement). A password-less path via Scheduled Task was considered but rejected because:
1. It would require dropping `node-windows` entirely.
2. Scheduled Tasks have different restart semantics (no SCM auto-restart on crash).
3. ADR-5 explicitly accepted the password cost: "Requires user password at install time. Acceptable — one-time cost."

The password is never stored — it is passed directly to `CreateService` via node-windows and lives only in memory during the install invocation.

---

## CLI Commands Preserved

No CLI changes. `npm run service:install` and `npm run service:uninstall` continue to work as before.

---

## Verification

- `npx tsc --noEmit` ✅
- `npm run lint` ✅
- `npx vitest run` — 296 passed, 4 skipped, 0 failed ✅
- Service install test suite: 22/22 passed ✅


---

# ADR-8: Canonical Pipe Wire Protocol

**Author:** Noble Six (Lead / Architect)  
**Date:** 2026-05-19  
**Status:** ACCEPTED  
**Supersedes:** Carter's `carter-pipe-protocol.md` and Jun's `jun-test-doubles-contract.md` (both were good-faith interpretations of ADR-3; neither was wrong — ADR-3 specified framing but not message shapes)

---

## Context

Carter and Jun executed Phase 6 Day 1 in parallel, as designed. Carter built the real pipe server (`extensionBridge.ts` + `extension.mjs`); Jun built the test doubles (`FakeDaemon.ts` + `FakeExtensionClient.ts`). Both compile, all 296 tests pass. But the two implementations disagree on six of eight protocol concerns:

| Concern | Carter (real) | Jun (test doubles) |
|---|---|---|
| Registration type | `register` | `hello` |
| Registration ack | `registered` | `session.registered` |
| Registration fields | `{type, sessionId}` | `{type, sessionId, sessionName}` |
| Command to CLI | `session.command` with `{text}` | `inject` with `{requestId, text}` |
| Response back | `session.command-result` with `{text}`/`{error}` | `stream` with `{requestId, chunk, done}` + `stream.error` |
| Event push | `session.event` with `{payload}` | (replaced by `stream`) |
| Ping sessionId | absent on `ping` | present on `ping` |
| Pong sessionId | absent on `pong` | present on `pong` |
| Heartbeat timing | 30s/5s/15s | 30s/5s/15s ✅ |

The root cause: ADR-3 locked the transport (JSON-Lines, single pipe, 64 KB frames, sessionId multiplexing) but left the exact message shapes unspecified. Both agents designed reasonable schemas independently.

The relay (`src/relay/relay.ts`) already streams Copilot responses chunk-by-chunk, editing a Telegram placeholder message at 800 ms intervals. Phase 6 replaces the direct SDK call with pipe-bridged communication. Any wire protocol that treats CLI responses as single-shot (`session.command-result` with one `text` blob) forces the extension to buffer the entire response before sending — destroying the streaming UX that Phase 5 built.

## Decision

Adopt Jun's streaming-oriented schema (`inject`/`stream`/`requestId`/`chunk`/`done`) as the canonical wire protocol, with targeted adjustments from Carter's design where his choices are simpler or more correct.

### Per-concern verdicts

**1. Registration type: `hello` (Jun's) ✅**

`hello` is the established term in ADR-2 ("sends a `hello` message") and ADR-6 ("re-sends `hello` on reconnect"). Carter's `register` is functionally identical but diverges from the language already locked in the ADR ledger. Keep `hello` for consistency with existing documentation.

*Trade-off:* `register` is arguably more descriptive of the action. Accepting a small readability cost to avoid a terminology split between ADR text and wire protocol.

**2. Registration ack: `session.registered` (Jun's) ✅**

Jun's `session.registered` is namespaced (`session.*`), which groups it with other session-lifecycle messages. Carter's `registered` is shorter but flat. In a multiplexed protocol with multiple message families, namespacing wins — it makes log grep, dispatch tables, and documentation easier.

*Trade-off:* One more `.` in the type string. Negligible wire cost.

**3. Registration fields: `sessionId` + `sessionName` (Jun's) ✅**

Jun added `sessionName` (human-readable, e.g. "reach-myapp"). The relay needs this to show session labels in Telegram messages. Without it, the daemon would need a separate lookup from `sessionId` → name via `listSessions()` on every registration — an extra async hop on a fast path.

*Trade-off:* Carter's extension currently reads only `SESSION_ID` from env. It will also need to read `SESSION_NAME` (or a similar env var set by the CLI). If the CLI doesn't set one, the extension should default `sessionName` to the `sessionId` value. This is a one-line change in `extension.mjs`.

**4. Command to CLI: `inject` with `{requestId, text}` (Jun's) ✅**

Jun's `inject` is a verb (correct — this is an imperative command from daemon to extension). Carter's `session.command` with `payload: { text }` wraps the text in an unnecessary `payload` envelope. `inject` is flatter and self-describing.

More importantly, Jun adds `requestId` — a correlation ID that ties every response chunk back to the command that triggered it. Without `requestId`, the daemon has no way to match incoming `stream` chunks to the original Telegram message that needs editing. The relay must correlate request → response to update the correct placeholder.

*Trade-off:* `inject` is less obviously a "session" message. Acceptable — the `sessionId` field provides the namespace.

**5. Response back: `stream` + `stream.error` (Jun's) ✅**

This is the decisive divergence. Carter's `session.command-result` returns a single `{text}` or `{error}` — the extension buffers the entire Copilot response and sends it in one shot. This destroys streaming.

Jun's design:
- `stream` with `{requestId, chunk, done}` — each SDK chunk is forwarded immediately. The daemon (and then the relay) can edit the Telegram placeholder in real time.
- `stream.error` with `{requestId, error}` — error case is a separate message type, not a field variant inside the same envelope. Cleaner dispatch.
- `done: true` on the final chunk signals completion without requiring a separate "end of response" message type.

This maps exactly onto how `relay.ts` already works: `for await (const chunk of session.send(text))` becomes chunk-by-chunk pipe messages that the daemon forwards to the relay.

*Trade-off:* More messages on the wire per response (one per SDK chunk vs. one blob). Negligible cost — chunks are small (typically <1 KB), pipe is localhost, and the alternative (buffering) defeats the entire streaming UX.

**6. Event push: `session.event` (Carter's, deferred) — RETAINED but DEFERRED**

Carter defined `session.event` as a generic event-forwarding channel. Jun replaced it entirely with `stream`/`stream.error`. Both are partially right.

Decision: Retain `session.event` in the canonical schema as a **future-use** message type for non-response events (tool calls, permission prompts, session lifecycle notifications). It is NOT used in the Day 2 migration or the Day 3–4 relay refactor. It stays in the type union for forward compatibility but has no handler yet.

*Trade-off:* Carrying a dead type in the union adds one unused branch in the dispatch switch. Removing it now and adding it later would require a protocol version bump. Cheaper to keep it.

**7. Ping: add `sessionId` (Jun's) ✅**

Jun's ping includes `sessionId`. Carter's does not (daemon broadcasts a single ping per connection, which is inherently 1:1 with a session). Jun's version is redundant on the wire but makes every message self-describing — any message can be logged, replayed, or debugged without knowing which socket it arrived on.

Decision: Include `sessionId` on `ping`. The daemon knows the sessionId for each connection; adding it costs 20–40 bytes per ping.

*Trade-off:* Slightly larger ping frame. Negligible.

**8. Pong: add `sessionId` (Jun's) ✅**

Same rationale as ping. Include `sessionId` on `pong` for self-describing messages.

---

## Canonical Message Schema

### Transport (restated from ADR-3)

- **Pipe path:** `\\.\pipe\reach-bridge`
- **Framing:** UTF-8 JSON, newline-delimited (JSON-Lines). One JSON object per `\n`-terminated line.
- **Max line size:** 64 KB
- **Routing:** Every message includes a `sessionId` field.

---

### Extension → Daemon (Inbound)

#### `hello` — registration (first message on every connect/reconnect)

```json
{
  "type": "hello",
  "sessionId": "abc-123",
  "sessionName": "reach-myapp"
}
```

- **Must** be the first message on every new pipe connection.
- **Must** be re-sent on every successful reconnect (ADR-6).
- `sessionId`: value of `SESSION_ID` env var (set by CLI).
- `sessionName`: human-readable label. Read from `SESSION_NAME` env var if available; fall back to `sessionId`.
- Daemon replies with `session.registered` or closes the connection on invalid `sessionId`.

#### `pong` — heartbeat reply

```json
{
  "type": "pong",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionId": "abc-123"
}
```

- `id` **must** echo the exact value from the corresponding `ping`.
- Must arrive within 5 s of the paired `ping` (ADR-7).

#### `stream` — CLI response chunk

```json
{
  "type": "stream",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "chunk": "Here is the first part of the response...",
  "done": false
}
```

Final chunk:

```json
{
  "type": "stream",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "chunk": "...and that's the end.",
  "done": true
}
```

- One `stream` message per SDK chunk received from `session.send()`.
- `requestId` correlates with the `inject` that triggered this response.
- `done: true` on the final chunk. Exactly one `done: true` per `requestId`.
- Empty `chunk` with `done: true` is valid (signals completion with no additional text).

#### `stream.error` — CLI error

```json
{
  "type": "stream.error",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "error": "SDK session crashed: ECONNRESET"
}
```

- Sent instead of (or after partial) `stream` chunks when the SDK call fails.
- Terminal: no more `stream` messages will arrive for this `requestId` after a `stream.error`.
- `error` is a human-readable string.

#### `session.event` — generic event (RESERVED, not yet implemented)

```json
{
  "type": "session.event",
  "sessionId": "abc-123",
  "payload": { "kind": "tool_call", "name": "read_file", "args": "..." }
}
```

- Reserved for future use (tool-call notifications, permission prompts, etc.).
- No handler required in Day 2 migration. Daemon should log and ignore unknown `session.event` payloads.

---

### Daemon → Extension (Outbound)

#### `session.registered` — registration acknowledgement

```json
{
  "type": "session.registered",
  "sessionId": "abc-123"
}
```

- Sent immediately after a valid `hello` is accepted.
- Signals the extension is the live relay for this `sessionId`.

#### `ping` — heartbeat probe

```json
{
  "type": "ping",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionId": "abc-123"
}
```

- Sent every 30 s to each registered connection.
- `id`: `crypto.randomUUID()` in production; test doubles may use `ping-N` counters.
- Extension **must** reply with `pong` carrying the same `id` within 5 s.

#### `inject` — relay sends a message into the CLI session

```json
{
  "type": "inject",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "text": "How do I fix the auth bug?"
}
```

- `requestId`: generated by the daemon (`crypto.randomUUID()`). Unique per inject.
- Extension calls `sdkSession.send(text)` and streams back `stream` chunks correlated by `requestId`.
- Extension **must not** batch — each SDK chunk should produce a `stream` message immediately.

---

## Heartbeat Timing (restated from ADR-7)

| Parameter | Value |
|-----------|-------|
| Ping interval | 30 000 ms |
| Pong deadline | 5 000 ms |
| Grace period | 15 000 ms |
| Total worst-case detection | 50 000 ms |

No changes. Both implementations already agree on timing.

---

## Reconnect / `hello`-Resend Rule (restated from ADR-6)

On successful pipe reconnect:

1. Extension re-sends `hello` with the same `sessionId` and `sessionName`.
2. Extension resets backoff counter to 0.
3. Daemon evicts any stale connection for the same `sessionId` (already implemented in `handleRegister()`).
4. Daemon sends `session.registered` ack.
5. Daemon resumes heartbeat pings to the new connection.

The `hello`-on-reconnect rule is load-bearing: it re-establishes the session mapping. An extension that reconnects without `hello` will never receive `inject` messages.

---

## Migration Tasks

### Carter — `extensionBridge.ts` + `extension.mjs` (Day 2)

These are the changes Carter must make to align the real implementation with this ADR.

#### `extensionBridge.ts` (daemon side)

1. **Rename `register` → `hello` in message types and dispatch.**
   - `RegisterMessage.type` → `'hello'`
   - `handleLine()` switch case: `'register'` → `'hello'`
   - `handleRegister()` → `handleHello()` (or keep name, just change the case label)

2. **Add `sessionName` field to `HelloMessage` interface.**
   ```typescript
   export interface HelloMessage {
     type: 'hello';
     sessionId: string;
     sessionName: string;
   }
   ```
   - Store `sessionName` on `InternalConnection` so the daemon can expose it via `getSession()`.

3. **Rename `registered` → `session.registered` in outbound ack.**
   - `RegisteredMessage.type` → `'session.registered'`
   - Update the `conn.send()` call in `handleHello()`.

4. **Add `sessionId` to `PingMessage`.**
   ```typescript
   export interface PingMessage {
     type: 'ping';
     id: string;
     sessionId: string;
   }
   ```
   - Update `sendPing()` to include `sessionId: conn.sessionId`.

5. **Replace `session.command` → `inject` with `requestId`.**
   ```typescript
   export interface InjectMessage {
     type: 'inject';
     sessionId: string;
     requestId: string;
     text: string;
   }
   ```
   - Update `sendCommand()` to generate `requestId` via `randomUUID()` and send flat `{type, sessionId, requestId, text}`.
   - Return the `requestId` from `sendCommand()` so callers can correlate responses.

6. **Replace `session.command-result` listener with `stream` + `stream.error` handling.**
   ```typescript
   export interface StreamChunkMessage {
     type: 'stream';
     sessionId: string;
     requestId: string;
     chunk: string;
     done: boolean;
   }

   export interface StreamErrorMessage {
     type: 'stream.error';
     sessionId: string;
     requestId: string;
     error: string;
   }
   ```
   - Add `'stream'` and `'stream.error'` cases to `handleLine()` dispatch.
   - Emit typed events: `this._emitter.emit('stream', sessionId, requestId, chunk, done)` and `this._emitter.emit('stream.error', sessionId, requestId, error)`.
   - Update `BridgeEmitter` interface with new event signatures.

7. **Update `PongMessage` to expect `sessionId`.**
   - Add `sessionId: string` to `PongMessage` interface.
   - No behavioral change needed (daemon already matches by `id`).

8. **Retain `session.event` in type union** but no handler changes needed (existing `'session.event'` case in dispatch can stay as-is; mark it as reserved).

#### `extension.mjs` (extension side)

1. **Rename `register` → `hello` in outbound registration.**
   - Change `sendToDaemon({ type: 'register', sessionId: SESSION_ID })` to `sendToDaemon({ type: 'hello', sessionId: SESSION_ID, sessionName: SESSION_NAME })`.
   - Add `const SESSION_NAME = process.env['SESSION_NAME'] ?? SESSION_ID;` near `SESSION_ID`.

2. **Rename `registered` → `session.registered` in inbound dispatch.**
   - `handleMessage()` switch: `'registered'` → `'session.registered'`.

3. **Add `sessionId` to outbound `pong`.**
   - Change `sendToDaemon({ type: 'pong', id: msg.id })` to `sendToDaemon({ type: 'pong', id: msg.id, sessionId: SESSION_ID })`.

4. **Rename `session.command` → `inject` in inbound dispatch.**
   - Switch case: `'session.command'` → `'inject'`.
   - Update `handleCommand()` signature to receive `{type, sessionId, requestId, text}` (flat, no `payload` wrapper).

5. **Replace single-shot `session.command-result` with streaming `stream` chunks.**
   - Instead of `for await ... accumulated += chunk ... sendToDaemon({ type: 'session.command-result' })`:
   ```javascript
   const requestId = msg.requestId;
   try {
     for await (const chunk of sdkSession.send(msg.text)) {
       sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk, done: false });
     }
     sendToDaemon({ type: 'stream', sessionId: SESSION_ID, requestId, chunk: '', done: true });
   } catch (err) {
     sendToDaemon({ type: 'stream.error', sessionId: SESSION_ID, requestId, error: err.message });
   }
   ```
   - This is the most important change — it enables real-time streaming through the pipe.

---

### Jun — `FakeDaemon.ts` + `FakeExtensionClient.ts` (Day 2)

Jun's test doubles are already aligned with this ADR. Changes are minor:

1. **No message type renames needed.** Jun's types (`hello`, `session.registered`, `inject`, `stream`, `stream.error`, `ping` with `sessionId`, `pong` with `sessionId`) are the canonical schema.

2. **Verify `sessionName` default.** Ensure `FakeExtensionClient` constructor continues to require `sessionName`. No change needed if it already does (confirmed: constructor takes `(sessionId, sessionName)`).

3. **Add `session.event` to `InboundMessage` union** for forward compatibility:
   ```typescript
   export type SessionEventMessage = {
     type: 'session.event';
     sessionId: string;
     payload: unknown;
   };
   ```
   Add to `InboundMessage` union. `_handleInbound()` default case already handles unknown types by recording them — no dispatch change needed.

4. **Update TODO comments.** Remove the "awaiting Carter's protocol doc" TODOs from both files — this ADR is the source of truth.

---

### Relay Refactor — Phase 6 Days 3–4

The relay team (likely Carter + Jun) will need to integrate the pipe bridge into `relay.ts`. Here's what the wire protocol means for them:

1. **Sending a user message:** The relay calls `bridge.sendCommand(sessionId, text)` (or renamed to `bridge.inject(sessionId, text)`). The bridge generates a `requestId`, sends `inject` over the pipe, and returns the `requestId`.

2. **Receiving streaming response:** The relay subscribes to bridge events:
   ```typescript
   bridge.on('stream', (sessionId, requestId, chunk, done) => {
     // Edit the Telegram placeholder with accumulated text
     // When done === true, send the final formatted message
   });

   bridge.on('stream.error', (sessionId, requestId, error) => {
     // Edit placeholder with error message
   });
   ```

3. **Correlation:** `requestId` ties each `stream` chunk back to the Telegram message that needs editing. The relay maintains a `Map<requestId, { chatId, messageId, accumulated }>` to track in-flight responses.

4. **Throttling:** The existing 800 ms edit throttle in `relay.ts` applies unchanged — the relay accumulates chunks between edits, same as today.

5. **Message splitting:** After `done: true`, the relay runs the accumulated response through `splitForTelegram()` for the final formatted delivery, same as today.

6. **Error path:** `stream.error` replaces the `catch` block on the `for await` loop. The relay edits the placeholder with `❌ Error: ${error}`.

7. **The `session.event` type is NOT used** in the Day 3–4 relay refactor. It's reserved for future features (tool-call streaming, permission prompts via Telegram).

---

## Summary of Canonical Types

| Direction | Type | Fields | Purpose |
|-----------|------|--------|---------|
| ext → daemon | `hello` | `type, sessionId, sessionName` | Registration |
| ext → daemon | `pong` | `type, id, sessionId` | Heartbeat reply |
| ext → daemon | `stream` | `type, sessionId, requestId, chunk, done` | Response chunk |
| ext → daemon | `stream.error` | `type, sessionId, requestId, error` | Response error |
| ext → daemon | `session.event` | `type, sessionId, payload` | Reserved (future) |
| daemon → ext | `session.registered` | `type, sessionId` | Registration ack |
| daemon → ext | `ping` | `type, id, sessionId` | Heartbeat probe |
| daemon → ext | `inject` | `type, sessionId, requestId, text` | Send message to CLI |

---

## Consequences

✅ Streaming is preserved end-to-end: SDK chunk → `stream` message → daemon event → relay edit → Telegram placeholder update.  
✅ `requestId` correlation enables concurrent inject/response pairs on the same session (future: tool-call results while response is streaming).  
✅ Self-describing messages (every message has `sessionId`) simplify logging and debugging.  
✅ Forward-compatible: `session.event` reserved for future event types without protocol version bump.  
✅ Test doubles are already 95% aligned — minimal migration for Jun.

❌ Carter has the larger migration (~8 changes across two files). Trade-off accepted: fixing the protocol now is cheaper than fixing it after the relay refactor when three files depend on the wrong shapes.  
❌ `sessionName` requires the extension to read a new env var. If the CLI doesn't set `SESSION_NAME`, the fallback (`sessionId`) is functional but less readable in Telegram. Acceptable — we can add the env var to the CLI extension loader later.  
❌ More wire messages per response (chunk-by-chunk vs. one blob). Negligible cost on localhost pipe.

---

*Signed: Noble Six, 2026-05-19*

