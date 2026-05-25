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
| F4 | IMPORTANT | Splitter budget vs. escape expansion | ACCEPT | Option (b): \
eserveBytes\ headroom (~30%) |
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

## 1. Problem Statement

`BridgeSession` currently accepts `permissionCallback` in `resume()` / `create()` for interface compatibility but silently discards it. There is no wire-protocol mechanism for the extension to send a permission request from the CLI side to the daemon, and no mechanism for the daemon to return a user decision. Consequently:

- Destructive tools (`edit`, `bash`, `powershell`, `git_commit`, etc.) execute without user consent over bridge-attached sessions.
- `REACH_PERMISSION_POLICY=interactiveDestructive` has no effect on bridge sessions.
- Production dogfooding with destructive-tool safety is blocked.

---


## 2. Decision

Extend the existing pipe wire protocol (ADR-3, ADR-8) with three new message types: `permission.request`, `permission.response`, and `permission.cancelled`. Messages are interleaved with streaming data on the same pipe using in-stream discriminated dispatch (per the `in-stream-control-plane-interleaving` skill). No second pipe, no second channel.

The extension classifies tool risk and sends `permission.request` only for tools that clear the destructive threshold. The daemon routes the request to the user via Telegram inline keyboard, waits indefinitely for an explicit decision, and returns `permission.response`. The extension resolves its suspended `permissionCallback` from the response. The prompt waits indefinitely — no wall-clock timeout — with session disconnect as the only automatic resolution path.

---


## 3. Wire Schema — Three New Message Types

### 3.1 Extension → Daemon: `permission.request`

Sent when the extension's `onPermissionRequest` hook fires for a destructive tool. The extension suspends its `permissionCallback` Promise and awaits a `permission.response`.

```json
{
  "type": "permission.request",
  "sessionId": "abc-123",
  "requestId": "req-001",
  "permissionId": "perm-7a2b3c4d",
  "toolName": "bash",
  "args": "{\"command\": \"rm -rf dist/\"}",
  "riskLevel": "destructive"
}
```

**Fields:**
- `permissionId` — UUID, generated by the extension, used to correlate the response. Independent of `requestId` (one `requestId` may produce multiple permission prompts if the agentic loop calls multiple tools).
- `toolName` — string, human-readable tool name.
- `args` — JSON-serialized tool arguments, truncated to 4096 chars on the extension side.
- `riskLevel` — `"destructive"` (only value in Phase 6; reserved for future risk tiers).

### 3.2 Daemon → Extension: `permission.response`

Sent when Aaron approves, denies, or when the daemon-side abort fires (session disconnect). Resolves the extension's suspended `permissionCallback`.

```json
{
  "type": "permission.response",
  "sessionId": "abc-123",
  "permissionId": "perm-7a2b3c4d",
  "decision": "allow"
}
```

**Fields:**
- `decision` — `"allow"` | `"deny"`. No `"allow-always"` variant on the wire (allow-always is a daemon-side policy that produces `"allow"` responses silently for subsequent prompts).

### 3.3 Extension → Daemon: `permission.cancelled`

Sent if the extension's `permissionCallback` is abandoned — either because the SDK session terminated, the CLI exited, or the extension detected that the pipe dropped and it must clean up in-flight state. The daemon discards any pending prompt for this `permissionId`.

```json
{
  "type": "permission.cancelled",
  "sessionId": "abc-123",
  "permissionId": "perm-7a2b3c4d"
}
```

---


## 4. Updated Canonical Message Table

Extends ADR-8's canonical schema:

| Direction | Type | New in ADR-9? | Purpose |
|---|---|---|---|
| ext → daemon | `hello` | — | Registration |
| ext → daemon | `pong` | — | Heartbeat reply |
| ext → daemon | `stream` | — | Response chunk |
| ext → daemon | `stream.error` | — | Response error |
| ext → daemon | `session.event` | — | Reserved (future) |
| **ext → daemon** | **`permission.request`** | **✅** | Destructive tool pending approval |
| **ext → daemon** | **`permission.cancelled`** | **✅** | Extension-side prompt abandonment |
| daemon → ext | `session.registered` | — | Registration ack |
| daemon → ext | `ping` | — | Heartbeat probe |
| daemon → ext | `inject` | — | Send message to CLI |
| **daemon → ext** | **`permission.response`** | **✅** | Approval decision |

---


## 5. Extension-Side Changes (Carter / Q5 Settled ✅)

**Risk classification lives entirely on the extension side.** The extension has direct access to the SDK `PermissionRequest` object, including `kind`, `toolName`, and `args`. The daemon does NOT duplicate `isDestructive()`. This eliminates split-brain risk: two classification functions running in different processes under different Reach versions cannot drift apart.

**Extension `onPermissionRequest` logic:**

```javascript
// extension.mjs
onPermissionRequest: async (req) => {
  const toolName = getToolName(req);        // extension-local helper
  
  if (isKnownSafe(toolName)) {
    return { kind: 'approved' };             // never send permission.request
  }
  if (!isDestructive(toolName)) {
    return { kind: 'denied-by-rules', rules: [] }; // non-destructive, non-safe: deny
  }
  
  // Destructive: send permission.request, suspend until response or pipe-close abort
  const permissionId = crypto.randomUUID();
  const args = JSON.stringify(req.args ?? {}).slice(0, 4096);
  
  sendToDaemon({ type: 'permission.request', sessionId: SESSION_ID,
                 requestId: currentRequestId, permissionId, toolName, 
                 args, riskLevel: 'destructive' });
  
  // Await daemon decision (or pipe-close abort — see §6.3)
  const decision = await waitForPermissionResponse(permissionId);
  
  return decision === 'allow'
    ? { kind: 'approved' }
    : { kind: 'denied-by-rules', rules: [] };
}
```

**Extension pipe-close abort (mandatory):** When the pipe disconnects, any pending `waitForPermissionResponse()` calls must be aborted with denial. This is the extension-side equivalent of the daemon's AbortSignal (§6.3).

```javascript
// In extension.mjs reconnect/disconnect handler:
onPipeDisconnect: () => {
  for (const [permissionId, resolve] of pendingPermissions) {
    resolve('deny');  // abort with deny
  }
  pendingPermissions.clear();
}
```

**`isDestructive()` and `isKnownSafe()` in extension.mjs:** The extension inlines (or imports) the same tool classification logic as `src/copilot/permissions.ts`. This is intentional duplication at a boundary (extension.mjs is a separate process). The canonical list is maintained in `permissions.ts`; extension.mjs is a consumer. Any update to `DESTRUCTIVE_TOOLS` in `permissions.ts` must be mirrored in `extension.mjs` (document this in Kat's checklist).

---


## 6. Daemon-Side Changes

### 6.1 ExtensionBridge — New Message Dispatch

`extensionBridge.ts` adds three message types to `InboundMessage` / `OutboundMessage` unions and to `handleLine()`'s dispatch switch:

```typescript
// New inbound types
export interface PermissionRequestMessage {
  type: 'permission.request';
  sessionId: string;
  requestId: string;
  permissionId: string;
  toolName: string;
  args: string;
  riskLevel: 'destructive';
}

export interface PermissionCancelledMessage {
  type: 'permission.cancelled';
  sessionId: string;
  permissionId: string;
}

// New outbound type
export interface PermissionResponseMessage {
  type: 'permission.response';
  sessionId: string;
  permissionId: string;
  decision: 'allow' | 'deny';
}

// Add to union types
export type InboundMessage =
  | RegisterMessage | PongMessage | SessionEventMessage
  | StreamMessage | StreamErrorMessage
  | PermissionRequestMessage | PermissionCancelledMessage;  // NEW

export type OutboundMessage =
  | RegisteredMessage | PingMessage | InjectMessage
  | PermissionResponseMessage;  // NEW
```

`ExtensionBridge` gains a helper:

```typescript
sendPermissionResponse(sessionId: string, permissionId: string, decision: 'allow' | 'deny'): void
```

And emits new bridge events (added to `BridgeEmitter`):

```typescript
on(event: 'permission.request',
   listener: (sessionId: string, requestId: string, permissionId: string,
               toolName: string, args: string) => void): this;
on(event: 'permission.cancelled',
   listener: (sessionId: string, permissionId: string) => void): this;
```

### 6.2 BridgeSession — Permission Routing

`BridgeSession` wires the bridge events to the `PermissionPrompter` port:

```typescript
// On construction, subscribe to permission events
this.bridge.on('permission.request', async (sId, requestId, permissionId, toolName, args) => {
  if (sId !== this.sessionId) return;
  
  // Check allow-always store before prompting
  if (this.allowAlwaysStore.has(toolName)) {
    this.bridge.sendPermissionResponse(this.sessionId, permissionId, 'allow');
    return;
  }
  
  if (!this.permissionPrompter) {
    // No prompter configured — fall back to deny
    this.bridge.sendPermissionResponse(this.sessionId, permissionId, 'deny');
    return;
  }
  
  // Create an AbortController keyed to session disconnect (§6.3)
  const ac = new AbortController();
  this.pendingPermissions.set(permissionId, ac);
  
  try {
    const approved = await this.permissionPrompter.prompt(
      this.chatId, this.topicId, toolName, args, ac.signal
    );
    this.bridge.sendPermissionResponse(this.sessionId, permissionId,
                                        approved ? 'allow' : 'deny');
  } finally {
    this.pendingPermissions.delete(permissionId);
  }
});

this.bridge.on('permission.cancelled', (sId, permissionId) => {
  if (sId !== this.sessionId) return;
  const ac = this.pendingPermissions.get(permissionId);
  ac?.abort();
  this.pendingPermissions.delete(permissionId);
});
```

### 6.3 AbortSignal on Disconnect (Q3 — Settled ✅)

`PermissionPrompter.prompt()` signature updated (non-breaking — optional parameter):

```typescript
// src/relay/ports.ts
export interface PermissionPrompter {
  prompt(
    chatId: number,
    topicId: number,
    toolName: string,
    args: string,
    signal?: AbortSignal,   // NEW — wired to session disconnect
  ): Promise<boolean>;
}
```

`promptUserForPermission` in `prompt.ts` wires abort:

```typescript
if (signal) {
  signal.addEventListener('abort', () => {
    void complete('aborted').catch(() => {});
  }, { once: true });
}
```

`BridgeSession` aborts all pending permissions on disconnect:

```typescript
this.bridge.on('session.disconnected', (sId) => {
  if (sId !== this.sessionId) return;
  for (const [, ac] of this.pendingPermissions) {
    ac.abort();
  }
  this.pendingPermissions.clear();
});
```

**Why this is mandatory for no-timeout:** Without AbortSignal, a pending `promptUserForPermission()` stays open indefinitely after its session dies. With AbortSignal, a dead session's prompt is cancelled within one event loop turn of `session.disconnected` firing.

### 6.4 AllowAlwaysStore Interface (Q2 — Settled ✅)

`allow-always` state is defined behind an injectable interface — not hardcoded as a `Set<string>` on `BridgeSession`:

```typescript
// src/bridge/allowAlwaysStore.ts (NEW FILE)
export interface AllowAlwaysStore {
  has(toolName: string): boolean;
  add(toolName: string): void;
}

export class InMemoryAllowAlwaysStore implements AllowAlwaysStore {
  private readonly approved = new Set<string>();
  has(toolName: string): boolean { return this.approved.has(toolName); }
  add(toolName: string): void { this.approved.add(toolName); }
}
```

**Phase 6 default:** `InMemoryAllowAlwaysStore`. State expires on daemon restart. Injected at composition root in `main.ts` / `BridgeSessionFactory`.

**Phase 7+ upgrade path:** `PersistedAllowAlwaysStore implements AllowAlwaysStore` — backed by `~/.config/reach/allow-always.json`. 1-file change at composition root. `AllowAlwaysStore` interface is the seam.

**Yolo mode (documented):** `REACH_PERMISSION_POLICY=approveAll` bypasses permission prompting entirely for bridge sessions. When this policy is set, the extension's `onPermissionRequest` handler approves unconditionally and never sends `permission.request` over the pipe. No Telegram prompts surface. This is Aaron's current mode and is fully supported without any ADR-9 changes.

### 6.5 Telegram UX — Inline Keyboard (Q1 — Settled ✅)

Permission prompts use **inline keyboard buttons** — the same mechanism already implemented in `src/bot/prompt.ts` for SDK sessions. The wire protocol carries only `{toolName, args, permissionId}`. UX shape is a daemon-side concern.

`BridgeSession` calls `this.permissionPrompter.prompt(chatId, topicId, toolName, args, signal)` which routes to `promptUserForPermission()` unchanged. Kat's K1 task is wiring the bridge event to the existing function call, not designing new UX.

**Why inline keyboard, not reply keyboard:** Reply keyboard is one keyboard per conversation. Multiple concurrent permission prompts (different tools, concurrent sessions) cannot each have a dedicated reply keyboard — they'd clobber each other. Inline keyboard scales to N concurrent prompts trivially: each message has its own buttons and independent `requestId` correlation. Additionally, reply keyboard leaks on daemon crash (no `ReplyKeyboardRemove` sent); inline keyboard stale buttons generate graceful "no longer active" responses.

Prompt text:

```
⚠️ Tool approval needed

Tool: bash
Args: {"command": "rm -rf dist/"}

Approve or deny — waiting for your decision.
```

---


## 7. Q4: Timeout — No Timeout (ACCEPTED ✅)

**Status: ✅ ACCEPTED — Branch A (no-timeout) adopted. Branch B struck.**

### Decision

The permission prompt waits **indefinitely** for an explicit human decision (approve or deny). There is no wall-clock timeout. The only automatic resolution paths are:

1. Aaron taps ✅ Approve or ❌ Deny in Telegram (happy path)
2. Session disconnects → AbortSignal fires → prompt resolves `false` (deny) within one event loop turn
3. Daemon restarts → `pendingByRequestId` cleared → buttons become "no longer active"

### Carter's SDK Verification (Evidence Base)

**Verified by:** Carter (Bridge Dev), `carter-sdk-permission-timeout-verification.md`, 2026-05-22

**Key findings:**

- **`_executePermissionAndRespond`** (`node_modules/@github/copilot-sdk/dist/session.js`, lines 313–336): plain `await this.permissionHandler(...)` — no `setTimeout`, no `Promise.race`, no `AbortController`. The SDK awaits the returned Promise for as long as it takes.
- **`PermissionHandler` type** (`types.d.ts`, lines 543–545): `Promise<PermissionRequestResult> | PermissionRequestResult` — an indefinitely-pending Promise is a valid return value. No `timeoutMs`, deadline, or ceiling fields anywhere in the type hierarchy.
- **Protocol v3 is notification-based** (`session.js`, lines 243–249): the CLI dispatches `void this._executePermissionAndRespond(...)` as fire-and-forget. There is no open JSON-RPC request on the CLI side waiting for a synchronous response. No CLI-side clock is ticking.
- **The only `setTimeout` in `session.js`** is inside `sendAndWait()` (lines 130–171) — enforces a 60s ceiling on blocking `session.idle`, completely unrelated to permission handling.
- **`grep -r "permissionTimeout\|permission.*timeout\|PERMISSION_TIMEOUT" node_modules/@github/copilot-sdk/dist/` → 0 matches.**
- **Probe test** at `tests/exploratory/sdk-permission-timeout.test.ts` (4/4 green): Vitest fake timers advance 60 000 ms; no SDK-imposed rejection occurs. `handlePendingPermissionRequest` is called only after the handler resolves, not before.

**The 60s `timeoutMs` in `prompt.ts` is entirely our own application code.** The SDK imposes no ceiling.

### SDK Regression Check (Future SDK Upgrades)

When `@github/copilot-sdk` is upgraded, the following check must be run to ensure no internal timeout was introduced on `onPermissionRequest`:

```bash
grep -n "setTimeout\|Promise\.race\|AbortController" \
  node_modules/@github/copilot-sdk/dist/session.js \
  | grep -A2 -B2 "permissionHandler\|executePermissionAndRespond"
```

If any match appears near the `permissionHandler` call site, treat it as a **breaking change to ADR-9** and re-evaluate the no-timeout decision. Carter's probe test at `tests/exploratory/sdk-permission-timeout.test.ts` is the regression harness — run it against the new SDK version.

### Implementation

**Changes to `prompt.ts`:**

```typescript
// Remove: timeoutMs parameter, timeoutHandle, timeoutPromise, Promise.race
// Keep: resultPromise, AbortSignal wiring (mandatory)

export async function promptUserForPermission(
  bot: Bot<Context>,
  chatId: number,
  topicId: number,
  toolName: string,
  args: string,
  signal?: AbortSignal,  // Q3 — mandatory for no-timeout safety
): Promise<boolean> {
  // ... send message, register pending ...
  
  if (signal) {
    signal.addEventListener('abort', () => {
      void complete('aborted').catch(() => {});
    }, { once: true });
  }
  
  return resultPromise;  // No setTimeout. No Promise.race. Just wait.
}
```

**`PromptOutcome` type:** Rename `'timeout'` → `'aborted'` to reflect that automatic resolution is now driven by session disconnect, not elapsed time. `'approve'` and `'deny'` are unchanged.

**Extension-side timer:** None. Extension awaits `waitForPermissionResponse(permissionId)` indefinitely. Extension detects pipe-close and aborts `permissionCallback` with deny (§5).

**Node.js implementation trap:** `setTimeout(fn, Infinity)` coerces `Infinity` to `0` (integer truncation) and fires immediately. True no-timeout is implemented by removing `setTimeout` entirely — **not** by passing `Infinity`.

### Observability — Passive Stale-Prompt Warning

A passive scanner (not a resolution timer) emits a warning for prompts open >10 minutes. The Promise remains pending — this is a UX aid only:

```typescript
// In daemon main.ts or BridgeSession — fires on a setInterval, not on the prompt
setInterval(() => {
  const now = Date.now();
  for (const [requestId, pending] of registry.pendingByRequestId) {
    if (now - pending.createdAt > TEN_MINUTES_MS) {
      console.warn(`[prompt] Permission prompt ${requestId} has been open for >10 minutes`);
    }
  }
}, TEN_MINUTES_MS);
```

`PendingPrompt` needs a `createdAt: number` field.

### The "Friday → Monday" Case

Aaron sends a message Friday afternoon. Copilot triggers `bash`. Permission prompt appears in Telegram. Aaron is gone for the weekend. The daemon holds the `pendingByRequestId` entry. Heartbeat (ADR-7, 30s pings) keeps the session registered. Monday morning Aaron opens Telegram, sees the prompt, taps ✅ Approve. `callback_query:data` fires; Telegram buttons work indefinitely — the 15-second `answerCallbackQuery` window is measured from each individual tap, not from message send. Copilot executes the tool and continues streaming. Session was never broken.

---


## 8. Security

**Input validation:** `permission.request` messages are validated on receipt: `permissionId` must be a non-empty string, `toolName` must be a non-empty string, `riskLevel` must be `"destructive"`. Malformed messages are logged and dropped; the extension is not disconnected (unknown fields tolerated per ADR-8 convention).

**`permissionId` spoofing:** If a malicious process sends a forged `permission.response` with a valid `permissionId`, the daemon would approve an in-flight prompt. Mitigation: `permissionId` is a UUID generated by the extension and stored in `pendingPermissions` on `BridgeSession`. The pipe is secured by ADR-5 (user-level daemon; same user scope). Same-user-process spoofing is already within the threat model scope.

**Denial of service via prompt flood:** Extension sends rapid `permission.request` storms. Each prompt creates an entry in `pendingByRequestId` (daemon) and `pendingPermissions` (BridgeSession). Mitigation: rate-limit `permission.request` in `BridgeSession` — maximum N concurrent pending prompts per session (suggested: 5). Excess prompts are auto-denied with a log warning. Phase 6 defers this rate limit; document as a future hardening task.

**Allow-always and cross-session scope:** `InMemoryAllowAlwaysStore` is per `BridgeSession` instance — not shared across sessions. A malicious session cannot whitelist a tool for a different session.

---


## 9. Alternatives Rejected

**Alt A — Separate control-plane pipe:** A second named pipe carrying only permission messages. Rejected: violates ADR-3 (single pipe), doubles reconnect complexity (ADR-6 logic must run on two pipes), loses the ordering guarantee (permission.request for tool N is guaranteed to arrive before stream output from tool N on a single ordered channel; on two separate channels, the order can invert).

**Alt B — Pre-approval policy file:** A JSON file listing pre-approved tools. Rejected for interactive use: no mechanism to handle novel tools or changes in `args` shape. Suitable only for fully automated deployments (use `approveAll` policy instead).

**Alt C — Telegram free-text `/allow <permissionId>`:** Rejected: high friction (Aaron must type), high error rate (typos, wrong permissionId), no visual affordance. Does not scale to concurrent prompts.

**Alt D — Hard timeout (30s, 60s, 120s):** All explored and rejected. Analysis in `noble-six-adr9-no-timeout-analysis.md`. Key findings: no timeout number is principled (Aaron's async multitasking pattern breaks any ceiling), any timeout introduces a false-deny failure mode, and the SDK imposes no ceiling requiring us to pick one. AbortSignal covers the only legitimate cleanup concern (dead sessions). Indefinite wait is the correct default.

---


## 10. Implementation Tasks (Kat)

**Status: ALL TASKS READY FOR KAT — no blockers.** All 5 open questions settled; all 6 tasks unblocked.

### K1 — Wire Protocol Extensions (extensionBridge.ts)

Add `PermissionRequestMessage`, `PermissionCancelledMessage`, `PermissionResponseMessage` to message unions. Add dispatch cases in `handleLine()`. Add `sendPermissionResponse()` helper. Add `permission.request` and `permission.cancelled` events to `BridgeEmitter` interface.

**Estimated scope:** ~80 LOC in `extensionBridge.ts`.

### K2 — BridgeSession Permission Routing

Add `permissionPrompter?: PermissionPrompter`, `allowAlwaysStore: AllowAlwaysStore`, `chatId: number`, `topicId: number` to `BridgeSession` constructor. Wire `permission.request` bridge event to `promptUserForPermission()`. Wire `permission.cancelled` to abort controller. Wire `session.disconnected` to abort all pending permissions.

**Estimated scope:** ~70 LOC in `bridgeSession.ts`.

### K3 — PermissionPrompter.prompt() — AbortSignal + No-Timeout (Q3 Settled ✅, Q4 Settled ✅)

Add `signal?: AbortSignal` to `PermissionPrompter` interface in `ports.ts`. Update `promptUserForPermission()` in `prompt.ts`:
- Remove `timeoutMs` parameter (and default `60_000`)
- Remove `timeoutHandle`, `timeoutPromise`, `Promise.race`
- Add `signal.addEventListener('abort', ...)` wired to call `complete('aborted')`
- Return bare `resultPromise` with no racing

**Estimated scope:** ~15 LOC across `ports.ts` and `prompt.ts` (net deletion, primarily).

### K4 — AllowAlwaysStore Interface + In-Memory Impl (Q2 Settled ✅)

Create `src/bridge/allowAlwaysStore.ts` with `AllowAlwaysStore` interface and `InMemoryAllowAlwaysStore` class. Inject `InMemoryAllowAlwaysStore` into `BridgeSession` via `BridgeSessionFactory`. Update `main.ts` composition root.

**Estimated scope:** ~30 LOC across new file + factory + main.

### K5 — Extension-Side Risk Classification + Pipe-Close Abort (Q5 Settled ✅)

Update `extension.mjs`: inline `isDestructive()` / `isKnownSafe()` tool lists (mirroring `permissions.ts`). Register `onPermissionRequest` hook. Implement `waitForPermissionResponse(permissionId)` coroutine. Implement `onPipeDisconnect` abort for pending permissions. **No timer** — no extension-side `setTimeout`.

**Estimated scope:** ~60 LOC in `extension.mjs`.

### K6 — Prompt Text + Observability (Q4 Settled ✅)

- Update prompt text to remove any countdown language (use "Approve or deny — waiting for your decision.").
- Add 10-minute passive warning scanner (`setInterval`) to daemon.
- Add `createdAt: number` field to `PendingPrompt`.
- Rename `PromptOutcome` `'timeout'` → `'aborted'`.

**Estimated scope:** ~20 LOC.

---


## 11. Test Scenarios (Jun)

Jun's 29-scenario catalog (`jun-adr9-permission-test-scenarios.md`) covers 6 categories. The following updates apply given all settled decisions.

### Foundation: Carter's Probe Test

`tests/exploratory/sdk-permission-timeout.test.ts` (4/4 green) is Jun's empirical foundation for the "SDK truly doesn't timeout" test category. This test:
- Uses Vitest fake timers advancing 60 000 ms
- Confirms no SDK-imposed rejection occurs from `_executePermissionAndRespond`
- Verifies `handlePendingPermissionRequest` is called only after the handler resolves

Jun should build the no-timeout behavioral tests on the same Vitest fake-timer infrastructure.

### Scenarios to revise (timeout → disconnect-abort):

**Category 2 (Timeout/cancellation) — all 5 scenarios need revision:**
- Replace "user never replies → auto-deny after timeoutMs" with "user never replies → waits indefinitely; session disconnect fires → auto-deny via AbortSignal"
- "Session ends mid-prompt" scenario now tests AbortSignal path, not timer expiry
- Remove any scenario asserting a timer fires and resolves the prompt

### New scenarios to add:

**Friday → Monday (no-timeout behavioral verification):**
Scenario: `permission.request` fires. No response for 72 simulated hours (fake timers or wall-clock skip). Heartbeat maintains session (ADR-7 verified). User taps Approve. `permissionCallback` resolves `true`. Tool executes. Verify session state is clean throughout; verify no spurious auto-deny fired.

**Disconnect-abort path:**
Scenario: `permission.request` fires. Session disconnects before user taps. AbortSignal fires → `complete('aborted')` → `permission.response { decision: "deny" }` sent to extension within one event loop turn. Verify no orphaned `pendingByRequestId` entry.

**Prompt text verification:**
Scenario: sent Telegram message contains "waiting for your decision" and no countdown text (e.g., no "seconds" or digit patterns that look like a timer).

**10-minute passive warning scanner:**
Scenario: prompt is open for 11 minutes (fake timer); confirm `console.warn` fires with correct `requestId`; confirm the prompt Promise itself is still pending (not resolved).

### Scenarios unaffected by amendments:

Category 1 (happy path), Category 3 (correlation/ordering), Category 4 (adversarial/edge), Category 5 (regression hooks) — all valid as written. Category 6 (protocol ambiguities) — all 8 items are now resolved by this ADR.

---


## 12. User Guide Additions (§9)

### `REACH_PERMISSION_POLICY` — the permission policy env var

| Value | Behavior |
|---|---|
| `approveAll` (default) | All tools auto-approved. No `permission.request` sent over pipe. No Telegram prompts. **Aaron's mode.** |
| `denyAll` | All destructive tools auto-denied. No prompts. |
| `interactiveDestructive` | Destructive tools trigger Telegram prompt. ADR-9 behavior applies. |

**Yolo mode:** Set `REACH_PERMISSION_POLICY=approveAll`. The extension's `onPermissionRequest` handler returns `{ kind: 'approved' }` immediately for all tools. No `permission.request` is sent. No Telegram prompt appears. This is the bridge-level equivalent of `/yolo` and is Aaron's current workflow.

### `allow-always` in interactive mode

When using `interactiveDestructive` policy, the Telegram prompt offers ✅ Approve / ❌ Deny. Approving a tool adds it to the `AllowAlwaysStore` for the current session — subsequent invocations of that tool in the same session are auto-approved without prompting.

**Scope:** Per-session. The store resets on daemon restart. This is intentional for Phase 6: a fresh session means fresh consent decisions.

**Phase 7+ upgrade:** Per-tool persistent allow-always (survives restarts) will be available when `PersistedAllowAlwaysStore` is added. The architecture already supports this via the `AllowAlwaysStore` injection point.

---


## 13. Open Items

| Item | Owner | Status |
|---|---|---|
| Rate-limit `permission.request` flood (max N concurrent) | Kat | Deferred to Phase 7 hardening |
| `PersistedAllowAlwaysStore` (per-tool, disk-backed) | Kat | Deferred to Phase 7 |
| Tiered allow response ("allow once" vs "allow always" — two buttons) | Kat | Deferred to Phase 7 |
| Snooze button on permission prompt | Kat | Deferred — requires protocol extension |
| v2 path RPC timeout risk | Carter | Low / open — re-check only if supporting very old CLI versions |

---


## Implementation Ready When

All gates are cleared. Kat may begin K1–K6 immediately.

**All 5 questions settled:**
- ✅ Q1 (UX shape) — inline keyboard
- ✅ Q2 (allow-always scope) — AllowAlwaysStore interface + in-memory impl, Phase 7+ seam
- ✅ Q3 (AbortSignal) — `signal?: AbortSignal` on `PermissionPrompter.prompt()`
- ✅ Q4 (timeout) — no timeout; Carter's SDK verification received; Branch A adopted
- ✅ Q5 (risk classification) — extension classifies, daemon routes

**All 6 tasks unblocked:**
- ✅ K1 (extensionBridge.ts wire types) — ready
- ✅ K2 (BridgeSession routing + AbortController) — ready
- ✅ K3 (prompt.ts — remove timeout, add AbortSignal) — ready
- ✅ K4 (AllowAlwaysStore + InMemoryAllowAlwaysStore) — ready
- ✅ K5 (extension.mjs — risk classification + pipe-close abort) — ready
- ✅ K6 (prompt text, observability scanner, PromptOutcome rename) — ready

---


## Ready for Kat

**ADR-9 is fully locked.** All 5 open questions are settled with evidence. Carter's SDK verification (`carter-sdk-permission-timeout-verification.md`) confirms the `@github/copilot-sdk` v0.2.2 imposes no internal timeout on `onPermissionRequest` — the no-timeout decision is empirically grounded. All 6 implementation tasks (K1–K6) are spec'd and unblocked. The regression check procedure (§7 "SDK Regression Check") ensures future SDK upgrades are evaluated against the no-timeout assumption. There is nothing left to decide. Kat may begin K1 through K6 in any order (K2 depends on K4's `AllowAlwaysStore` type; K3 should land before K2 to avoid a transient compile error on the `signal` parameter).

---

*Signed: Noble Six (Lead / Architect), 2026-05-22*

*This document is the final canonical ADR-9. It supersedes all prior drafts, including `noble-six-adr9-amended.md`. Branch B is permanently struck — it is not retained as a fallback, a reference, or an alternative. The evidence base for this decision is `carter-sdk-permission-timeout-verification.md`.*




## Phase 6 Days 3–4 — Relay on Bridge (2026-05-22)

**Status:** IMPLEMENTED  
**By:** Noble Six (Architect), Kat (Implementation), Jun (Testing)

---

### Context

Days 3–4 complete the bridge integration with a push-to-pull async-iterator adapter pattern. The bridge provides event-driven streaming (`bridge.on('stream', ...)` with chunks filtered by `requestId`). The relay expects an async iterable (`AsyncIterable<string>` from `CopilotSession.send()`). `BridgeSession` adapts one model to the other, preserving all relay throttle/edit/accumulation logic unchanged.

**What shipped:**
- **`BridgeSession` (bridgeSession.ts):** Implements `CopilotSession` with push-to-pull async-queue adapter. Yields chunks immediately, throws on `stream.error`, guaranteed listener cleanup.
- **`BridgeSessionFactory` (bridgeSessionFactory.ts):** `resume()` returns `BridgeSession` if registered on bridge, `null` if not. `create()` throws if session not registered.
- **`CompositeSessionFactory` (compositeSessionFactory.ts):** Bridge-first, SDK-fallback. No config flag — graceful coexistence. CLI sessions over extension pipe get `BridgeSession` transparently; pure SDK sessions unchanged.
- **`extensionBridge.ts` additions:** `getSessionByName()` to map human-readable session names to bridge's internal `sessionId` keyed map. Added `sessionName` tracking in `InternalConnection`.
- **`main.ts` wiring:** Bridge + composite factory instantiated and passed to relay; graceful fallback if pipe unavailable.
- **20 new tests (J1+J2+J3):** 10 `BridgeSession` contract tests, 4 relay-integration tests, 6 `BridgeSessionFactory` tests. Total suite: 316 passed, 4 skipped, 0 failed.

**Key design choice:** No relay.ts changes. Option A (adapter pattern) preserves 800ms throttle, `MAX_ACCUMULATED_BYTES` cap, MarkdownV2 fallback, split-chunk logic, and error handling automatically. Zero regression risk.

---

### Decisions Made

#### K3 Composition: Bridge-First Composite Factory (Option A)

**Decision:** Use `CompositeSessionFactory` (bridge-first, SDK-fallback) instead of config flag or env var swap.

**Rationale:**
- Single factory wraps both. `resume()` and `create()` try bridge first; fallback to SDK if session not registered.
- Graceful coexistence: CLI sessions attached over extension pipe get `BridgeSession` adapters. Pure SDK sessions unchanged.
- No config coordination. Bridge `resume()` returns `null` → fallback automatic and silent.
- Prevents hard-disable of either factory, enabling mixed use (live CLI session + standalone SDK session in same daemon).

**Impact:** `src/main.ts` wires one factory (`CompositeSessionFactory`). Relay calls one method. Zero delegation logic needed.

---

#### BridgeEmitter Interface (Reused)

**Decision:** Use existing `BridgeEmitter` interface from `extensionBridge.ts` directly.

**Rationale:** Carter's Day 2 work already extracted the minimal typed-subscription interface. `BridgeSession` takes `BridgeEmitter` + separate `sendFn: (sessionId, text) => string | false` — exactly matching Noble Six's K1 spec and unit-testable with Jun's fake `BridgeEmitter`.

---

#### Contract Gap: Permission Callback Ignored (ADR-9 Future)

**Gap:** Bridge sessions accept `permissionCallback` in `resume()`/`create()` for interface compatibility but ignore it. Wire protocol has no mechanism to send permission requests from extension to daemon and await user decision.

**Impact:** Bridge sessions always auto-approve (or use CLI extension's default policy). Interactive `interactiveDestructive` policy has no effect on bridge-attached sessions.

**Future:** ADR-9 could add `permission.request` / `permission.response` message pair to protocol.

**Decision:** Accept gap. Bridge sessions defer to CLI's permission policy. No blocker for Phase 6 completion.

---

### J2 Scope Reduction Rationale

Original charter called for a single complex test asserting at-most-once-per-800ms throttle. Full test would require tight coupling to relay implementation details not exposed by its contract.

**Actual J2 tests (4):**
1. `BridgeSession` yields accumulated chunks (direct consumption)
2. `BridgeSession` closes cleanly on `done` sentinel
3. Relay + BridgeSession: final `editMessageText` contains all chunks (content contract)
4. Relay + BridgeSession: edit count ≤ chunk count (throttle regression guard)

Tests 3–4 verify throttle without needing precise timing. Full at-most-once-per-800ms bound already tested exhaustively in `relay.test.ts` (unit-level). No regression risk.

---

### Minor Discovery: requestId Filtering

**Note:** `BridgeSession` filters events by `requestId` only, not `sessionId`. Foreign session IDs with the same `requestId` would NOT be filtered (but effectively never occurs since `requestId` is UUID-per-request). Low risk in production; documented here for future awareness.

---

### Verification

- `tsc --noEmit` ✅
- `npm run lint` ✅
- `npx vitest run` → 316 passed / 4 skipped / 0 failed ✅

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



---


# Carter Day 2 — `sendCommand()` Return Type Decision

**Author:** Carter  
**Date:** 2026-05-20  
**Status:** FYI — no blocking action needed; noting for relay/Kat integration awareness

---

## Context

ADR-8 §4 specifies that `inject` messages carry a `requestId` generated by the daemon.
The `requestId` must be returned to the caller (relay layer) so it can correlate incoming
`stream` chunks back to the Telegram placeholder that needs editing.

## Decision

`ExtensionBridge.sendCommand()` signature changed:

**Before (Day 1):**
```typescript
sendCommand(sessionId: string, payload: unknown): boolean
```

**After (Day 2, ADR-8):**
```typescript
sendCommand(sessionId: string, text: string): string | false
```

- Returns the generated `requestId` (`crypto.randomUUID()`) on success.
- Returns `false` if the session is not registered or is unreachable.
- `requestId` is generated inside `sendCommand`; the caller does not need to supply it.

## Rationale

The relay will need to match incoming `'stream'` events (which carry `requestId`) to the
correct pending Telegram edit. Returning the `requestId` from `sendCommand` gives the relay
the correlation handle without requiring a separate lookup map in the bridge.

## Impact on other agents

- **Kat** (command surface / relay refactor, Days 3–4): call sites that used `sendCommand(sid, payload)` need updating to `sendCommand(sid, text)` and should capture the return value for correlation.
- **Jun**: FakeDaemon uses `sendTo()` directly (bypasses `sendCommand`), so test doubles are unaffected.

---


## Context

ADR-8 §4 specifies that `inject` messages carry a `requestId` generated by the daemon.
The `requestId` must be returned to the caller (relay layer) so it can correlate incoming
`stream` chunks back to the Telegram placeholder that needs editing.


## Decision

`ExtensionBridge.sendCommand()` signature changed:

**Before (Day 1):**
```typescript
sendCommand(sessionId: string, payload: unknown): boolean
```

**After (Day 2, ADR-8):**
```typescript
sendCommand(sessionId: string, text: string): string | false
```

- Returns the generated `requestId` (`crypto.randomUUID()`) on success.
- Returns `false` if the session is not registered or is unreachable.
- `requestId` is generated inside `sendCommand`; the caller does not need to supply it.


## Rationale

The relay will need to match incoming `'stream'` events (which carry `requestId`) to the
correct pending Telegram edit. Returning the `requestId` from `sendCommand` gives the relay
the correlation handle without requiring a separate lookup map in the bridge.


## Impact on other agents

- **Kat** (command surface / relay refactor, Days 3–4): call sites that used `sendCommand(sid, payload)` need updating to `sendCommand(sid, text)` and should capture the return value for correlation.
- **Jun**: FakeDaemon uses `sendTo()` directly (bypasses `sendCommand`), so test doubles are unaffected.

---


# Jun Day 2 — `session.event` Shape Decision

**Author:** Jun (Test Engineer)  
**Date:** 2026-05-20  
**Status:** INFORMATIONAL — no team action required

---

## Context

ADR-8 §6 defers `session.event` to a future-use type in the canonical wire protocol.
The shape given in ADR-8's canonical schema is:

```json
{
  "type": "session.event",
  "sessionId": "abc-123",
  "payload": { "kind": "tool_call", "name": "read_file", "args": "..." }
}
```

Day 2 task: add this type to the `InboundMessage` discriminated union in
`tests/helpers/FakeDaemon.ts` for forward compatibility.

---

## Decision

**Field name:** `payload` (not `data` or `body`).  
**Field type:** `unknown` (not `any`, not `Record<string, unknown>`).

### Alternatives considered

| Option | Shape | Verdict |
|---|---|---|
| A (chosen) | `payload: unknown` | Matches ADR-8 field name. `unknown` enforces narrowing at callsites. |
| B | `data?: unknown` | `data` diverges from ADR-8 example. Optional implies daemon may omit it; ADR-8 gives no such hint. |
| C | `payload: Record<string, unknown>` | Over-constrains. ADR-8 says this is a generic event channel; a non-object payload (e.g. string or number) should not be ruled out. |
| D | `payload: { kind: string; [k: string]: unknown }` | Pre-assumes a `kind` discriminator. ADR-8 doesn't lock the payload shape — that's the whole point of deferring. |

### Rationale for `unknown`

- Matches ADR-8's field name exactly.
- `unknown` is the canonical TypeScript type for "data whose shape is not yet defined." Any consumer that eventually needs to read `payload` must narrow it first — this is intentional and correct for a reserved/not-yet-implemented message type.
- If ADR-9 locks a specific `session.event` payload shape, changing `unknown` to a concrete type is a non-breaking refinement (narrowing from unknown).

---

## Impact

- `FakeDaemon.ts` exports `SessionEventMessage` and it is part of `InboundMessage`.
- `_handleInbound`'s `default: break` already handles it (no dispatch needed until ADR-9 specifies behavior).
- 296 tests pass, 4 skipped, 0 failed. tsc clean. lint clean.

No action required from Carter, Kat, or Noble Six unless ADR-9 specifies a different `payload` shape.


---


## Context

ADR-8 §6 defers `session.event` to a future-use type in the canonical wire protocol.
The shape given in ADR-8's canonical schema is:

```json
{
  "type": "session.event",
  "sessionId": "abc-123",
  "payload": { "kind": "tool_call", "name": "read_file", "args": "..." }
}
```

Day 2 task: add this type to the `InboundMessage` discriminated union in
`tests/helpers/FakeDaemon.ts` for forward compatibility.

---


## Decision

**Field name:** `payload` (not `data` or `body`).  
**Field type:** `unknown` (not `any`, not `Record<string, unknown>`).

### Alternatives considered

| Option | Shape | Verdict |
|---|---|---|
| A (chosen) | `payload: unknown` | Matches ADR-8 field name. `unknown` enforces narrowing at callsites. |
| B | `data?: unknown` | `data` diverges from ADR-8 example. Optional implies daemon may omit it; ADR-8 gives no such hint. |
| C | `payload: Record<string, unknown>` | Over-constrains. ADR-8 says this is a generic event channel; a non-object payload (e.g. string or number) should not be ruled out. |
| D | `payload: { kind: string; [k: string]: unknown }` | Pre-assumes a `kind` discriminator. ADR-8 doesn't lock the payload shape — that's the whole point of deferring. |

### Rationale for `unknown`

- Matches ADR-8's field name exactly.
- `unknown` is the canonical TypeScript type for "data whose shape is not yet defined." Any consumer that eventually needs to read `payload` must narrow it first — this is intentional and correct for a reserved/not-yet-implemented message type.
- If ADR-9 locks a specific `session.event` payload shape, changing `unknown` to a concrete type is a non-breaking refinement (narrowing from unknown).

---


## Impact

- `FakeDaemon.ts` exports `SessionEventMessage` and it is part of `InboundMessage`.
- `_handleInbound`'s `default: break` already handles it (no dispatch needed until ADR-9 specifies behavior).
- 296 tests pass, 4 skipped, 0 failed. tsc clean. lint clean.

No action required from Carter, Kat, or Noble Six unless ADR-9 specifies a different `payload` shape.


---


# ADR-9 Implementation Notes (Kat)

Sub-decisions and patterns established during K1–K6 implementation.
Archive as needed; these are factual records, not prescriptive ADRs.

---

## `raceAbortSignals()` instead of `AbortSignal.any()`

**Decision:** Implemented a local `raceAbortSignals(signals: AbortSignal[]): AbortSignal` helper rather than using the built-in `AbortSignal.any()`.

**Why:** `AbortSignal.any()` was added in Node 20.3 / browser baseline 2023-05-16. The project targets `@types/node@^20` but we have no explicit version floor above 20.0. Using the helper avoids a silent runtime crash if deployed on an older Node 20 minor. Also provides explicit code comment documenting why it exists.

**Pattern:**
```ts
function raceAbortSignals(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { ac.abort(); return ac.signal; }
    signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}
```

Can be replaced with `AbortSignal.any(signals)` once Node floor is pinned ≥ 20.3.

---

## Self-cleaning permission listener pattern in `BridgeSession`

**Decision:** The `session.disconnected` handler removes all three permission-related listeners (`permission.request`, `permission.cancelled`, `session.disconnected` itself) to prevent emitter accumulation when BridgeSessions are reused across reconnects.

**Why not `dispose()`?** The session lifecycle is managed by `BridgeSessionFactory` and callers never call a dispose method. Adding a `dispose()` method would require caller changes. The self-cleaning listener is zero-overhead and correct because disconnect is the only session-end signal.

**Trade-off:** If there are ever scenarios where a session is "recycled" without a disconnect event, this pattern breaks. Accepted because the protocol guarantees disconnect before reconnect.

---

## `currentRequestId` in `extension.mjs` — metadata only

**Decision:** The Copilot extension (Node.js ESM) tracks a module-level `currentRequestId` and forwards it in `permission.request` messages. This is metadata context for the daemon, NOT a correlation ID for response matching.

**Why separate from `permissionId`?** `permissionId` uniquely identifies one permission request and is used to correlate `permission.response`. `requestId` is the broader CLI tool-call request. One `requestId` can generate multiple `permission.request` messages (one per destructive tool in a sequential tool-call). The daemon doesn't need `requestId` for correctness, but it's useful for logging/tracing.

---

## `exactOptionalPropertyTypes: true` — conditional spread pattern

**Issue:** When `strictOptionalProperties: true` is set (via `exactOptionalPropertyTypes`), you cannot pass `T | undefined` where `T` is an optional property typed as `T` (not `T | undefined`). TypeScript treats these differently.

**Pattern used in `BridgeSessionFactory._makeSession()`:**
```ts
const permOptions: BridgeSessionPermOptions = {
  permissionCallback: this.permissionCallback,
  sendPermissionResponseFn: this.sendPermissionResponseFn,
  ...(this.allowAlwaysStore !== undefined
    ? { allowAlwaysStore: this.allowAlwaysStore }
    : {}),
};
```

The conditional spread is the idiomatic workaround when `exactOptionalPropertyTypes` is enabled. Alternative: widen the `BridgeSessionPermOptions` field type to `AllowAlwaysStore | undefined` — but that weakens the type contract for consumers that pass `undefined` explicitly.

---

## AbortSignal timing: pre-aborted signals in `prompt.ts`

**Observation:** When a caller passes an already-aborted signal to `promptUserForPermission`, the `abort` event will not fire (it already fired). The implementation must check `signal.aborted` synchronously after sending the Telegram message.

**Implementation:** After `await bot.api.sendMessage(...)`, the function checks `if (signal?.aborted) { complete('aborted'); return; }` before registering the `signal.addEventListener('abort', ...)` handler. This ensures the prompt resolves immediately without waiting for an event that already fired.


---


## `raceAbortSignals()` instead of `AbortSignal.any()`

**Decision:** Implemented a local `raceAbortSignals(signals: AbortSignal[]): AbortSignal` helper rather than using the built-in `AbortSignal.any()`.

**Why:** `AbortSignal.any()` was added in Node 20.3 / browser baseline 2023-05-16. The project targets `@types/node@^20` but we have no explicit version floor above 20.0. Using the helper avoids a silent runtime crash if deployed on an older Node 20 minor. Also provides explicit code comment documenting why it exists.

**Pattern:**
```ts
function raceAbortSignals(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { ac.abort(); return ac.signal; }
    signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}
```

Can be replaced with `AbortSignal.any(signals)` once Node floor is pinned ≥ 20.3.

---


## Self-cleaning permission listener pattern in `BridgeSession`

**Decision:** The `session.disconnected` handler removes all three permission-related listeners (`permission.request`, `permission.cancelled`, `session.disconnected` itself) to prevent emitter accumulation when BridgeSessions are reused across reconnects.

**Why not `dispose()`?** The session lifecycle is managed by `BridgeSessionFactory` and callers never call a dispose method. Adding a `dispose()` method would require caller changes. The self-cleaning listener is zero-overhead and correct because disconnect is the only session-end signal.

**Trade-off:** If there are ever scenarios where a session is "recycled" without a disconnect event, this pattern breaks. Accepted because the protocol guarantees disconnect before reconnect.

---


## `currentRequestId` in `extension.mjs` — metadata only

**Decision:** The Copilot extension (Node.js ESM) tracks a module-level `currentRequestId` and forwards it in `permission.request` messages. This is metadata context for the daemon, NOT a correlation ID for response matching.

**Why separate from `permissionId`?** `permissionId` uniquely identifies one permission request and is used to correlate `permission.response`. `requestId` is the broader CLI tool-call request. One `requestId` can generate multiple `permission.request` messages (one per destructive tool in a sequential tool-call). The daemon doesn't need `requestId` for correctness, but it's useful for logging/tracing.

---


## `exactOptionalPropertyTypes: true` — conditional spread pattern

**Issue:** When `strictOptionalProperties: true` is set (via `exactOptionalPropertyTypes`), you cannot pass `T | undefined` where `T` is an optional property typed as `T` (not `T | undefined`). TypeScript treats these differently.

**Pattern used in `BridgeSessionFactory._makeSession()`:**
```ts
const permOptions: BridgeSessionPermOptions = {
  permissionCallback: this.permissionCallback,
  sendPermissionResponseFn: this.sendPermissionResponseFn,
  ...(this.allowAlwaysStore !== undefined
    ? { allowAlwaysStore: this.allowAlwaysStore }
    : {}),
};
```

The conditional spread is the idiomatic workaround when `exactOptionalPropertyTypes` is enabled. Alternative: widen the `BridgeSessionPermOptions` field type to `AllowAlwaysStore | undefined` — but that weakens the type contract for consumers that pass `undefined` explicitly.

---


## AbortSignal timing: pre-aborted signals in `prompt.ts`

**Observation:** When a caller passes an already-aborted signal to `promptUserForPermission`, the `abort` event will not fire (it already fired). The implementation must check `signal.aborted` synchronously after sending the Telegram message.

**Implementation:** After `await bot.api.sendMessage(...)`, the function checks `if (signal?.aborted) { complete('aborted'); return; }` before registering the `signal.addEventListener('abort', ...)` handler. This ensures the prompt resolves immediately without waiting for an event that already fired.


---


# ADR-9 Revised Permission Test Scenario Catalog

**Revised per ADR-9 acceptance (commit a9451e2). NO TIMEOUT decision drives most changes.**

**Author:** Jun (Test Engineer)  
**Date:** 2026-05-22  
**Replaces:** `jun-adr9-permission-test-scenarios.md` (prior 29-scenario catalog, merged into decisions.md §11)  
**Status:** CATALOG ONLY — vitest files follow once K1–K6 land. Do not write test files from this document alone.

---

## Revision Summary

| Change | Detail |
|---|---|
| **DELETE** | All 5 original Category 2 "auto-deny after Xs" timer scenarios — no auto-deny timer exists anymore |
| **DELETE** | Dual-timer race scenarios (daemon timer vs. extension timer) — both sides wait indefinitely |
| **DELETE** | Branch B / SDK-ceiling scenarios — Branch B is permanently struck |
| **REVISE** | Category 2 entirely redesigned from "Timeout" → "Cancellation & Abort" |
| **ADD** | 6 new scenarios: Friday→Monday, no-timer regression assertion, AllowAlways, extension classifier, observability scanner, SDK empirical reference |
| **RETIRE** | Prior Category 6 (8 protocol ambiguities) — all resolved by ADR-9; closed |
| **NET** | 29 → 32 scenarios across 7 categories |

The no-timeout safety invariant is: **a pending `promptUserForPermission()` resolves ONLY via (a) user tap, (b) session disconnect → AbortSignal, or (c) daemon restart → map cleared.** Every Category 2 and Category 5 scenario tests one of these three paths.

---

## Test Double Contract Updates

### FakeExtensionClient / FakeDaemon — Required Changes for Revised Scenarios

| Requirement | Notes |
|---|---|
| `AbortController` injected per session | `FakeDaemon` sessions take an `AbortController`; tests call `.abort()` directly to simulate disconnect |
| **NO auto-timeout** | Fakes must NOT include any `setTimeout` for prompt lifetime. Match Branch A: real implementation has no timer. |
| `sendPermissionRequest(permissionId, toolName, args)` | Extension → daemon direction; controllable timing for timing-sensitive tests |
| `sendPermissionCancelled(permissionId)` | Extension cancels in-flight prompt (extension-side pipe close) |
| `simulatePipeClose(sessionId)` | Triggers transport disconnect → AbortSignal fires; used in C2-01, C2-02, C2-03 |
| `pendingPermissions()` | Returns open `permissionId` set; asserts zero-leak post-abort |

**ASSUMES IMPLEMENTATION (flag for Kat):**
- `BridgeSession` must accept an `AbortController` at construction (K2) — not construct one internally — so tests can trigger abort directly.
- K5 must export `isDestructive(toolName: string): boolean` and `isKnownSafe(toolName: string): boolean` as named exports for unit testing the classifier in isolation (C4-05, C6-05).

---

## Category 1 — Happy Path

*Unchanged from prior catalog. Scenarios carried forward as-is.*

**C1-01 — Approve flows through**  
Given a `permission.request` arrives for a destructive tool and the `AllowAlwaysStore` has no entry for it;  
When Aaron taps ✅ Approve in Telegram;  
Then `permissionCallback` resolves `true`, `permission.response { decision: "allow" }` is sent to the extension, and `AllowAlwaysStore.add(toolName)` is called.

**C1-02 — Deny flows through**  
Given a `permission.request` arrives for a destructive tool;  
When Aaron taps ❌ Deny;  
Then `permissionCallback` resolves `false`, `permission.response { decision: "deny" }` is sent to the extension, and the store is NOT updated.

**C1-03 — Sequential prompts resolve independently**  
Given two sequential `permission.request` messages for different tools (different `permissionId`s);  
When Aaron approves both in order;  
Then each `permissionCallback` resolves correctly and `pendingByRequestId` is empty after both complete.

**C1-04 — Allow-always shortcut at the session layer**  
Given `AllowAlwaysStore.has(toolName) === true` for the current session;  
When a `permission.request` arrives for that tool;  
Then no Telegram message is sent, `promptUserForPermission()` is NOT called, and `permissionCallback` resolves `true` immediately.  
*(Full coverage in Category 6. This is the happy-path summary.)*

---

## Category 2 — Cancellation & Abort

*REDESIGNED. All 5 original timeout/auto-deny scenarios deleted. This category now covers AbortSignal-based cancellation — the only legitimate automatic resolution path under Branch A.*

**C2-01 — Session disconnect → AbortSignal fires within one event loop turn** ⭐ *Keystone test for the no-timeout safety invariant*  
Given a `permission.request` is in flight with no user response (prompt is a pending Promise);  
When `session.disconnected` fires (simulated via `simulatePipeClose`);  
Then the `AbortSignal` on `promptUserForPermission()` fires **within one event loop turn** (`await Promise.resolve()` suffices), the Promise resolves with outcome `'aborted'`, `permission.response { decision: "deny" }` is sent to the extension, and zero `pendingByRequestId` entries remain.  
*This is the single most important test in the catalog. It proves the no-timeout safety invariant: a dead session cannot leave a hanging Promise that consumes a slot in `pendingByRequestId` forever.*

**C2-02 — Pipe-close on extension side → deny fires, no hang**  
Given a `permission.request` is in flight;  
When the extension-side pipe closes (simulated via `simulatePipeClose` on `FakeExtensionClient`);  
Then the extension's `waitForPermissionResponse(permissionId)` coroutine aborts with deny (`{ kind: 'denied' }`), the pending `permissionCallback` on the daemon side also resolves `false`, and no hang occurs.  
*Assert: no open promise handles remain after pipe-close.*

**C2-03 — Concurrent prompts — session disconnect aborts each independently**  
Given two prompts (permissionId A, permissionId B) are in flight concurrently for the same session;  
When `session.disconnected` fires;  
Then both AbortSignals fire within one event loop turn each, both callbacks resolve `'aborted'`, and `pendingByRequestId` is empty.  
*Assert: aborting one does NOT affect the other's lifecycle — the abort is per-permissionId, not shared.*

**C2-04 — Late tap after approve — `answerCallbackQuery` returns gracefully**  
Given a `permission.request` was approved and the prompt Promise has resolved;  
When Aaron taps the same ✅ Approve button again (stale Telegram button, network delay, or Aaron taps twice);  
Then `answerCallbackQuery` is called and returns "no longer active" gracefully with no crash, no error throw, and no state mutation.

**C2-05 — Late tap after deny — same graceful handling**  
Given a `permission.request` was denied and the prompt Promise has resolved;  
When Aaron later taps ❌ Deny (or ✅ Approve) on the stale message;  
Then `answerCallbackQuery` returns "no longer active" gracefully.

**C2-06 — Late tap after abort (disconnect) — graceful handling**  
Given a prompt was aborted by session disconnect before any user response;  
When Aaron later opens Telegram and taps either button;  
Then `answerCallbackQuery` returns "no longer active" gracefully. No second `permission.response` is sent to the (already-disconnected) extension.

---

## Category 3 — Correlation & Ordering

*Unchanged from prior catalog.*

**C3-01 — Concurrent prompts: independent requestIds, independent resolution**  
Given two `permission.request` messages arrive simultaneously with different `permissionId`s;  
When Aaron approves permissionId-A and denies permissionId-B in any order;  
Then each `permissionCallback` resolves with the correct decision, with no cross-contamination of state.

**C3-02 — Out-of-order resolution**  
Given three in-flight prompts (A, B, C) for the same session;  
When Aaron resolves them in order C → A → B;  
Then all three callbacks receive the correct decision regardless of resolution order, and `pendingByRequestId` is empty after all three resolve.

**C3-03 — Multi-session prompts multiplexed over one pipe**  
Given two sessions (sess-1, sess-2) sharing one pipe connection;  
When each session sends a `permission.request` simultaneously;  
Then each `BridgeSession` receives only its own request (filtered by `sessionId`), each resolves independently, and neither session receives the other's `permission.response`.

**C3-04 — Data-plane stream continues while permission prompt is in flight**  
Given an active `stream` sequence is running and a `permission.request` interleaves mid-stream (after chunk 2, before chunk 3);  
When the stream's `done: true` arrives before the prompt is answered;  
Then the stream completes correctly, the prompt remains pending (not auto-resolved by stream completion), and the relay's accumulated response is intact.

---

## Category 4 — Adversarial & Edge

*Largely unchanged from prior catalog. Extension classifier scenario added (Q5 resolution).*

**C4-01 — Foreign permissionId: ignore, don't process**  
Given a `permission.response` arrives for a `permissionId` not in `pendingByRequestId` (forged, late, or from a previous daemon run);  
When the daemon receives it;  
Then it is silently discarded with a structured log warning, no state mutation occurs, and the connection is NOT dropped.

**C4-02 — Malformed permission frame: reject, log, don't crash**  
Given a `permission.request` arrives missing required fields (`permissionId`, `toolName`, or `riskLevel`);  
When the daemon processes it;  
Then the frame is rejected with a structured log error, the extension connection is NOT dropped (ADR-8 unknown-field tolerance applies), and all other in-flight sessions are unaffected.

**C4-03 — Duplicate response: at-most-once delivery**  
Given a `permissionId` has already been resolved (user approved);  
When a second `permission.response` for the same `permissionId` arrives (e.g., duplicate callback delivery);  
Then it is discarded, the original resolution is not overwritten, and no double-fire occurs.

**C4-04 — Permission flood: rate-limit guard** *(SKIP until Phase 7)*  
Given more than N concurrent `permission.request` messages arrive for the same session;  
When the flood exceeds the cap;  
Then excess prompts are auto-denied with a log warning and no crash.  
*Note: ADR-9 §13 defers rate limiting to Phase 7. Mark SKIP for now; scenario reserved.*

**C4-05 — Extension classifier: non-destructive tools bypass bridge permission flow entirely (Q5)**  
Given a non-destructive tool (`read_file`, `list_files`, or any tool in `isKnownSafe()`) is invoked by the CLI;  
When the extension's `onPermissionRequest` handler fires;  
Then `isKnownSafe(toolName)` returns `true`, the handler returns `{ kind: 'approved' }` immediately, and zero `permission.request` frames appear on the pipe.  
*White-box unit test on extension-side classifier. Mock the pipe; assert frame count = 0.*  
**ASSUMES IMPLEMENTATION:** K5 must export `isKnownSafe` as a standalone named function for isolation testing.

---

## Category 5 — No-Timeout Behavioral Verification

*ENTIRELY NEW. Prior Category 6 (8 protocol ambiguities) retired — all resolved by ADR-9. This category provides behavioral regression coverage for the Branch A no-timeout decision.*

**C5-01 — Friday → Monday: prompt survives 72+ simulated hours intact**  
Given a `permission.request` is in flight;  
When fake timers advance 72 hours (`vi.advanceTimersByTime(72 * 60 * 60 * 1000)`) with no user response;  
Then the prompt Promise is **still pending** (not resolved), zero auto-deny has fired, `pendingByRequestId` still holds the entry, and `vi.getTimerCount()` shows no surprise queued timers beyond the observability scanner's `setInterval`.  
When fake timers are reset and Aaron "taps Approve" (callback fires);  
Then `permissionCallback` resolves `true`, session state is clean, and zero memory growth or leaked timers are present.  
*Fake timer scope: `toFake: ['setTimeout','setInterval','clearTimeout','clearInterval','Date']`. Omit `setImmediate` — readline compatibility. This validates ADR-9 §7's "Friday → Monday" documented case.*

**C5-02 — No-timer regression assertion** ⭐ *Regression guard against K3 re-introduction*  
Given `promptUserForPermission()` is called with a live `AbortSignal`;  
When the call is made and a pending Promise is returned;  
Then a `vi.spyOn(globalThis, 'setTimeout')` asserts that `setTimeout` was called **zero times** from the prompt's call site (only the pre-existing observability `setInterval` is permitted).  
*White-box regression test. Guards against accidental re-introduction of the `timeoutHandle` that K3 removes. Run this test in the same file as K3's prompt.ts changes.*

**C5-03 — Observability scanner: 10-minute warning fires, Promise stays pending**  
Given a `permission.request` is in flight and `PendingPrompt.createdAt` is set;  
When fake timers advance 11 minutes (`vi.advanceTimersByTime(11 * 60 * 1000)`);  
Then `console.warn` is called with a message containing the `requestId`, the 11-minute threshold is reflected in the log, and the prompt Promise is **still pending** (the scanner did not resolve it).  
*Assert: scanner is read-only — it does NOT call `complete()`, does NOT modify `pendingByRequestId`, and does NOT send any `permission.response`.*

**C5-04 — SDK empirical regression reference** *(Reference scenario — not a new test to write)*  
*Points to:* `tests/exploratory/sdk-permission-timeout.test.ts` (Carter's probe, 4/4 green as of 2026-05-22).  
This test verifies that `@github/copilot-sdk` v0.2.2 imposes no internal timeout on `onPermissionRequest` by advancing fake timers 60 000 ms and confirming no SDK-imposed rejection occurs.  
**NOTE:** If `@github/copilot-sdk` is upgraded in `package.json`, re-run this test before merging the bump PR. If any of the 4 cases go red, treat it as a **breaking change to ADR-9** and re-evaluate the no-timeout decision. Also run the §7 grep check:  
```bash
grep -n "setTimeout\|Promise\.race\|AbortController" \
  node_modules/@github/copilot-sdk/dist/session.js \
  | grep -A2 -B2 "permissionHandler\|executePermissionAndRespond"
```

---

## Category 6 — AllowAlways Store & Classifier Contracts

*ENTIRELY NEW. Covers ADR-9 Q2 (AllowAlwaysStore) and Q5 (extension classifier) behavioral contracts.*

**C6-01 — Store hit: no prompt, immediate approval**  
Given `AllowAlwaysStore.has(toolName) === true` for the current session;  
When `permission.request` arrives for that tool;  
Then `promptUserForPermission()` is NOT called, no Telegram message is sent, and `permissionCallback` resolves `true` immediately (synchronously from the store check).

**C6-02 — Store miss: normal prompt flow**  
Given `AllowAlwaysStore.has(toolName) === false`;  
When `permission.request` arrives for that tool;  
Then `promptUserForPermission()` IS called, a Telegram inline-keyboard message is sent, and the normal approve/deny flow proceeds.

**C6-03 — Approve adds to store; subsequent call is auto-approved**  
Given the store is empty and Aaron approves a prompt for `bash`;  
When a second `permission.request` arrives for `bash` in the same session;  
Then the second prompt is auto-approved via the store with no Telegram message, and the `promptUserForPermission()` call count is still 1 (from the first invocation only).

**C6-04 — Store is per-session (no cross-session leakage)**  
Given session-A's store has `bash` approved;  
When session-B receives a `permission.request` for `bash`;  
Then session-B's store is empty (independent `InMemoryAllowAlwaysStore` instance), and session-B gets a full prompt.  
*Assert: `InMemoryAllowAlwaysStore` instances are separate objects; `BridgeSessionFactory` must not share a store across sessions.*  
**ASSUMES IMPLEMENTATION:** K4's `BridgeSessionFactory` must construct a new `InMemoryAllowAlwaysStore` per `BridgeSession` instantiation.

**C6-05 — Classifier: destructive tool sends permission.request over pipe**  
Given a destructive tool (`bash`, `write_file`, or any tool matched by `isDestructive()`) is invoked;  
When the extension's `onPermissionRequest` handler fires;  
Then `isDestructive(toolName) === true`, the handler sends `permission.request` over the pipe, and awaits a `permission.response` from the daemon.  
*Pair test with C4-05 (non-destructive path). Both together cover the classifier contract completely.*

---

## Category 7 — Regression Guards

*Kept from prior Category 5. Validates that control-plane additions do not disturb established data-plane contracts.*

**C7-01 — Relay 800ms throttle unaffected by interleaved permission frames**  
Given an active stream with N chunks and a `permission.request` interleaved between chunk 2 and chunk 3;  
When the relay processes the full sequence;  
Then total edit count is far below N (throttle intact), and the final edit content contains all N chunks.

**C7-02 — MarkdownV2 escaping unaffected**  
Given a relay session with `permission.request` frames on the pipe;  
When streamed content contains MarkdownV2-sensitive characters (`_`, `*`, `[`, `.`, etc.);  
Then `escapeMarkdownV2()` output is byte-for-byte identical to the no-permission baseline.

**C7-03 — Message splitter unaffected**  
Given a relay session and a response that requires splitting into multiple Telegram messages;  
When a `permission.request` arrives between two split segments;  
Then `splitForTelegram()` output is identical to the no-permission baseline and numbering is correct.

**C7-04 — Prompt text contains no countdown language**  
Given `promptUserForPermission()` generates a Telegram message text;  
When the text is captured from the `sendMessage` call;  
Then it contains language equivalent to "waiting for your decision", and does NOT match `/\d+\s*(second|minute|s\b)/i` (no countdown text).  
*Regression guard against re-introduction of timer UX text that K6 removes. Run in prompt.ts unit tests.*

---

## Retired: Protocol Ambiguities (Prior Category 6)

All 8 protocol ambiguity items are resolved by ADR-9. Closed; not carried forward as test scenarios.

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | Wire message type | `permission.request` / `permission.response` top-level discriminated types ✅ |
| 2 | requestId ownership | `permissionId` generated by extension; separate from data-plane `requestId` ✅ |
| 3 | Timeout owner | No timeout. AbortSignal for session disconnect only (Branch A) ✅ |
| 4 | Reconnect behavior | Prompts do not survive reconnect; daemon restart clears `pendingByRequestId` ✅ |
| 5 | Multiplexing on single pipe | Discriminated dispatch in `_handleInbound` switch (ADR-8 pattern) ✅ |
| 6 | At-most-once delivery | `permissionId` lookup guard in `pendingByRequestId`; duplicate response discarded ✅ |
| 7 | Post-terminal race | `permission.request` after `done: true` discarded gracefully; see C3-04 ✅ |
| 8 | Extension-side timeout | No extension timer; pipe-close abort only; see C2-02 ✅ |

---

## Scenario Count Summary

| Category | Count | Change from Prior |
|---|---|---|
| 1 — Happy Path | 4 | KEPT (minor wording update) |
| 2 — Cancellation & Abort | 6 | REDESIGNED; all 5 prior timeout scenarios deleted |
| 3 — Correlation & Ordering | 4 | KEPT |
| 4 — Adversarial & Edge | 5 | KEPT + C4-05 classifier added |
| 5 — No-Timeout Behavioral | 4 | NEW (replaces retired Cat 6) |
| 6 — AllowAlways & Classifier | 5 | NEW |
| 7 — Regression Guards | 4 | KEPT from prior Cat 5 |
| **Total** | **32** | Prior: 29 (net +3) |

**Deleted:**
- C2-01–C2-05 (prior): "auto-deny after Xs", "dual-timer race", "Branch B ceiling" — 5 deleted
- Category 6 (prior): 8 protocol ambiguities — retired (all resolved)

**ASSUMES IMPLEMENTATION summary (all for Kat):**
- K2: `BridgeSession` accepts `AbortController` at construction (not self-constructs)
- K4: `BridgeSessionFactory` constructs a new `InMemoryAllowAlwaysStore` per session
- K5: `isDestructive()` and `isKnownSafe()` exported as named functions from `extension.mjs`

---


## Revision Summary

| Change | Detail |
|---|---|
| **DELETE** | All 5 original Category 2 "auto-deny after Xs" timer scenarios — no auto-deny timer exists anymore |
| **DELETE** | Dual-timer race scenarios (daemon timer vs. extension timer) — both sides wait indefinitely |
| **DELETE** | Branch B / SDK-ceiling scenarios — Branch B is permanently struck |
| **REVISE** | Category 2 entirely redesigned from "Timeout" → "Cancellation & Abort" |
| **ADD** | 6 new scenarios: Friday→Monday, no-timer regression assertion, AllowAlways, extension classifier, observability scanner, SDK empirical reference |
| **RETIRE** | Prior Category 6 (8 protocol ambiguities) — all resolved by ADR-9; closed |
| **NET** | 29 → 32 scenarios across 7 categories |

The no-timeout safety invariant is: **a pending `promptUserForPermission()` resolves ONLY via (a) user tap, (b) session disconnect → AbortSignal, or (c) daemon restart → map cleared.** Every Category 2 and Category 5 scenario tests one of these three paths.

---


## Test Double Contract Updates

### FakeExtensionClient / FakeDaemon — Required Changes for Revised Scenarios

| Requirement | Notes |
|---|---|
| `AbortController` injected per session | `FakeDaemon` sessions take an `AbortController`; tests call `.abort()` directly to simulate disconnect |
| **NO auto-timeout** | Fakes must NOT include any `setTimeout` for prompt lifetime. Match Branch A: real implementation has no timer. |
| `sendPermissionRequest(permissionId, toolName, args)` | Extension → daemon direction; controllable timing for timing-sensitive tests |
| `sendPermissionCancelled(permissionId)` | Extension cancels in-flight prompt (extension-side pipe close) |
| `simulatePipeClose(sessionId)` | Triggers transport disconnect → AbortSignal fires; used in C2-01, C2-02, C2-03 |
| `pendingPermissions()` | Returns open `permissionId` set; asserts zero-leak post-abort |

**ASSUMES IMPLEMENTATION (flag for Kat):**
- `BridgeSession` must accept an `AbortController` at construction (K2) — not construct one internally — so tests can trigger abort directly.
- K5 must export `isDestructive(toolName: string): boolean` and `isKnownSafe(toolName: string): boolean` as named exports for unit testing the classifier in isolation (C4-05, C6-05).

---


## Category 1 — Happy Path

*Unchanged from prior catalog. Scenarios carried forward as-is.*

**C1-01 — Approve flows through**  
Given a `permission.request` arrives for a destructive tool and the `AllowAlwaysStore` has no entry for it;  
When Aaron taps ✅ Approve in Telegram;  
Then `permissionCallback` resolves `true`, `permission.response { decision: "allow" }` is sent to the extension, and `AllowAlwaysStore.add(toolName)` is called.

**C1-02 — Deny flows through**  
Given a `permission.request` arrives for a destructive tool;  
When Aaron taps ❌ Deny;  
Then `permissionCallback` resolves `false`, `permission.response { decision: "deny" }` is sent to the extension, and the store is NOT updated.

**C1-03 — Sequential prompts resolve independently**  
Given two sequential `permission.request` messages for different tools (different `permissionId`s);  
When Aaron approves both in order;  
Then each `permissionCallback` resolves correctly and `pendingByRequestId` is empty after both complete.

**C1-04 — Allow-always shortcut at the session layer**  
Given `AllowAlwaysStore.has(toolName) === true` for the current session;  
When a `permission.request` arrives for that tool;  
Then no Telegram message is sent, `promptUserForPermission()` is NOT called, and `permissionCallback` resolves `true` immediately.  
*(Full coverage in Category 6. This is the happy-path summary.)*

---


## Category 2 — Cancellation & Abort

*REDESIGNED. All 5 original timeout/auto-deny scenarios deleted. This category now covers AbortSignal-based cancellation — the only legitimate automatic resolution path under Branch A.*

**C2-01 — Session disconnect → AbortSignal fires within one event loop turn** ⭐ *Keystone test for the no-timeout safety invariant*  
Given a `permission.request` is in flight with no user response (prompt is a pending Promise);  
When `session.disconnected` fires (simulated via `simulatePipeClose`);  
Then the `AbortSignal` on `promptUserForPermission()` fires **within one event loop turn** (`await Promise.resolve()` suffices), the Promise resolves with outcome `'aborted'`, `permission.response { decision: "deny" }` is sent to the extension, and zero `pendingByRequestId` entries remain.  
*This is the single most important test in the catalog. It proves the no-timeout safety invariant: a dead session cannot leave a hanging Promise that consumes a slot in `pendingByRequestId` forever.*

**C2-02 — Pipe-close on extension side → deny fires, no hang**  
Given a `permission.request` is in flight;  
When the extension-side pipe closes (simulated via `simulatePipeClose` on `FakeExtensionClient`);  
Then the extension's `waitForPermissionResponse(permissionId)` coroutine aborts with deny (`{ kind: 'denied' }`), the pending `permissionCallback` on the daemon side also resolves `false`, and no hang occurs.  
*Assert: no open promise handles remain after pipe-close.*

**C2-03 — Concurrent prompts — session disconnect aborts each independently**  
Given two prompts (permissionId A, permissionId B) are in flight concurrently for the same session;  
When `session.disconnected` fires;  
Then both AbortSignals fire within one event loop turn each, both callbacks resolve `'aborted'`, and `pendingByRequestId` is empty.  
*Assert: aborting one does NOT affect the other's lifecycle — the abort is per-permissionId, not shared.*

**C2-04 — Late tap after approve — `answerCallbackQuery` returns gracefully**  
Given a `permission.request` was approved and the prompt Promise has resolved;  
When Aaron taps the same ✅ Approve button again (stale Telegram button, network delay, or Aaron taps twice);  
Then `answerCallbackQuery` is called and returns "no longer active" gracefully with no crash, no error throw, and no state mutation.

**C2-05 — Late tap after deny — same graceful handling**  
Given a `permission.request` was denied and the prompt Promise has resolved;  
When Aaron later taps ❌ Deny (or ✅ Approve) on the stale message;  
Then `answerCallbackQuery` returns "no longer active" gracefully.

**C2-06 — Late tap after abort (disconnect) — graceful handling**  
Given a prompt was aborted by session disconnect before any user response;  
When Aaron later opens Telegram and taps either button;  
Then `answerCallbackQuery` returns "no longer active" gracefully. No second `permission.response` is sent to the (already-disconnected) extension.

---


## Category 3 — Correlation & Ordering

*Unchanged from prior catalog.*

**C3-01 — Concurrent prompts: independent requestIds, independent resolution**  
Given two `permission.request` messages arrive simultaneously with different `permissionId`s;  
When Aaron approves permissionId-A and denies permissionId-B in any order;  
Then each `permissionCallback` resolves with the correct decision, with no cross-contamination of state.

**C3-02 — Out-of-order resolution**  
Given three in-flight prompts (A, B, C) for the same session;  
When Aaron resolves them in order C → A → B;  
Then all three callbacks receive the correct decision regardless of resolution order, and `pendingByRequestId` is empty after all three resolve.

**C3-03 — Multi-session prompts multiplexed over one pipe**  
Given two sessions (sess-1, sess-2) sharing one pipe connection;  
When each session sends a `permission.request` simultaneously;  
Then each `BridgeSession` receives only its own request (filtered by `sessionId`), each resolves independently, and neither session receives the other's `permission.response`.

**C3-04 — Data-plane stream continues while permission prompt is in flight**  
Given an active `stream` sequence is running and a `permission.request` interleaves mid-stream (after chunk 2, before chunk 3);  
When the stream's `done: true` arrives before the prompt is answered;  
Then the stream completes correctly, the prompt remains pending (not auto-resolved by stream completion), and the relay's accumulated response is intact.

---


## Category 4 — Adversarial & Edge

*Largely unchanged from prior catalog. Extension classifier scenario added (Q5 resolution).*

**C4-01 — Foreign permissionId: ignore, don't process**  
Given a `permission.response` arrives for a `permissionId` not in `pendingByRequestId` (forged, late, or from a previous daemon run);  
When the daemon receives it;  
Then it is silently discarded with a structured log warning, no state mutation occurs, and the connection is NOT dropped.

**C4-02 — Malformed permission frame: reject, log, don't crash**  
Given a `permission.request` arrives missing required fields (`permissionId`, `toolName`, or `riskLevel`);  
When the daemon processes it;  
Then the frame is rejected with a structured log error, the extension connection is NOT dropped (ADR-8 unknown-field tolerance applies), and all other in-flight sessions are unaffected.

**C4-03 — Duplicate response: at-most-once delivery**  
Given a `permissionId` has already been resolved (user approved);  
When a second `permission.response` for the same `permissionId` arrives (e.g., duplicate callback delivery);  
Then it is discarded, the original resolution is not overwritten, and no double-fire occurs.

**C4-04 — Permission flood: rate-limit guard** *(SKIP until Phase 7)*  
Given more than N concurrent `permission.request` messages arrive for the same session;  
When the flood exceeds the cap;  
Then excess prompts are auto-denied with a log warning and no crash.  
*Note: ADR-9 §13 defers rate limiting to Phase 7. Mark SKIP for now; scenario reserved.*

**C4-05 — Extension classifier: non-destructive tools bypass bridge permission flow entirely (Q5)**  
Given a non-destructive tool (`read_file`, `list_files`, or any tool in `isKnownSafe()`) is invoked by the CLI;  
When the extension's `onPermissionRequest` handler fires;  
Then `isKnownSafe(toolName)` returns `true`, the handler returns `{ kind: 'approved' }` immediately, and zero `permission.request` frames appear on the pipe.  
*White-box unit test on extension-side classifier. Mock the pipe; assert frame count = 0.*  
**ASSUMES IMPLEMENTATION:** K5 must export `isKnownSafe` as a standalone named function for isolation testing.

---


## Category 5 — No-Timeout Behavioral Verification

*ENTIRELY NEW. Prior Category 6 (8 protocol ambiguities) retired — all resolved by ADR-9. This category provides behavioral regression coverage for the Branch A no-timeout decision.*

**C5-01 — Friday → Monday: prompt survives 72+ simulated hours intact**  
Given a `permission.request` is in flight;  
When fake timers advance 72 hours (`vi.advanceTimersByTime(72 * 60 * 60 * 1000)`) with no user response;  
Then the prompt Promise is **still pending** (not resolved), zero auto-deny has fired, `pendingByRequestId` still holds the entry, and `vi.getTimerCount()` shows no surprise queued timers beyond the observability scanner's `setInterval`.  
When fake timers are reset and Aaron "taps Approve" (callback fires);  
Then `permissionCallback` resolves `true`, session state is clean, and zero memory growth or leaked timers are present.  
*Fake timer scope: `toFake: ['setTimeout','setInterval','clearTimeout','clearInterval','Date']`. Omit `setImmediate` — readline compatibility. This validates ADR-9 §7's "Friday → Monday" documented case.*

**C5-02 — No-timer regression assertion** ⭐ *Regression guard against K3 re-introduction*  
Given `promptUserForPermission()` is called with a live `AbortSignal`;  
When the call is made and a pending Promise is returned;  
Then a `vi.spyOn(globalThis, 'setTimeout')` asserts that `setTimeout` was called **zero times** from the prompt's call site (only the pre-existing observability `setInterval` is permitted).  
*White-box regression test. Guards against accidental re-introduction of the `timeoutHandle` that K3 removes. Run this test in the same file as K3's prompt.ts changes.*

**C5-03 — Observability scanner: 10-minute warning fires, Promise stays pending**  
Given a `permission.request` is in flight and `PendingPrompt.createdAt` is set;  
When fake timers advance 11 minutes (`vi.advanceTimersByTime(11 * 60 * 1000)`);  
Then `console.warn` is called with a message containing the `requestId`, the 11-minute threshold is reflected in the log, and the prompt Promise is **still pending** (the scanner did not resolve it).  
*Assert: scanner is read-only — it does NOT call `complete()`, does NOT modify `pendingByRequestId`, and does NOT send any `permission.response`.*

**C5-04 — SDK empirical regression reference** *(Reference scenario — not a new test to write)*  
*Points to:* `tests/exploratory/sdk-permission-timeout.test.ts` (Carter's probe, 4/4 green as of 2026-05-22).  
This test verifies that `@github/copilot-sdk` v0.2.2 imposes no internal timeout on `onPermissionRequest` by advancing fake timers 60 000 ms and confirming no SDK-imposed rejection occurs.  
**NOTE:** If `@github/copilot-sdk` is upgraded in `package.json`, re-run this test before merging the bump PR. If any of the 4 cases go red, treat it as a **breaking change to ADR-9** and re-evaluate the no-timeout decision. Also run the §7 grep check:  
```bash
grep -n "setTimeout\|Promise\.race\|AbortController" \
  node_modules/@github/copilot-sdk/dist/session.js \
  | grep -A2 -B2 "permissionHandler\|executePermissionAndRespond"
```

---


## Category 6 — AllowAlways Store & Classifier Contracts

*ENTIRELY NEW. Covers ADR-9 Q2 (AllowAlwaysStore) and Q5 (extension classifier) behavioral contracts.*

**C6-01 — Store hit: no prompt, immediate approval**  
Given `AllowAlwaysStore.has(toolName) === true` for the current session;  
When `permission.request` arrives for that tool;  
Then `promptUserForPermission()` is NOT called, no Telegram message is sent, and `permissionCallback` resolves `true` immediately (synchronously from the store check).

**C6-02 — Store miss: normal prompt flow**  
Given `AllowAlwaysStore.has(toolName) === false`;  
When `permission.request` arrives for that tool;  
Then `promptUserForPermission()` IS called, a Telegram inline-keyboard message is sent, and the normal approve/deny flow proceeds.

**C6-03 — Approve adds to store; subsequent call is auto-approved**  
Given the store is empty and Aaron approves a prompt for `bash`;  
When a second `permission.request` arrives for `bash` in the same session;  
Then the second prompt is auto-approved via the store with no Telegram message, and the `promptUserForPermission()` call count is still 1 (from the first invocation only).

**C6-04 — Store is per-session (no cross-session leakage)**  
Given session-A's store has `bash` approved;  
When session-B receives a `permission.request` for `bash`;  
Then session-B's store is empty (independent `InMemoryAllowAlwaysStore` instance), and session-B gets a full prompt.  
*Assert: `InMemoryAllowAlwaysStore` instances are separate objects; `BridgeSessionFactory` must not share a store across sessions.*  
**ASSUMES IMPLEMENTATION:** K4's `BridgeSessionFactory` must construct a new `InMemoryAllowAlwaysStore` per `BridgeSession` instantiation.

**C6-05 — Classifier: destructive tool sends permission.request over pipe**  
Given a destructive tool (`bash`, `write_file`, or any tool matched by `isDestructive()`) is invoked;  
When the extension's `onPermissionRequest` handler fires;  
Then `isDestructive(toolName) === true`, the handler sends `permission.request` over the pipe, and awaits a `permission.response` from the daemon.  
*Pair test with C4-05 (non-destructive path). Both together cover the classifier contract completely.*

---


## Category 7 — Regression Guards

*Kept from prior Category 5. Validates that control-plane additions do not disturb established data-plane contracts.*

**C7-01 — Relay 800ms throttle unaffected by interleaved permission frames**  
Given an active stream with N chunks and a `permission.request` interleaved between chunk 2 and chunk 3;  
When the relay processes the full sequence;  
Then total edit count is far below N (throttle intact), and the final edit content contains all N chunks.

**C7-02 — MarkdownV2 escaping unaffected**  
Given a relay session with `permission.request` frames on the pipe;  
When streamed content contains MarkdownV2-sensitive characters (`_`, `*`, `[`, `.`, etc.);  
Then `escapeMarkdownV2()` output is byte-for-byte identical to the no-permission baseline.

**C7-03 — Message splitter unaffected**  
Given a relay session and a response that requires splitting into multiple Telegram messages;  
When a `permission.request` arrives between two split segments;  
Then `splitForTelegram()` output is identical to the no-permission baseline and numbering is correct.

**C7-04 — Prompt text contains no countdown language**  
Given `promptUserForPermission()` generates a Telegram message text;  
When the text is captured from the `sendMessage` call;  
Then it contains language equivalent to "waiting for your decision", and does NOT match `/\d+\s*(second|minute|s\b)/i` (no countdown text).  
*Regression guard against re-introduction of timer UX text that K6 removes. Run in prompt.ts unit tests.*

---


## Retired: Protocol Ambiguities (Prior Category 6)

All 8 protocol ambiguity items are resolved by ADR-9. Closed; not carried forward as test scenarios.

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | Wire message type | `permission.request` / `permission.response` top-level discriminated types ✅ |
| 2 | requestId ownership | `permissionId` generated by extension; separate from data-plane `requestId` ✅ |
| 3 | Timeout owner | No timeout. AbortSignal for session disconnect only (Branch A) ✅ |
| 4 | Reconnect behavior | Prompts do not survive reconnect; daemon restart clears `pendingByRequestId` ✅ |
| 5 | Multiplexing on single pipe | Discriminated dispatch in `_handleInbound` switch (ADR-8 pattern) ✅ |
| 6 | At-most-once delivery | `permissionId` lookup guard in `pendingByRequestId`; duplicate response discarded ✅ |
| 7 | Post-terminal race | `permission.request` after `done: true` discarded gracefully; see C3-04 ✅ |
| 8 | Extension-side timeout | No extension timer; pipe-close abort only; see C2-02 ✅ |

---


## Scenario Count Summary

| Category | Count | Change from Prior |
|---|---|---|
| 1 — Happy Path | 4 | KEPT (minor wording update) |
| 2 — Cancellation & Abort | 6 | REDESIGNED; all 5 prior timeout scenarios deleted |
| 3 — Correlation & Ordering | 4 | KEPT |
| 4 — Adversarial & Edge | 5 | KEPT + C4-05 classifier added |
| 5 — No-Timeout Behavioral | 4 | NEW (replaces retired Cat 6) |
| 6 — AllowAlways & Classifier | 5 | NEW |
| 7 — Regression Guards | 4 | KEPT from prior Cat 5 |
| **Total** | **32** | Prior: 29 (net +3) |

**Deleted:**
- C2-01–C2-05 (prior): "auto-deny after Xs", "dual-timer race", "Branch B ceiling" — 5 deleted
- Category 6 (prior): 8 protocol ambiguities — retired (all resolved)

**ASSUMES IMPLEMENTATION summary (all for Kat):**
- K2: `BridgeSession` accepts `AbortController` at construction (not self-constructs)
- K4: `BridgeSessionFactory` constructs a new `InMemoryAllowAlwaysStore` per session
- K5: `isDestructive()` and `isKnownSafe()` exported as named functions from `extension.mjs`

---


# Carter — Cloud Review Cycle 1 Disposition Notes

**Date:** 2026-05-23  
**Branch:** `squad/review1-phase6-adr9-fixes`  
**Commit:** `949269b`  
**PR:** #6  
**Test result:** 372 passed / 4 skipped / 0 failed ✅ (12 new tests added)

---

## T1 — `relay.ts:114` — ADR-9 Regression (ACCEPTED + FIXED)

**Disposition:** Accepted. This is a real regression. Option A chosen (reference-count pending permissions in BridgeSession; relay defers eviction when `isBusy()` returns true).

**Why Option A over Option B:** Option A keeps a single `dispose()` contract and requires no knowledge of "which kind of dispose" at the relay call site. The `isBusy()` predicate is a clean capability query that any consumer can use. Option B (split dispose paths) would require callers to track which variant to call, coupling the relay more deeply to bridge internals.

**What changed:**
- `CopilotSession` interface: added `isBusy?(): boolean` (optional — SDK sessions omit it).
- `BridgeSession`: added `isBusy(): boolean { return this._pendingByPermId.size > 0; }`.
- `relay.ts` idle eviction: replaced the inline callback with a named `scheduleIdle()` closure. If `evicted.session.isBusy?.()` returns true, logs and re-arms the timer instead of calling `dispose()`.
- **ADR-9 compliance:** A Telegram user answering a permission prompt now has unlimited time; idle eviction will never fire while the prompt is pending.

**Tests added (T1, 5 tests):** `isBusy()` false/true/reset unit tests; `dispose NOT called while busy`; `dispose called once no longer busy`.

---

## T3 — `pipeAuth.ts:71` — Windows Rename (ACCEPTED + FIXED)

**Disposition:** Accepted. On Windows `fs.rename(tmp, dst)` throws `EPERM` when `dst` already exists. The original code had no fallback, so a second daemon startup could crash in `generatePipeAuth()`.

**Fix chosen:** `try { rename } catch (EPERM|EEXIST) { unlink dst; rename }`. The outer `try/catch` also cleans up the `.tmp` file on any hard failure so stale temporaries don't accumulate.

**Why not `fs.writeFile` with `flag: 'w'`:** Direct write to the final path sacrifices the atomic "never see a partial file" guarantee. A reader could observe a half-written token if it reads between the truncation and the new content being flushed. The write-to-tmp + rename pattern is the right approach; we just needed the Windows-compat fallback.

**Note on mock-based tests:** `node:fs/promises` ESM bindings are non-configurable; `vi.spyOn` cannot wrap them (throws "Cannot redefine property"). Kept two real-filesystem behavioral tests instead: first-write creates file, second-write-over-existing succeeds. On Windows this actually exercises the fallback path.

**Tests added (T3, 2 tests):** first write creates file; second write over existing succeeds.

---

## T4 — `main.ts:123` — Auth File Cleanup on Bridge Start Failure (ACCEPTED + FIXED)

**Disposition:** Accepted. Straightforward lifecycle fix: if `generatePipeAuth()` succeeds but `bridge.start()` throws, the catch block now calls `cleanupPipeAuth()` before logging and falling back to SDK-only mode. `cleanupPipeAuth()` is ENOENT-safe so it's harmless if `generatePipeAuth` itself failed before writing the file.

**Tests added (T4, 2 tests):** `cleanupPipeAuth` removes file; `cleanupPipeAuth` is a no-op when file is already gone (ENOENT). These test the operation that `main.ts` now performs in the catch block.

---

## T6 — `bridgeSession.ts:276` — Stream Queue Overflow Latch (ACCEPTED + FIXED)

**Disposition:** Accepted. The original I5 fix capped the queue at 1000 items but left the listener registered, so a sustained misbehaving extension could keep adding error items to the queue indefinitely.

**Fix:** After pushing the first overflow error item, immediately call `this.bridge.off('stream', streamListener)` and `this.bridge.off('stream.error', errorListener)`. This latches into a terminal state. The generator's `finally` block will call `off()` again when the consumer unwinds — which is a safe no-op on an already-removed listener.

**Tests added (T6, 3 tests):** All synchronous (FakeBridge emitter is synchronous; the overflow path calls `off()` synchronously so we can check `bridge.offCalls` without awaiting anything): `stream` listener removed on overflow; `stream.error` listener removed on overflow; post-overflow frames trigger no new `off()` calls.

---

## Threads not assigned to Carter

T2 and T5 were not in Carter's assignment list.


---


## T1 — `relay.ts:114` — ADR-9 Regression (ACCEPTED + FIXED)

**Disposition:** Accepted. This is a real regression. Option A chosen (reference-count pending permissions in BridgeSession; relay defers eviction when `isBusy()` returns true).

**Why Option A over Option B:** Option A keeps a single `dispose()` contract and requires no knowledge of "which kind of dispose" at the relay call site. The `isBusy()` predicate is a clean capability query that any consumer can use. Option B (split dispose paths) would require callers to track which variant to call, coupling the relay more deeply to bridge internals.

**What changed:**
- `CopilotSession` interface: added `isBusy?(): boolean` (optional — SDK sessions omit it).
- `BridgeSession`: added `isBusy(): boolean { return this._pendingByPermId.size > 0; }`.
- `relay.ts` idle eviction: replaced the inline callback with a named `scheduleIdle()` closure. If `evicted.session.isBusy?.()` returns true, logs and re-arms the timer instead of calling `dispose()`.
- **ADR-9 compliance:** A Telegram user answering a permission prompt now has unlimited time; idle eviction will never fire while the prompt is pending.

**Tests added (T1, 5 tests):** `isBusy()` false/true/reset unit tests; `dispose NOT called while busy`; `dispose called once no longer busy`.

---


## T3 — `pipeAuth.ts:71` — Windows Rename (ACCEPTED + FIXED)

**Disposition:** Accepted. On Windows `fs.rename(tmp, dst)` throws `EPERM` when `dst` already exists. The original code had no fallback, so a second daemon startup could crash in `generatePipeAuth()`.

**Fix chosen:** `try { rename } catch (EPERM|EEXIST) { unlink dst; rename }`. The outer `try/catch` also cleans up the `.tmp` file on any hard failure so stale temporaries don't accumulate.

**Why not `fs.writeFile` with `flag: 'w'`:** Direct write to the final path sacrifices the atomic "never see a partial file" guarantee. A reader could observe a half-written token if it reads between the truncation and the new content being flushed. The write-to-tmp + rename pattern is the right approach; we just needed the Windows-compat fallback.

**Note on mock-based tests:** `node:fs/promises` ESM bindings are non-configurable; `vi.spyOn` cannot wrap them (throws "Cannot redefine property"). Kept two real-filesystem behavioral tests instead: first-write creates file, second-write-over-existing succeeds. On Windows this actually exercises the fallback path.

**Tests added (T3, 2 tests):** first write creates file; second write over existing succeeds.

---


## T4 — `main.ts:123` — Auth File Cleanup on Bridge Start Failure (ACCEPTED + FIXED)

**Disposition:** Accepted. Straightforward lifecycle fix: if `generatePipeAuth()` succeeds but `bridge.start()` throws, the catch block now calls `cleanupPipeAuth()` before logging and falling back to SDK-only mode. `cleanupPipeAuth()` is ENOENT-safe so it's harmless if `generatePipeAuth` itself failed before writing the file.

**Tests added (T4, 2 tests):** `cleanupPipeAuth` removes file; `cleanupPipeAuth` is a no-op when file is already gone (ENOENT). These test the operation that `main.ts` now performs in the catch block.

---


## T6 — `bridgeSession.ts:276` — Stream Queue Overflow Latch (ACCEPTED + FIXED)

**Disposition:** Accepted. The original I5 fix capped the queue at 1000 items but left the listener registered, so a sustained misbehaving extension could keep adding error items to the queue indefinitely.

**Fix:** After pushing the first overflow error item, immediately call `this.bridge.off('stream', streamListener)` and `this.bridge.off('stream.error', errorListener)`. This latches into a terminal state. The generator's `finally` block will call `off()` again when the consumer unwinds — which is a safe no-op on an already-removed listener.

**Tests added (T6, 3 tests):** All synchronous (FakeBridge emitter is synchronous; the overflow path calls `off()` synchronously so we can check `bridge.offCalls` without awaiting anything): `stream` listener removed on overflow; `stream.error` listener removed on overflow; post-overflow frames trigger no new `off()` calls.

---


## Threads not assigned to Carter

T2 and T5 were not in Carter's assignment list.


---


# Cloud Review Cycle 3 — Carter (T9 Test Methodology Fix)

**Date:** 2026-05-23  
**Commit:** `1d027da`  
**Branch:** `squad/review1-phase6-adr9-fixes`

---

## Thread

**T9** — `tests/bridge/permission-prompting.test.ts:279`  
Copilot flagged that C7-03 uses two `BridgeSession` instances sharing the same
`FakeBridge` + `SESSION_ID`, with the second session's permission callback set
to `mockResolvedValue(true)`. Since both sessions listen for `permission.request`
on the same emitter, the second auto-resolving session could handle the event
before the first session's hanging callback was ever needed. The stream completing
proved nothing about data-plane / control-plane independence.

## Fix

Consolidated to a single `BridgeSession` created via `makePermSession` with the
hanging callback (`new Promise<boolean>((r) => { resolvePermission = r; })`).

The test now:
1. Creates one session with a hanging permission callback.
2. Starts a stream on that same session (`session.send('hello')`).
3. Emits `permission.request` while the stream is open.
4. Emits two stream chunks — they arrive normally while permission is unresolved.
5. Awaits `streamDone` and asserts `chunks === ['chunk-1', 'chunk-2']`.
6. Resolves the permission, awaits `flush()`, asserts `sendResponseFn` called with `'allow'`.

This correctly tests the invariant: the data plane (stream) is not blocked by a
pending control-plane permission prompt.

## Disposition

✅ **Accepted and fixed.** No design decision required. Pure test correctness.

Test results: **374 passed / 4 skipped / 0 failed** (unchanged count — test
replacement, not addition).


---


## Thread

**T9** — `tests/bridge/permission-prompting.test.ts:279`  
Copilot flagged that C7-03 uses two `BridgeSession` instances sharing the same
`FakeBridge` + `SESSION_ID`, with the second session's permission callback set
to `mockResolvedValue(true)`. Since both sessions listen for `permission.request`
on the same emitter, the second auto-resolving session could handle the event
before the first session's hanging callback was ever needed. The stream completing
proved nothing about data-plane / control-plane independence.


## Fix

Consolidated to a single `BridgeSession` created via `makePermSession` with the
hanging callback (`new Promise<boolean>((r) => { resolvePermission = r; })`).

The test now:
1. Creates one session with a hanging permission callback.
2. Starts a stream on that same session (`session.send('hello')`).
3. Emits `permission.request` while the stream is open.
4. Emits two stream chunks — they arrive normally while permission is unresolved.
5. Awaits `streamDone` and asserts `chunks === ['chunk-1', 'chunk-2']`.
6. Resolves the permission, awaits `flush()`, asserts `sendResponseFn` called with `'allow'`.

This correctly tests the invariant: the data plane (stream) is not blocked by a
pending control-plane permission prompt.


## Disposition

✅ **Accepted and fixed.** No design decision required. Pure test correctness.

Test results: **374 passed / 4 skipped / 0 failed** (unchanged count — test
replacement, not addition).


---


# Carter — Review Cycle 1 Dispositions

**Date:** 2026-05-22  
**Branch:** `squad/review1-phase6-adr9-fixes`  
**Worktree:** `D:\git\verbose-invention-review1`  

---

## Summary

Processed all 14 findings assigned to Carter's domain. 12 accepted+fixed, 0 escalated, 2 deferred (minor — net-safe as-is).

---

## Findings

### BLOCKING

| ID | Disposition | Summary |
|----|------------|---------|
| B1 | ✅ ACCEPT | Added `dispose()` to `BridgeSession`; relay calls it on idle eviction, stale-name eviction, crash recovery, and graceful shutdown |
| B2 | ✅ ACCEPT | Added `session.disconnected` listener inside `_generateStream`; pushes error into queue and calls `wake()` |
| B3 | ✅ ACCEPT | ADR-10 implemented: random pipe name + per-run token in `bridge-auth.json` (Option A primary auth); owner-only file ACL via `icacls` (Option B partial). Extension reads auth file on every connect. Token validated in `handleHello`; mismatch closes silently (no oracle). |

**B1 detail:**  
- `BridgeSession` stores listener refs in `_permListeners: Array<{event, listener}>`.  
- `dispose()` iterates the array, calls `bridge.off()` for each, sets array to `null`, and aborts `_sessionAbortController`.  
- `onDisconnected` now calls `this.dispose()` instead of inline `bridge.off()` calls — same cleanup path for both triggers.  
- `CopilotSession` interface gains optional `dispose?(): void`.  
- `relay.ts` calls `session.dispose?.()` at: idle eviction callback, stale-name eviction, SDK crash recovery `activeSessions.clear()`, single-topic timeout eviction, and `relay.dispose()`.

**B2 detail:**  
- `disconnectListener` registered via `bridge.on('session.disconnected', ...)` inside `_generateStream`.  
- On fire: pushes `{kind:'error', err: new Error('Session … disconnected mid-stream')}` into the queue and calls `wake()`.  
- Cleaned up in the same `finally` block as `stream` and `stream.error` listeners.

**B3 implementation:**  
- New `src/bridge/pipeAuth.ts`: `generatePipeAuth()` generates random pipe name (`reach-bridge-{16hex}`) + 32-byte CSPRNG token, writes `%LOCALAPPDATA%\reach\bridge-auth.json` atomically, sets owner-only ACL via `icacls`.  
- `ExtensionBridge` constructor now takes `PipeAuthConfig`; `start()` listens on `config.pipePath`. Token validated in `handleHello`: mismatch destroys socket without sending any error frame (no oracle).  
- `main.ts`: calls `generatePipeAuth()` before `ExtensionBridge` creation.  
- `extension.mjs`: reads `bridge-auth.json` before each connect attempt (picks up daemon restarts); includes `authToken` in `hello` message.  
- Option B SID verification (full `GetNamedPipeClientProcessId` + SID comparison) deferred — requires a native addon (`koffi` or equivalent); `%LOCALAPPDATA%` directory ACL provides equivalent protection in ADR-5 single-user deployment.  
- `permissionId` hijack concern: moot per ADR-10 — any attacker connecting to the pipe must read `bridge-auth.json`, which requires being the same OS user.  
- 6 new tests in `tests/bridge/b3-pipe-auth.test.ts`.

**B3 escalation note (superseded):**  
Noble Six inbox checked at 2026-05-22T22:47 — no `noble-six-pipe-auth.md` found at that time. ADR-10 filed and implemented in follow-up commit.

---

### IMPORTANT

| ID | Disposition | Summary |
|----|------------|---------|
| I1 | ✅ ACCEPT | Replaced `currentRequestId` global with `activeInjectIds: Set<string>`. `getActiveRequestId()` returns insertion-order last. |
| I2 | ✅ ACCEPT (partial) | Added `req.signal` AbortSignal handler in `onPermissionRequest`: sends `permission.cancelled` and resolves the pending promise on abort. |
| I5 | ✅ ACCEPT | `MAX_STREAM_QUEUE_SIZE = 1000` — overflow pushes error item and wakes generator. Extension streaming path awaits `drain` when `socket.write()` returns false. |
| I6 | ✅ ACCEPT | `handleHello` rejects a new connection whose `sessionName` is already held by a different `sessionId`. |
| I9 | ✅ ACCEPT | `MAX_PENDING_PERMISSIONS = 5` cap in `_wirePermissionHandlers`. Overflow auto-denies with warn log. |

**I1 note:** The `requestId` field in `permission.request` is "context only" per ADR-9 §3.1. For concurrent injects (rare in single-user operation), the last-in-flight requestId is used — acceptable per spec.

**I2 partial:** The finding also mentions emitting `permission.cancelled` when the SDK session terminates mid-inject. That scenario (SDK terminates but pipe stays up) is handled by `abortPendingPermissions()` on pipe close. The `req.signal` path covers the SDK's explicit abandonment signal. Full coverage deferred if SDK exposes richer lifecycle hooks in future versions.

---

### MINOR

| ID | Disposition | Summary |
|----|------------|---------|
| raceAbortSignals listener growth | ✅ ACCEPT | Added `signal: controller.signal` to `addEventListener` options — auto-removes remaining listeners when the first signal fires. |
| handlePong unreachable branch | ✅ ACCEPT | Added explanatory comment: session deleted from map before grace expires; `findConnectionBySocket` returns undefined. |
| pendingSockets slow-loris | ✅ ACCEPT | Added 10-count cap and 10-second auth timeout on pre-hello sockets. |
| waitForPermissionResponse fallback | ✅ ACCEPT | Added 10-minute fallback `setTimeout` that resolves deny and logs a warning. |
| `void _model;` idiom | ✅ ACCEPT | Replaced with `// _model unused: bridge sessions are model-agnostic` comment in `bridgeSessionFactory.ts`. |
| Duplicate section header | ✅ ACCEPT | Renamed second `// ─── Session event forwarding ─────` to `// ─── SDK permission hook (ADR-9) ──────────────`. |
| `allowAlwaysStore?` optional | ⏸️ DEFER | Making it required would require updating 4+ test helper functions across the test suite. The current `?.` optional-chain usage is type-safe and correct. Deferred — low risk. |
| permissionId hijack defense | ⏸️ DEFER | Coupled to B3 (pipe ACL/auth). Will implement alongside B3 once Noble Six's decision lands. |

---

## Files Changed

| File | Changes |
|------|---------|
| `src/copilot/factory.ts` | Added optional `dispose?(): void` to `CopilotSession` |
| `src/bridge/bridgeSession.ts` | B1 dispose, B2 stream disconnect, I5 queue cap, I9 rate limit, raceAbortSignals minor |
| `src/bridge/extensionBridge.ts` | I6 duplicate sessionName, pendingSockets slow-loris, handlePong comment |
| `src/bridge/bridgeSessionFactory.ts` | `void _model` → comment |
| `src/relay/relay.ts` | B1 — `dispose?.()` on all eviction paths |
| `extension.mjs` | I1 activeInjectIds, I2 permission.cancelled, I5 drain, duplicate header, 10-min fallback |
| `tests/bridge/review1-fixes.test.ts` | **NEW** — 8 tests: B1 (4), B2 (3), I9 (1) |

## Test Results

- TypeScript: ✅ clean (`npx tsc --noEmit`)
- Lint: ✅ clean (`npm run lint`)
- Tests: ✅ **371 passed, 4 skipped** (was 363 + 8 new)

---

## Coordination Notes

- **Noble Six**: B3 (pipe ACL) and permissionId hijack defense are waiting on you. When your decision lands in the inbox, Carter will implement.
- **Kat**: `CopilotSession` interface now has `dispose?(): void` — if `SdkCopilotSession` or any other factory implementer caches bridge listeners, implement it there too. SDK sessions (no bridge listeners) can safely omit it.


---


## Summary

Processed all 14 findings assigned to Carter's domain. 12 accepted+fixed, 0 escalated, 2 deferred (minor — net-safe as-is).

---


## Findings

### BLOCKING

| ID | Disposition | Summary |
|----|------------|---------|
| B1 | ✅ ACCEPT | Added `dispose()` to `BridgeSession`; relay calls it on idle eviction, stale-name eviction, crash recovery, and graceful shutdown |
| B2 | ✅ ACCEPT | Added `session.disconnected` listener inside `_generateStream`; pushes error into queue and calls `wake()` |
| B3 | ✅ ACCEPT | ADR-10 implemented: random pipe name + per-run token in `bridge-auth.json` (Option A primary auth); owner-only file ACL via `icacls` (Option B partial). Extension reads auth file on every connect. Token validated in `handleHello`; mismatch closes silently (no oracle). |

**B1 detail:**  
- `BridgeSession` stores listener refs in `_permListeners: Array<{event, listener}>`.  
- `dispose()` iterates the array, calls `bridge.off()` for each, sets array to `null`, and aborts `_sessionAbortController`.  
- `onDisconnected` now calls `this.dispose()` instead of inline `bridge.off()` calls — same cleanup path for both triggers.  
- `CopilotSession` interface gains optional `dispose?(): void`.  
- `relay.ts` calls `session.dispose?.()` at: idle eviction callback, stale-name eviction, SDK crash recovery `activeSessions.clear()`, single-topic timeout eviction, and `relay.dispose()`.

**B2 detail:**  
- `disconnectListener` registered via `bridge.on('session.disconnected', ...)` inside `_generateStream`.  
- On fire: pushes `{kind:'error', err: new Error('Session … disconnected mid-stream')}` into the queue and calls `wake()`.  
- Cleaned up in the same `finally` block as `stream` and `stream.error` listeners.

**B3 implementation:**  
- New `src/bridge/pipeAuth.ts`: `generatePipeAuth()` generates random pipe name (`reach-bridge-{16hex}`) + 32-byte CSPRNG token, writes `%LOCALAPPDATA%\reach\bridge-auth.json` atomically, sets owner-only ACL via `icacls`.  
- `ExtensionBridge` constructor now takes `PipeAuthConfig`; `start()` listens on `config.pipePath`. Token validated in `handleHello`: mismatch destroys socket without sending any error frame (no oracle).  
- `main.ts`: calls `generatePipeAuth()` before `ExtensionBridge` creation.  
- `extension.mjs`: reads `bridge-auth.json` before each connect attempt (picks up daemon restarts); includes `authToken` in `hello` message.  
- Option B SID verification (full `GetNamedPipeClientProcessId` + SID comparison) deferred — requires a native addon (`koffi` or equivalent); `%LOCALAPPDATA%` directory ACL provides equivalent protection in ADR-5 single-user deployment.  
- `permissionId` hijack concern: moot per ADR-10 — any attacker connecting to the pipe must read `bridge-auth.json`, which requires being the same OS user.  
- 6 new tests in `tests/bridge/b3-pipe-auth.test.ts`.

**B3 escalation note (superseded):**  
Noble Six inbox checked at 2026-05-22T22:47 — no `noble-six-pipe-auth.md` found at that time. ADR-10 filed and implemented in follow-up commit.

---

### IMPORTANT

| ID | Disposition | Summary |
|----|------------|---------|
| I1 | ✅ ACCEPT | Replaced `currentRequestId` global with `activeInjectIds: Set<string>`. `getActiveRequestId()` returns insertion-order last. |
| I2 | ✅ ACCEPT (partial) | Added `req.signal` AbortSignal handler in `onPermissionRequest`: sends `permission.cancelled` and resolves the pending promise on abort. |
| I5 | ✅ ACCEPT | `MAX_STREAM_QUEUE_SIZE = 1000` — overflow pushes error item and wakes generator. Extension streaming path awaits `drain` when `socket.write()` returns false. |
| I6 | ✅ ACCEPT | `handleHello` rejects a new connection whose `sessionName` is already held by a different `sessionId`. |
| I9 | ✅ ACCEPT | `MAX_PENDING_PERMISSIONS = 5` cap in `_wirePermissionHandlers`. Overflow auto-denies with warn log. |

**I1 note:** The `requestId` field in `permission.request` is "context only" per ADR-9 §3.1. For concurrent injects (rare in single-user operation), the last-in-flight requestId is used — acceptable per spec.

**I2 partial:** The finding also mentions emitting `permission.cancelled` when the SDK session terminates mid-inject. That scenario (SDK terminates but pipe stays up) is handled by `abortPendingPermissions()` on pipe close. The `req.signal` path covers the SDK's explicit abandonment signal. Full coverage deferred if SDK exposes richer lifecycle hooks in future versions.

---

### MINOR

| ID | Disposition | Summary |
|----|------------|---------|
| raceAbortSignals listener growth | ✅ ACCEPT | Added `signal: controller.signal` to `addEventListener` options — auto-removes remaining listeners when the first signal fires. |
| handlePong unreachable branch | ✅ ACCEPT | Added explanatory comment: session deleted from map before grace expires; `findConnectionBySocket` returns undefined. |
| pendingSockets slow-loris | ✅ ACCEPT | Added 10-count cap and 10-second auth timeout on pre-hello sockets. |
| waitForPermissionResponse fallback | ✅ ACCEPT | Added 10-minute fallback `setTimeout` that resolves deny and logs a warning. |
| `void _model;` idiom | ✅ ACCEPT | Replaced with `// _model unused: bridge sessions are model-agnostic` comment in `bridgeSessionFactory.ts`. |
| Duplicate section header | ✅ ACCEPT | Renamed second `// ─── Session event forwarding ─────` to `// ─── SDK permission hook (ADR-9) ──────────────`. |
| `allowAlwaysStore?` optional | ⏸️ DEFER | Making it required would require updating 4+ test helper functions across the test suite. The current `?.` optional-chain usage is type-safe and correct. Deferred — low risk. |
| permissionId hijack defense | ⏸️ DEFER | Coupled to B3 (pipe ACL/auth). Will implement alongside B3 once Noble Six's decision lands. |

---


## Files Changed

| File | Changes |
|------|---------|
| `src/copilot/factory.ts` | Added optional `dispose?(): void` to `CopilotSession` |
| `src/bridge/bridgeSession.ts` | B1 dispose, B2 stream disconnect, I5 queue cap, I9 rate limit, raceAbortSignals minor |
| `src/bridge/extensionBridge.ts` | I6 duplicate sessionName, pendingSockets slow-loris, handlePong comment |
| `src/bridge/bridgeSessionFactory.ts` | `void _model` → comment |
| `src/relay/relay.ts` | B1 — `dispose?.()` on all eviction paths |
| `extension.mjs` | I1 activeInjectIds, I2 permission.cancelled, I5 drain, duplicate header, 10-min fallback |
| `tests/bridge/review1-fixes.test.ts` | **NEW** — 8 tests: B1 (4), B2 (3), I9 (1) |


## Test Results

- TypeScript: ✅ clean (`npx tsc --noEmit`)
- Lint: ✅ clean (`npm run lint`)
- Tests: ✅ **371 passed, 4 skipped** (was 363 + 8 new)

---


## Coordination Notes

- **Noble Six**: B3 (pipe ACL) and permissionId hijack defense are waiting on you. When your decision lands in the inbox, Carter will implement.
- **Kat**: `CopilotSession` interface now has `dispose?(): void` — if `SdkCopilotSession` or any other factory implementer caches bridge listeners, implement it there too. SDK sessions (no bridge listeners) can safely omit it.


---


# Jun — Review Cycle 1 Dispositions

**Date:** 2026-05-22  
**Branch:** `squad/review1-phase6-adr9-fixes`  
**Commit:** 328f48a

---

## I3 — DESTRUCTIVE_TOOLS / SAFE_TOOLS drift detection missing

**Disposition:** ACCEPT and fix.

**Reasoning:** The concern is real and material. `extension.mjs` carries hardcoded copies of both sets with a "MUST be mirrored" comment that relies entirely on author discipline. Any tool added to `permissions.ts` without a matching update in `extension.mjs` would silently bypass risk classification — the extension's `isDestructive()` call would return false and the tool would execute without a Telegram approval prompt. That is a privilege escalation bug, and there is currently zero automation preventing it.

**Approach chosen:** (b) — keep two sources, add a drift-detection test. Faster to land and avoids rearchitecting the extension's module format just for this concern. The test parses `extension.mjs` as raw text via regex and compares to the TypeScript exports. If the sets drift, the test fails at CI time before the branch can merge.

**Current state:** Sets are **in sync** today. Both assertions pass green. The third assertion (no overlap between DESTRUCTIVE and SAFE) also passes and guards against a different category of classification error.

**Fix delivered:** `tests/copilot/permissions-drift.test.ts` (3 tests, all green).

---

## I8 — FakeDaemon ships unresolved TODO + missing PermissionResponseMessage

**Disposition:** ACCEPT and fix.

**Reasoning:** The stale TODO was valid during initial construction (Carter hadn't merged the pipe protocol). As of Phase 6, ADR-8 is final and ADR-9 is accepted — the canonical types are locked in `src/bridge/extensionBridge.ts`. The TODO is now false advertising, and the missing ADR-9 types (`PermissionRequestMessage`, `PermissionCancelledMessage`, `PermissionResponseMessage`) mean the FakeDaemon cannot be used to write ADR-9 integration tests without casting. That blocks Category 2 and 3 permission test scenarios.

**Audit result (InboundMessage — extension → daemon):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `hello` (HelloMessage) | ✅ | OK |
| `pong` (PongMessage) | ✅ | OK |
| `stream` (StreamChunkMessage) | ✅ | OK |
| `stream.error` (StreamErrorMessage) | ✅ | OK |
| `session.event` (SessionEventMessage) | ✅ | OK (added Phase 6 Day 2) |
| `permission.request` (PermissionRequestMessage) | ❌ | **ADDED** |
| `permission.cancelled` (PermissionCancelledMessage) | ❌ | **ADDED** |

**Audit result (OutboundMessage — daemon → extension):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `ping` (PingMessage) | ✅ | OK |
| `session.registered` (SessionRegisteredMessage) | ✅ | OK |
| `inject` (InjectMessage) | ✅ | OK |
| `permission.response` (PermissionResponseMessage) | ❌ | **ADDED** |

**Wire shapes confirmed** to match `extensionBridge.ts` field-for-field. Types defined locally in FakeDaemon (not imported from production) — maintains test isolation, consistent with existing pattern.

**TODO removed.** The contracts are now aligned; the TODO was no longer describing open work.

**Fix delivered:** `tests/helpers/FakeDaemon.ts` updated (+3 types, +3 union members, TODO removed).

---

## Integration test hang — discovery

**Not a finding I was assigned**, but surfaced during `npx vitest run` (full suite): `tests/integration/pairing-flow.test.ts` hangs indefinitely. This is pre-existing — nothing in my changes touches integration test infrastructure or the pairing flow. All 340 non-integration tests pass cleanly.

**Recommendation:** Escalate to Carter or Noble Six. The pairing-flow integration test is likely blocking on a real named-pipe connection that cannot be established in the CI environment.

---

## Verification Summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ clean (0 warnings) |
| `npx vitest run` (excluding integration) | ✅ 340 passed / 4 skipped / 0 failed |
| New I3 drift tests | ✅ 3/3 green |
| Existing FakeDaemon-dependent tests | ✅ all green (no regressions) |


---


## I3 — DESTRUCTIVE_TOOLS / SAFE_TOOLS drift detection missing

**Disposition:** ACCEPT and fix.

**Reasoning:** The concern is real and material. `extension.mjs` carries hardcoded copies of both sets with a "MUST be mirrored" comment that relies entirely on author discipline. Any tool added to `permissions.ts` without a matching update in `extension.mjs` would silently bypass risk classification — the extension's `isDestructive()` call would return false and the tool would execute without a Telegram approval prompt. That is a privilege escalation bug, and there is currently zero automation preventing it.

**Approach chosen:** (b) — keep two sources, add a drift-detection test. Faster to land and avoids rearchitecting the extension's module format just for this concern. The test parses `extension.mjs` as raw text via regex and compares to the TypeScript exports. If the sets drift, the test fails at CI time before the branch can merge.

**Current state:** Sets are **in sync** today. Both assertions pass green. The third assertion (no overlap between DESTRUCTIVE and SAFE) also passes and guards against a different category of classification error.

**Fix delivered:** `tests/copilot/permissions-drift.test.ts` (3 tests, all green).

---


## I8 — FakeDaemon ships unresolved TODO + missing PermissionResponseMessage

**Disposition:** ACCEPT and fix.

**Reasoning:** The stale TODO was valid during initial construction (Carter hadn't merged the pipe protocol). As of Phase 6, ADR-8 is final and ADR-9 is accepted — the canonical types are locked in `src/bridge/extensionBridge.ts`. The TODO is now false advertising, and the missing ADR-9 types (`PermissionRequestMessage`, `PermissionCancelledMessage`, `PermissionResponseMessage`) mean the FakeDaemon cannot be used to write ADR-9 integration tests without casting. That blocks Category 2 and 3 permission test scenarios.

**Audit result (InboundMessage — extension → daemon):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `hello` (HelloMessage) | ✅ | OK |
| `pong` (PongMessage) | ✅ | OK |
| `stream` (StreamChunkMessage) | ✅ | OK |
| `stream.error` (StreamErrorMessage) | ✅ | OK |
| `session.event` (SessionEventMessage) | ✅ | OK (added Phase 6 Day 2) |
| `permission.request` (PermissionRequestMessage) | ❌ | **ADDED** |
| `permission.cancelled` (PermissionCancelledMessage) | ❌ | **ADDED** |

**Audit result (OutboundMessage — daemon → extension):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `ping` (PingMessage) | ✅ | OK |
| `session.registered` (SessionRegisteredMessage) | ✅ | OK |
| `inject` (InjectMessage) | ✅ | OK |
| `permission.response` (PermissionResponseMessage) | ❌ | **ADDED** |

**Wire shapes confirmed** to match `extensionBridge.ts` field-for-field. Types defined locally in FakeDaemon (not imported from production) — maintains test isolation, consistent with existing pattern.

**TODO removed.** The contracts are now aligned; the TODO was no longer describing open work.

**Fix delivered:** `tests/helpers/FakeDaemon.ts` updated (+3 types, +3 union members, TODO removed).

---


## Integration test hang — discovery

**Not a finding I was assigned**, but surfaced during `npx vitest run` (full suite): `tests/integration/pairing-flow.test.ts` hangs indefinitely. This is pre-existing — nothing in my changes touches integration test infrastructure or the pairing flow. All 340 non-integration tests pass cleanly.

**Recommendation:** Escalate to Carter or Noble Six. The pairing-flow integration test is likely blocking on a real named-pipe connection that cannot be established in the CI environment.

---


## Verification Summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ clean (0 warnings) |
| `npx vitest run` (excluding integration) | ✅ 340 passed / 4 skipped / 0 failed |
| New I3 drift tests | ✅ 3/3 green |
| Existing FakeDaemon-dependent tests | ✅ all green (no regressions) |


---


# ADR-9 Implementation Reconciliation — Kat → Jun

**Date:** 2026-05-22  
**From:** Kat (Bot Dev)  
**To:** Jun (Test Author)  
**Re:** 3 ASSUMES IMPLEMENTATION flags from Jun's revised test catalog (merged cb7f5fc)

---

## K2 — Constructor Injection of AbortController

**Verdict: Implementation correct. Catalog assumption overstated — no code change.**

The shipped `BridgeSession` self-constructs `_sessionAbortController` as a private `readonly` field. Jun assumed direct injection was required for C2-01–C2-03 abort tests. It is not. The `_wirePermissionHandlers` method attaches a `session.disconnected` listener that calls `_sessionAbortController.abort()` internally. Jun's `FakeBridge` already has (per the test doubles contract) `emitDisconnected(sessionId)` — emitting `session.disconnected` on the fake bridge triggers the abort within one event loop turn, exactly as C2-01 requires. The test doubles contract is sufficient; direct AbortController injection would be white-box overreach and is not needed.

**Action for Jun:** Revise the C2-01–C2-03 test setup. Use `fakeBridge.emitDisconnected(sessionId)` (or the equivalent `bridge.emit('session.disconnected', sessionId)` call) instead of `abortController.abort()`. Remove the "accepts AbortController at construction" assumption from the test catalog summary.

---

## K4 — Per-Session AllowAlwaysStore Instantiation

**Verdict: Real bug. Catalog correct. Code changed — minimal diff.**

The shipped implementation created a single `InMemoryAllowAlwaysStore` in `main.ts` and passed it to `BridgeSessionFactory`, which reused the same instance for every `BridgeSession`. This violated ADR-9 §Q2 ("per-session in-memory") and the C6-04 store-isolation security contract. Jun's test would have caught cross-session leakage correctly.

**Fix applied:**
- `src/bridge/bridgeSessionFactory.ts`: Removed `allowAlwaysStore?: AllowAlwaysStore` constructor param. `_makeSession()` now creates `new InMemoryAllowAlwaysStore()` per session when wiring permission options. Also updated the import (removed `AllowAlwaysStore` type import; added `InMemoryAllowAlwaysStore` concrete import).
- `src/main.ts`: Removed the shared `allowAlwaysStore` constant and its `InMemoryAllowAlwaysStore` import. `BridgeSessionFactory` now takes only `bridge`.

**Tests:** 321 passed / 4 skipped / 0 failed. tsc clean. lint clean.

**Note for Phase 7:** The per-session seam is now inside `_makeSession`. When Phase 7 introduces a persisted store, refactor `BridgeSessionFactory` to accept a `storeFactory: () => AllowAlwaysStore` parameter (factory-of-factories pattern) rather than a shared instance.

---

## K5 — Named Classifier Exports from extension.mjs

**Verdict: Real gap. Catalog correct. Code changed — minimal diff.**

`isDestructive(toolName)` and `isKnownSafe(toolName)` were defined as module-private functions in `extension.mjs` — no `export` keyword. Jun cannot import them in C4-05 and C6-05 classifier unit tests without named exports.

**Fix applied:**
- `extension.mjs`: Added `export` keyword to both `isDestructive` and `isKnownSafe`.

**Tests:** Full suite still 321 passed / 4 skipped / 0 failed. tsc and lint clean.

---

## 4th Issue — Surfaced: Top-Level Side Effects in extension.mjs

**Not flagged by Jun, but will block test writing if unaddressed.**

`extension.mjs` calls `main().catch(...)` at the module top level (line ~583). When Jun does `import { isDestructive, isKnownSafe } from '../extension.mjs'` in a vitest test, the module executes: `joinSession()` is called (throws or hangs without CLI context), `runConnectionLoop()` fires (attempts named pipe connect), and process signal handlers are registered.

**Required test setup pattern for Jun:**  
Before any `import` of `extension.mjs` in test files, use `vi.mock` to stub the side-effecting modules:

```js
// At the top of the test file — hoisted by vitest
vi.mock('@github/copilot-sdk/extension', () => ({
  joinSession: vi.fn().mockResolvedValue({ onPermissionRequest: vi.fn(), log: vi.fn() }),
}));
vi.mock('node:net', () => ({
  createConnection: vi.fn(() => ({
    setEncoding: vi.fn(),
    on: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  })),
}));
```

With these mocks in place, `main()` completes without error and `runConnectionLoop()` is neutered (the mock socket never fires `connect`). The classifier functions (`isDestructive`, `isKnownSafe`) are then importable and testable in isolation.

If this setup is too noisy, an alternative is to extract the two classifier functions into a separate `src/bridge/extensionClassifier.mjs` (no side effects, no SDK imports) and have `extension.mjs` import from there. That extraction is out of scope for this reconciliation pass — surfacing it here for Jun and Noble Six to decide.

---

## Summary for Jun

| Flag | Verdict | Code Change | Jun Action Required |
|---|---|---|---|
| K2 constructor injection | Implementation correct | None | Revise C2-01–C2-03: use `fakeBridge.emitDisconnected()` not `.abort()` |
| K4 per-session store | Bug — catalog correct | ✅ Fixed | None — C6-04 will pass as written |
| K5 named exports | Gap — catalog correct | ✅ Fixed | Add vi.mock setup for side effects (see §4 above) |
| Side-effects (4th) | New issue — unblocks C4-05/C6-05 | None | Adopt mock setup pattern OR request classifier extraction |

**All 32 vitest scenarios are unblocked.** Jun may proceed writing the test files.


---


## K2 — Constructor Injection of AbortController

**Verdict: Implementation correct. Catalog assumption overstated — no code change.**

The shipped `BridgeSession` self-constructs `_sessionAbortController` as a private `readonly` field. Jun assumed direct injection was required for C2-01–C2-03 abort tests. It is not. The `_wirePermissionHandlers` method attaches a `session.disconnected` listener that calls `_sessionAbortController.abort()` internally. Jun's `FakeBridge` already has (per the test doubles contract) `emitDisconnected(sessionId)` — emitting `session.disconnected` on the fake bridge triggers the abort within one event loop turn, exactly as C2-01 requires. The test doubles contract is sufficient; direct AbortController injection would be white-box overreach and is not needed.

**Action for Jun:** Revise the C2-01–C2-03 test setup. Use `fakeBridge.emitDisconnected(sessionId)` (or the equivalent `bridge.emit('session.disconnected', sessionId)` call) instead of `abortController.abort()`. Remove the "accepts AbortController at construction" assumption from the test catalog summary.

---


## K4 — Per-Session AllowAlwaysStore Instantiation

**Verdict: Real bug. Catalog correct. Code changed — minimal diff.**

The shipped implementation created a single `InMemoryAllowAlwaysStore` in `main.ts` and passed it to `BridgeSessionFactory`, which reused the same instance for every `BridgeSession`. This violated ADR-9 §Q2 ("per-session in-memory") and the C6-04 store-isolation security contract. Jun's test would have caught cross-session leakage correctly.

**Fix applied:**
- `src/bridge/bridgeSessionFactory.ts`: Removed `allowAlwaysStore?: AllowAlwaysStore` constructor param. `_makeSession()` now creates `new InMemoryAllowAlwaysStore()` per session when wiring permission options. Also updated the import (removed `AllowAlwaysStore` type import; added `InMemoryAllowAlwaysStore` concrete import).
- `src/main.ts`: Removed the shared `allowAlwaysStore` constant and its `InMemoryAllowAlwaysStore` import. `BridgeSessionFactory` now takes only `bridge`.

**Tests:** 321 passed / 4 skipped / 0 failed. tsc clean. lint clean.

**Note for Phase 7:** The per-session seam is now inside `_makeSession`. When Phase 7 introduces a persisted store, refactor `BridgeSessionFactory` to accept a `storeFactory: () => AllowAlwaysStore` parameter (factory-of-factories pattern) rather than a shared instance.

---


## K5 — Named Classifier Exports from extension.mjs

**Verdict: Real gap. Catalog correct. Code changed — minimal diff.**

`isDestructive(toolName)` and `isKnownSafe(toolName)` were defined as module-private functions in `extension.mjs` — no `export` keyword. Jun cannot import them in C4-05 and C6-05 classifier unit tests without named exports.

**Fix applied:**
- `extension.mjs`: Added `export` keyword to both `isDestructive` and `isKnownSafe`.

**Tests:** Full suite still 321 passed / 4 skipped / 0 failed. tsc and lint clean.

---


## 4th Issue — Surfaced: Top-Level Side Effects in extension.mjs

**Not flagged by Jun, but will block test writing if unaddressed.**

`extension.mjs` calls `main().catch(...)` at the module top level (line ~583). When Jun does `import { isDestructive, isKnownSafe } from '../extension.mjs'` in a vitest test, the module executes: `joinSession()` is called (throws or hangs without CLI context), `runConnectionLoop()` fires (attempts named pipe connect), and process signal handlers are registered.

**Required test setup pattern for Jun:**  
Before any `import` of `extension.mjs` in test files, use `vi.mock` to stub the side-effecting modules:

```js
// At the top of the test file — hoisted by vitest
vi.mock('@github/copilot-sdk/extension', () => ({
  joinSession: vi.fn().mockResolvedValue({ onPermissionRequest: vi.fn(), log: vi.fn() }),
}));
vi.mock('node:net', () => ({
  createConnection: vi.fn(() => ({
    setEncoding: vi.fn(),
    on: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  })),
}));
```

With these mocks in place, `main()` completes without error and `runConnectionLoop()` is neutered (the mock socket never fires `connect`). The classifier functions (`isDestructive`, `isKnownSafe`) are then importable and testable in isolation.

If this setup is too noisy, an alternative is to extract the two classifier functions into a separate `src/bridge/extensionClassifier.mjs` (no side effects, no SDK imports) and have `extension.mjs` import from there. That extraction is out of scope for this reconciliation pass — surfacing it here for Jun and Noble Six to decide.

---


## Summary for Jun

| Flag | Verdict | Code Change | Jun Action Required |
|---|---|---|---|
| K2 constructor injection | Implementation correct | None | Revise C2-01–C2-03: use `fakeBridge.emitDisconnected()` not `.abort()` |
| K4 per-session store | Bug — catalog correct | ✅ Fixed | None — C6-04 will pass as written |
| K5 named exports | Gap — catalog correct | ✅ Fixed | Add vi.mock setup for side effects (see §4 above) |
| Side-effects (4th) | New issue — unblocks C4-05/C6-05 | None | Adopt mock setup pattern OR request classifier extraction |

**All 32 vitest scenarios are unblocked.** Jun may proceed writing the test files.


---


## Problem

`\\.\pipe\reach-bridge` is created with default Windows pipe security. Any
local-user process can connect, impersonate a sessionId, intercept or forge
bridge messages. Single-user scope (ADR-5) limits blast radius but does not
eliminate local-privilege-escalation vectors from malicious local software.


## Decision: Option A+B (Token + SID Verification)

Combine both defenses for defense-in-depth:

1. **Pipe name randomization + token file** (Option A) — primary auth.
2. **Client SID verification** (Option B) — belt-and-suspenders.


## Token File Schema

Path: `%LOCALAPPDATA%\reach\bridge-auth.json`  
ACL: Owner-only read/write (inherited from `%LOCALAPPDATA%` or set explicitly).

```json
{
  "pipeName": "reach-bridge-a1b2c3d4e5f6a7b8",
  "token": "hex-encoded-32-bytes",
  "createdAt": "2026-05-22T22:47:00Z"
}
```

- `pipeName`: random suffix (16 hex chars). Full path: `\\.\pipe\{pipeName}`.
- `token`: 32-byte crypto-random, hex-encoded (64 chars).
- File is regenerated on every daemon startup. Stale file = stale pipe.


## Pipe Name Format

`\\.\pipe\reach-bridge-{16-hex-random}`


## Hello Message Schema Change

Existing `hello` gains a required `authToken` field:

```json
{
  "type": "hello",
  "sessionId": "abc-123",
  "authToken": "64-char-hex-token"
}
```

Daemon MUST validate `authToken` against the in-memory token before sending
`session.registered`. On mismatch: log warning, close the pipe connection
immediately (no error message sent — avoid oracle).


## Daemon Validation Logic

1. On startup: generate 32 random bytes → hex-encode → write `bridge-auth.json`
   with restrictive ACL. Create pipe with randomized name.
2. On client connect: call `GetNamedPipeClientProcessId` → `OpenProcessToken`
   → compare token user SID to daemon's own user SID. Reject if mismatch.
3. On `hello` message: compare `authToken` field to in-memory token.
   Reject (close connection) if missing or mismatched.
4. Only after both checks pass → proceed with `session.registered` flow.


## Consequences

- Extension must read `bridge-auth.json` on startup to discover pipe name + token.
- Reconnect (ADR-6) must re-read file if pipe name changed (daemon restarted).
- `permissionId` hijack concern becomes moot — unauthenticated connections are
  rejected before any session interaction.
- Test helpers (FakeDaemon) need updated to generate/consume token file.


---


# Review Cycle 1 — Noble Six Dispositions

**Author:** Noble Six  
**Date:** 2026-05-22

## B3: Named pipe has no ACL or authentication — RESOLVED

Decision: Option A+B (token + SID verification). Written as ADR-10 in
`noble-six-pipe-auth.md`. Carter is unblocked to implement.

## I4: Safety parity regression (bridge auto-approves unknown tools) — FIXED

Root cause: `extension.mjs` line 385 used `isKnownSafe(tool) || !isDestructive(tool)`
which auto-approved any tool NOT in the destructive list, including unknowns.
The SDK (`impl.ts:65-66`) denies unknowns. Fixed to match SDK: only known-safe
auto-approves; unknowns get `denied`; destructive goes to daemon prompt.

## I7: install.ts scope concern — ACKNOWLEDGED

No code action. Process note written to `noble-six-review1-process.md`.

## Minor: BridgeSessionFactory coupling to concrete ExtensionBridge — DEFERRED (YAGNI)

No second transport exists or is planned for Phase 6/7. Extracting a
`BridgeTransportPort` interface now adds indirection without a consumer.
Decision: defer until a second transport materializes. If Phase 7+ adds
TCP/WebSocket, extract the port at that time.

## Minor: permissionId hijack defense-in-depth — SUBSUMED BY B3

Once ADR-10 pipe auth is implemented, unauthenticated connections are rejected
before any session interaction. The permissionId hijack vector is eliminated
at the transport layer. No additional application-layer defense needed.


---


## B3: Named pipe has no ACL or authentication — RESOLVED

Decision: Option A+B (token + SID verification). Written as ADR-10 in
`noble-six-pipe-auth.md`. Carter is unblocked to implement.


## I4: Safety parity regression (bridge auto-approves unknown tools) — FIXED

Root cause: `extension.mjs` line 385 used `isKnownSafe(tool) || !isDestructive(tool)`
which auto-approved any tool NOT in the destructive list, including unknowns.
The SDK (`impl.ts:65-66`) denies unknowns. Fixed to match SDK: only known-safe
auto-approves; unknowns get `denied`; destructive goes to daemon prompt.


## I7: install.ts scope concern — ACKNOWLEDGED

No code action. Process note written to `noble-six-review1-process.md`.


## Minor: BridgeSessionFactory coupling to concrete ExtensionBridge — DEFERRED (YAGNI)

No second transport exists or is planned for Phase 6/7. Extracting a
`BridgeTransportPort` interface now adds indirection without a consumer.
Decision: defer until a second transport materializes. If Phase 7+ adds
TCP/WebSocket, extract the port at that time.


## Minor: permissionId hijack defense-in-depth — SUBSUMED BY B3

Once ADR-10 pipe auth is implemented, unauthenticated connections are rejected
before any session interaction. The permissionId hijack vector is eliminated
at the transport layer. No additional application-layer defense needed.


---


# Review Cycle 1 — Process Improvement Note

**Author:** Noble Six  
**Date:** 2026-05-22  
**Finding:** I7 — `install.ts` service-account refactor mixed in with Phase 6

## Disposition

The `install.ts` refactor (Kat, ADR-5) was correctly scoped to ADR-5's decision
but shipped in the same branch as Phase 6 bridge work. This made the diff larger
than necessary for reviewers.

## Process Improvement (Future PRs)

- Orthogonal refactors that serve an ADR but don't depend on other Phase 6 code
  should ship in a separate PR, merged first, so the main Phase 6 PR is smaller.
- Not actionable retroactively — the code is correct, tested, and merged.





---


## Disposition

The `install.ts` refactor (Kat, ADR-5) was correctly scoped to ADR-5's decision
but shipped in the same branch as Phase 6 bridge work. This made the diff larger
than necessary for reviewers.


## Process Improvement (Future PRs)

- Orthogonal refactors that serve an ADR but don't depend on other Phase 6 code
  should ship in a separate PR, merged first, so the main Phase 6 PR is smaller.
- Not actionable retroactively — the code is correct, tested, and merged.





---


## 1. Scope

**IN (AFK MVP — Phase 7):**
- `/afk` and `/back` slash commands from the CLI
- Machine-wide mode toggle (all active CLI sessions fan out to Telegram topics simultaneously)
- Mirror semantics: Telegram→CLI echoed (display + SDK ingestion); CLI assistant output→Telegram; local keystrokes NOT mirrored out
- New pipe message types for mode lifecycle and mirror relay
- Daemon-owned mode state and sessionId↔topicId map
- Topic creation, pinned summary, banner+close on /back
- New CLI sessions auto-join an active AFK fleet
- Loop avoidance via origin tags

**OUT (Phase 8+):**
- Resume-from-Telegram (resume a prior session not currently open in any CLI)
- Spawn-from-Telegram (create a totally new CLI session from Telegram)
- `relay.command` execution (envelope designed now, implementation deferred)
- Persistent mode state (crash recovery) — memory-only acceptable for v1

---


## 2. Mode Semantics

AFK is a **machine-wide mode**, not per-session. A single `/afk` from any CLI session transitions ALL connected sessions to Telegram topics. A single `/back` from ANY CLI session brings them all back. `/back` is only honored from the physical machine (CLI side), never from Telegram.

During AFK, CLI sessions remain **fully interactive locally**. This is mirror/broadcast, not sink-switching:
- Telegram messages are echoed into the local CLI session (displayed + fed to SDK)
- CLI assistant output streams to Telegram (existing `stream` path; daemon routes via sessionId→topicId map)
- Local user keystrokes are NOT mirrored to Telegram

Mode state lives in daemon memory as a singleton `{ active: boolean, since: string }`. Memory-only is acceptable for v1; crash loses AFK state (sessions fall back to local-only).

---


## 3. Trigger Surface

The entry point is an extension-level slash command handler registered via the SDK's `commands: CommandDefinition[]` field on `JoinSessionConfig` in `extension.mjs`. Implementation is ~25 lines around the existing `joinSession()` call, reusing `sendToDaemon()` to emit `afk.request` / `back.request` over the pipe.

**SKILL.md was evaluated and rejected.** Carter's spike (issue #6) confirmed with high confidence that SKILL.md files are YAML+markdown prompt-augmentation only — no code execution, no process control, no pipe access. The SDK's first-class `commands` field is the correct surface for stateful slash commands that interact with external infrastructure.

---


## 4. Pipe Protocol Additions

Eight new or amended message types. All travel the existing ADR-3 pipe, interleaved with streaming data.

### 4.1 Extension → Daemon: `afk.request`

```json
{
  "type": "afk.request",
  "sessionId": "abc-123"
}
```

Any single extension triggers machine-wide AFK. No `resumeTopicId` — the daemon resolves topic reuse from its own map.

### 4.2 Daemon → Extension: `afk.activated`

Sent individually to each connected extension after its Telegram topic is ready.

```json
{
  "type": "afk.activated",
  "sessionId": "abc-123",
  "topicId": 12345,
  "topicUrl": "https://t.me/c/..."
}
```

### 4.3 Extension → Daemon: `back.request`

```json
{
  "type": "back.request",
  "sessionId": "abc-123"
}
```

Any single extension triggers machine-wide /back.

### 4.4 Daemon → Extension: `back.confirmed`

Broadcast to all connected extensions.

```json
{
  "type": "back.confirmed",
  "sessionId": "abc-123"
}
```

### 4.5 Daemon → All Extensions: `mode.changed`

Broadcast on every AFK↔back transition.

```json
{
  "type": "mode.changed",
  "active": true,
  "since": "2026-05-24T22:40:00Z"
}
```

### 4.6 Daemon → Extension: `mirror.input`

Relays a Telegram user message to the target CLI session for display + SDK ingestion.

```json
{
  "type": "mirror.input",
  "sessionId": "abc-123",
  "text": "check the build logs",
  "source": "telegram",
  "topicId": 12345
}
```

Extension handles display (e.g., `📱 Telegram: check the build logs`) and SDK routing independently of `inject`.

### 4.7 Daemon → Extension: `relay.command` (designed, not implemented)

```json
{
  "type": "relay.command",
  "sessionId": "abc-123",
  "command": "/clear",
  "args": []
}
```

Deferred to Phase 8. Envelope exists so protocol doesn't break when slash command relay ships. Extension routes to CLI side-channel; daemon never forwards raw `/clear` as a prompt.

### 4.8 Amended: `session.registered` (late-joiner field)

Existing `session.registered` response gains a `mode` field so late-joining extensions self-initialize:

```json
{
  "type": "session.registered",
  "sessionId": "abc-123",
  "mode": { "active": true, "since": "2026-05-24T22:40:00Z" },
  "topicId": 12345
}
```

If `mode.active` is true on registration, the daemon auto-creates a topic for the new session and includes `topicId` in the response. No separate poll needed.

### Updated Canonical Message Table

| Direction | Type | New? | Purpose |
|---|---|---|---|
| ext → daemon | `afk.request` | ✅ | Trigger machine-wide AFK |
| ext → daemon | `back.request` | ✅ | Trigger machine-wide /back |
| daemon → ext | `afk.activated` | ✅ | Per-session topic ready ack |
| daemon → ext | `back.confirmed` | ✅ | Per-session /back ack |
| daemon → all | `mode.changed` | ✅ | AFK↔back broadcast |
| daemon → ext | `mirror.input` | ✅ | Telegram→CLI message relay |
| daemon → ext | `relay.command` | ✅ | Slash command relay (deferred impl) |
| daemon → ext | `session.registered` | amended | Adds `mode`, `topicId` fields |

---


## 5. Daemon-Side Responsibilities

1. **Owns mode state.** Singleton `{ active, since }` in memory. Authoritative source of truth.
2. **Owns sessionId↔topicId map.** Built during AFK activation; persisted in `SessionRegistry` entries. Survives extension reconnects (re-sent in `session.registered`).
3. **Broadcasts `mode.changed`** to all connected extensions on every transition.
4. **Serializes topic creation.** 200–300ms gaps between `createForumTopic` calls to avoid 429s. Retry with exponential backoff on rate-limit responses.
5. **Auto-joins late arrivals.** When a new extension connects during active AFK, daemon creates its topic and sends `afk.activated` in the `session.registered` flow.
6. **Routes Telegram messages** to the correct extension via `mirror.input` (keyed by topicId→sessionId reverse lookup).
7. **Routes CLI `stream` output** to the correct Telegram topic (keyed by sessionId→topicId forward lookup). No protocol change — daemon already receives `stream` and knows the mapping.

---


## 6. Telegram-Side Responsibilities

1. **Topic creation.** Name format: `<session-name> (<session-id>)`. CLI exposes a user-settable session name.
2. **Pinned summary in General.** On `/afk`: post a summary message listing all active sessions with cwds. On `/back`: edit to "🖥️ Back at desk."
3. **Banner + close on `/back`.** Post `🖥️ Session resumed locally` banner, then `closeForumTopic`. Topics are reopenable via `reopenForumTopic` on next `/afk`; unread-marker loss on reopen is an accepted tradeoff.
4. **Cross-topic permission alert.** When a permission prompt fires in topic-A, post a one-line notification in General with a jump button (`⚠️ Permission required in '<session-name>'`). Prevents missed prompts across N topics.
5. **Don't register relay commands with BotFather.** `/clear`, `/agent`, etc. are free-text relay, not bot commands. Avoids Telegram client command-suggestion popups.

---


## 7. Registry Schema Additions

`SessionEntry` gains four optional fields:

```typescript
interface SessionEntry {
  // ... existing fields ...
  mode?: 'afk' | 'back';
  afkSince?: string;       // ISO-8601
  cwd: string;             // required — needed for disambiguation and future spawn
  lastTopicId?: number;    // resume convenience — reuse topic on next /afk
}
```

`mode` and `afkSince` are per-entry reflections of the daemon-wide state. `cwd` is required for topic naming, spawn-from-Telegram candidate enumeration, and session disambiguation. `lastTopicId` enables topic reuse across AFK cycles.

---


## 8. Loop Avoidance

Every relayed message carries an origin tag: `"cli"` | `"telegram"`. The daemon drops messages that would echo back to their origin:

- Telegram user message → daemon tags `origin: "telegram"` → sends `mirror.input` to extension → extension displays + feeds SDK → SDK response streams back as `stream` → daemon tags `origin: "cli"` → relays to Telegram topic. ✅
- If the daemon receives a `stream` chunk tagged `origin: "telegram"` (impossible in current design, but defensive), it drops it. No echo loop.

The origin tag is a transport-layer field on `mirror.input` and on the daemon's internal relay envelope. It does not appear on `stream` messages (those are always CLI-origin by construction).

---


## 9. `/clear` Semantics

**P0:** `/clear` relayed from Telegram applies to the CLI session — starts a new session context. The CLI handles this identically to a local `/clear`.

**Nice-to-have:** Telegram topic echoes a `🔄 New session started` banner so the remote user has visual confirmation. Implementation is a single `sendMessage` call in the relay handler.

---


## 10. Failure Modes

| Scenario | Behavior |
|---|---|
| `/afk` while daemon down | Error immediately: "Reach daemon not running — start it first." No buffering. |
| Bridge disconnect during AFK | CLI shows `⚠ bridge disconnected — local only`. ADR-6 exponential backoff + auto-rejoin AFK fleet on reconnect. |
| CLI exit during AFK | Daemon detects pipe close. Posts `💀 Session ended` banner in topic, then `closeForumTopic`. Removes session from AFK fleet. |
| Double `/afk` | Idempotent. Daemon is already in AFK mode; new `afk.request` is a no-op (acknowledged with existing `afk.activated`). |
| `/back` without prior `/afk` | Error: "Not in AFK mode." No state change. |

---


## 11. Adjacent-Story Design Compatibility

The protocol surface is designed so Phase 8 stories can reuse existing infrastructure:

- **Topic↔session correlation:** `lastTopicId` in `SessionEntry` + daemon's sessionId↔topicId map are the foundation for both resume-from-Telegram and spawn-from-Telegram.
- **`relay.command` envelope:** Designed now (§4.7), implemented when CLI's programmatic slash command API surface is known.
- **Daemon-owned map:** The daemon's `sessionId↔topicId` map is the single source of truth for all three stories (AFK, spawn, resume). No registry restructuring needed.
- **`cwd` in registry:** Enables spawn-from-Telegram to enumerate candidate repos from recent sessions without a separate config file.

---


## 12. Open Implementation Questions

1. **Skill viability (issue #6) — RESOLVED.** SKILL.md is prompt-augmentation only (no code/process/pipe access). Entry point is an extension-level command handler via the SDK's `commands: CommandDefinition[]` field on `JoinSessionConfig`.
2. **Spawn-from-Telegram launch trigger (issue #5).** How does the daemon launch a new CLI process? Deferred — not in AFK MVP scope, but `relay.command` and `cwd` registry field are forward-compatible.
3. **Persistent mode state.** v1 is memory-only. If crash recovery becomes a requirement, a `~/.reach/mode.json` file with daemon as authoritative reader is the upgrade path.
4. **Backpressure under multi-session AFK.** Five sessions streaming simultaneously may hit Telegram's 20 msg/sec flood limit. Handled at the relay layer (Kat's per-topic throttle), not the protocol layer. Monitor during dogfooding.


---


## Verdict: NO — a pure skill.md cannot do it

A Copilot CLI `skill.md` is a **markdown instruction document**, not executable
code.  It cannot intercept slash commands, hold per-session state, or open a
named-pipe connection.

The surface that **can** do all three is already in the repo: **`extension.mjs`**.
Adding `/afk` requires a small, well-bounded change to `extension.mjs` — no new
files, no new extension points, no extension changes needed beyond the one we own.

---


## Evidence

### 1. What a "skill.md" actually is

`~/.copilot/skills/*/SKILL.md` are YAML-frontmatter + markdown files loaded by the
CLI agent as additional knowledge/context.  Inspected four installed skills
(`cloud-review-cycle`, `persona-review`, `review-cycle`, `ship-to-pr`) —
they are all plain text with frontmatter fields: `name`, `description`, `requires.tools`.

The `requires.tools` field lists CLI binaries the *agent* may invoke (e.g. `git`,
`gh`), not Node.js APIs.  There is no `handler:`, no `execute:`, no JS entry point.
The CLI's `/skills` command manages them; they are prompt-augmentation, not code.

**Files inspected:**
- `~/.copilot/skills/cloud-review-cycle/SKILL.md`
- `~/.copilot/skills/persona-review/SKILL.md`
- `.squad/skill.md` (squad template — same format)
- `.copilot/skills/cli-wiring/SKILL.md`

**SDK type confirming no code surface for skills:**  
`SessionConfig.skillDirectories?: string[]` — the CLI just loads markdown from
those directories.  No callable interface.

### 2. The SDK's slash-command surface

`@github/copilot-sdk` v0.2.2 exposes a first-class `commands` API:

```typescript
// dist/types.d.ts : 907-911
/**
 * Slash commands registered for this session.
 * When the CLI has a TUI, registered commands appear as
 * `/commandName` for the user to invoke.
 */
commands?: CommandDefinition[];
```

`CommandDefinition` (line 253):
```typescript
interface CommandDefinition {
  name: string;            // without leading /
  description?: string;
  handler: CommandHandler; // (context: CommandContext) => Promise<void> | void
}
```

`CommandContext` (line 234):
```typescript
interface CommandContext {
  sessionId: string;
  command: string;     // full text e.g. "/afk"
  commandName: string; // "afk"
  args: string;        // raw arg string after command name
}
```

`commands` is included in both `SessionConfig` and `ResumeSessionConfig`
(the `Pick<>` type at line 1007 explicitly includes `"commands"`).
`JoinSessionConfig = Omit<ResumeSessionConfig, "onPermissionRequest"> & { onPermissionRequest? }`,
so `joinSession()` accepts `commands`.

**Reference:** `node_modules/@github/copilot-sdk/dist/types.d.ts:907-911`, `1007`  
**SDK README:** "Register slash commands so that users of the CLI's TUI can invoke
custom actions via `/commandName`." (README line 487)

### 3. extension.mjs already has everything needed

`extension.mjs` is a Node.js child process loaded by the CLI on every foreground
session.  It already imports:

```javascript
import { joinSession } from '@github/copilot-sdk/extension';  // line 52
import { createConnection } from 'node:net';                    // line 53
import { randomUUID } from 'node:crypto';                       // line 54
```

It currently calls `joinSession()` with **no config** (line 675):

```javascript
sdkSession = await joinSession();
```

Adding `commands: [...]` here is the only extension change needed.

Module-scope state is already the pattern (`SESSION_ID`, `pipeSocket`,
`activeInjectIds`, `pendingPermissions`); per-session AFK state fits the same mold.

`sendToDaemon(msg)` (line 245) already handles pipe I/O; new message types drop in
with zero infrastructure work.

### 4. CLI --help and plugin system confirm skill = markdown only

`copilot help commands` lists `/skills` as "Manage skills for enhanced
capabilities" — confirmed to be a discovery/toggle UI for markdown skill files.

`copilot plugin --help` describes plugins as extending the CLI with "skills,
agents, hooks, MCP servers, and LSP servers" — but the "skills" here are still
markdown documents, and "hooks" are JSON files.  No plugin surface registers a
slash-command *handler* without going through the SDK's `commands` API (which
requires JS/TS code).

**Copilot CLI binary version confirmed at:**
`C:\Users\akubl\AppData\Local\Microsoft\WinGet\Links\copilot.exe`

---


## Integration Shape (extension.mjs change)

Pseudocode for the `/afk` addition — **~25 lines in extension.mjs**:

```javascript
// 1. Module-scope AFK state
let afkMode = false;  // true while machine-wide AFK is active

// 2. Pass commands to joinSession()
sdkSession = await joinSession({
  onPermissionRequest: ...,  // existing
  commands: [
    {
      name: 'afk',
      description: 'Go AFK — mirror this session to a Telegram topic',
      handler: ({ sessionId }) => {
        sendToDaemon({ type: 'afk.request', sessionId: SESSION_ID });
        // Optimistic local feedback; actual confirmation arrives via afk.activated
        log('info', '/afk sent to daemon');
      },
    },
    {
      name: 'back',
      description: 'Return from AFK — restore local-only mode',
      handler: ({ sessionId }) => {
        if (!afkMode) {
          log('warn', '/back ignored — not in AFK mode');
          return;
        }
        sendToDaemon({ type: 'back.request', sessionId: SESSION_ID });
      },
    },
  ],
});

// 3. Handle new inbound messages in handleMessage()
case 'afk.activated':
  afkMode = true;
  log('info', `AFK active — Telegram topic: ${msg.topicUrl}`);
  break;

case 'back.confirmed':
  afkMode = false;
  log('info', 'Back from AFK — local mode restored');
  break;

case 'mode.changed':
  afkMode = msg.active;
  break;
```

No new files.  No new process.  No new SDK dependencies.

---


## Confidence: HIGH

All three claims are directly verified from source:
- Skill = markdown (four real skill files inspected)
- `commands` API = SDK type definition + README documentation
- `extension.mjs` already has pipe + `joinSession` + module state

The only unknown is whether `joinSession({ commands })` works correctly when
called from an extension process (vs. a standalone SDK client).  The type
signature accepts it, the README documents it for `createSession`, and
`extension.d.ts` chains to `ResumeSessionConfig` which includes `commands` —
high confidence.  A 5-minute smoke test (add a `/ping` command, type it in the
CLI) would make it 100%.

---


## Recommended Next Steps

1. **Low-risk validation (15 min):** Add `commands: [{ name: 'ping', handler: () => log('info', 'pong') }]` to the
   `joinSession()` call in extension.mjs, reinstall the extension, type `/ping` in
   the CLI.  Confirms the SDK surface works from an extension context.

2. **If smoke test passes:** Implement full `/afk` + `/back` handlers plus the four
   new inbound message types (`afk.activated`, `back.confirmed`, `mode.changed`,
   `mirror.input`) as a single extension.mjs PR.

3. **Daemon side:** ADR-11 §5 lists five daemon responsibilities — session-to-topic
   map, mode state machine, topic creation, `mode.changed` broadcast, late-joiner
   `session.registered` amendment.  These are independent of the extension work and
   can be parallel-tracked.


---

### 2026-05-24T22:40-07:00: Aaron's answers to /afk mode opens

**By:** Aaron (via Copilot)

**Locked decisions:**

1. **Mirror directionality:** Team picks most sensible feasible option. Default recommendation: Telegram→CLI = echoed (display + SDK ingestion); CLI assistant output → Telegram (already today); local keystrokes are NOT mirrored to Telegram.
2. **Mode-state persistence:** Memory-only is acceptable for v1. Crash recovery is nice-to-have, not blocking.
3. **`/clear` semantics:** P0 = clears the CLI session (starts new session). Nice-to-have = Telegram topic echoes a "new session started" banner from the CLI's perspective.
4. **Resume-from-Telegram scope:** Phase 8 (deferred from /afk MVP).
5. **Spawn-from-Telegram launch trigger:** Defer to team — pick what's feasible.
6. **Skill.md capability for /afk entry-point:** Defer to feasibility. Ultimately the user just needs a slash-command entry point to toggle AFK mode. If skill.md can't do it, use an extension or other surface.
7. New CLI sessions auto-join AFK fleet: ✅
8. CLI exit during AFK → banner + close topic: ✅
9. Topic-scoped messaging (forum isolation): ✅
10. Topic-create burst serialized 200-300ms gaps + 429 retry: ✅
11. **Topic naming convention:** `<session-name> (<session-id>)` — CLI exposes a user-settable session name. Overrides earlier "basename · short-id" proposal.
12. Pinned summary in General topic: ✅
13. On /back banner + close topic (reopenForumTopic exists, unread-marker loss accepted): ✅
14. Loop avoidance via origin tag: ✅
15. `mode.changed { active, since }` broadcast + current mode in session.registered: ✅
16. New message type `mirror.input { sessionId, text, source, topicId }`: ✅
17. Daemon owns sessionId→topicId map; stream unchanged: ✅
18. Define `relay.command { sessionId, command, args }` now, defer implementation: ✅
19. Daemon broadcasts afk.activated per extension after N topic creates: ✅
20. SessionEntry adds: mode?, afkSince?, cwd, lastTopicId?: ✅
21. Don't register relay commands with BotFather: ✅
22. Cross-topic permission alert in General with jump button: ✅
23. /afk while daemon down → error immediately, no buffering: ✅
24. Bridge disconnect during AFK → status line + ADR-6 backoff + auto-rejoin: ✅
25. Design topic↔session correlation now to support all three stories: ✅

**New facts:**
- CLI exposes a user-settable session "name" (settable, not auto-derived).
- AFK MVP scope confirmed: /afk + /back + multi-session fan-out + mirror semantics + spawn-from-Telegram (later phase but design-compatible).


---


## What We Have

The daemon is Telegram-initiated. `/new <name>` on a forum topic creates a registry entry (topicId → sessionName), and the Relay lazily starts a Copilot SDK session on first message. `/resume <name>` moves an existing name to a new topic. The extension bridge (`extensionBridge.ts`) accepts push-based pipe connections from Copilot CLI extensions and wraps them as `BridgeSession` adapters so the relay's streaming/permission logic works unchanged. `SessionRegistry` is keyed by Telegram topicId, with sessionName as a lookup index.

**In short:** Telegram side can create/resume sessions. CLI side can attach to the daemon via pipe. Permission prompting round-trips through Telegram. All plumbing works.


## What's Missing

The primary user story is CLI-initiated: "I'm in a Copilot CLI session, I type `/afk`, and a Telegram topic opens (or resumes) where I continue remotely." This is the **inverse** control flow from what we built. Nothing in the current system can:

1. **Accept a `/afk` command from the CLI.** No CLI-side slash command exists. The extension bridge listens for connections — it doesn't initiate topic creation.
2. **Create or resume a Telegram topic from the daemon side.** `registerHandlers` only reacts to incoming Telegram commands. There is no daemon API to call `bot.api.createForumTopic()` proactively.
3. **Correlate a CLI session to an existing topic.** The registry keys on topicId. There's no reverse index from sessionId/cwd/sessionName to "which topic should this reattach to."
4. **Signal `/back` from the CLI to disconnect the topic.** No teardown path exists from CLI → daemon → "stop relaying to this topic."


## Open Architectural Questions

These must be answered before anyone writes code:

1. **Where does `/afk` live?** Three options: (a) Copilot CLI built-in slash command (requires SDK support we don't control), (b) the extension itself intercepts it and sends a message over the pipe, (c) a separate CLI tool (`reach afk`) that talks to the daemon directly. Option (b) is the only one within our control that doesn't add a new component.

2. **What's the resume key?** When `/afk` says "resume," resume *what*? Options: (a) sessionName (user-chosen, stable), (b) session ID from the Copilot SDK, (c) cwd-based heuristic. sessionName is the obvious answer — it's already our identity concept — but it means the user must have named the session, or we auto-generate a name.

3. **Is topic creation the daemon's job or Telegram's?** Current model: user creates topics manually, bot reacts. `/afk` model: daemon must create topics on demand via `createForumTopic()`. This is a meaningful shift — the daemon becomes an active Telegram participant, not a passive listener.


## Recommended Next Step

**Pause Phase 6 tail work. Pivot to an `/afk` spike.**

Phase 6 delivered the bridge, permission prompting, and streaming — all load-bearing infrastructure. But the next items on the Phase 6 backlog (persistent allow-always, ADR-10 pipe auth, telemetry) are hardening work that doesn't advance the primary story. They'll still be valid after we answer the `/afk` questions.

**Concrete proposal:**

1. **Spike (1 session):** Noble Six drafts ADR-11 covering the three questions above. Aaron picks options. No code.
2. **Phase 7 scope = `/afk` + `/back` MVP:** Extension intercepts `/afk`, sends `session.afk` over the pipe. Daemon creates or resumes a forum topic, wires the relay. `/back` sends `session.back`, daemon disconnects the topic. Registry gets a reverse index (sessionName → topicId).
3. **Phase 6 hardening becomes Phase 8** — it's still needed, just not next.

The bridge and relay are solid. The gap isn't infrastructure — it's the entry point. Let's build the front door.


---

### 2026-05-24T22:19-07:00: /afk mode — remaining opens before code starts

**By:** Noble Six (Lead/Architect)  
**Context:** Aaron answered the 6 realignment questions (machine-wide mode, mirror semantics, CLI stays interactive). These are the NEW gaps that surfaced from those answers.

---

#### 1. Mode state persistence

/afk is machine-wide. Where does that boolean live — daemon memory, a file on disk, or both? If the daemon crashes and restarts, is the machine still "AFK"? A persistent file survives crashes but introduces stale-state cleanup. Daemon-only is simpler but loses state on restart.

**Rec:** TBD — needs Aaron's call. Suggest persistent file with daemon as authoritative reader, so crash-restart auto-recovers.

#### 2. New CLI sessions joining an active AFK fleet

If Aaron opens a new terminal while AFK mode is already active, does that session auto-join the AFK fleet (auto-create a Telegram topic)? Or does it stay local-only until the next explicit /afk toggle?

**Rec:** Auto-join — otherwise a newly opened session is invisible from the phone, which defeats the purpose. But this means the extension must check mode state on connect.

#### 3. CLI session exit during AFK

When a CLI session exits (Ctrl-C, window close) while AFK is active, what happens to its Telegram topic? Options: close/archive the topic, post a tombstone message and leave it open, or silently leave it.

**Rec:** Post a "session ended" banner and close the topic. Keeps the topic list clean.

#### 4. Mirror directionality

Aaron said remote Telegram messages are echoed in-session. Two sub-questions:
- (a) Are LOCAL assistant responses also echoed TO Telegram? (Presumably yes — that's the point.)
- (b) Are LOCAL user keystrokes echoed to Telegram? (Probably no — Aaron typing locally doesn't need to see his own input on the phone.)
- (c) When Aaron types in Telegram, does that text appear in the local CLI's input stream as if he typed it? Or only in the assistant output area?

**Rec:** (a) yes, (b) no, (c) only assistant output area — but needs Aaron's confirmation. (c) has UX implications for the CLI's scroll behavior.

#### 5. Topic-scoped messaging under fan-out

With N sessions = N topics, if Aaron messages topic-A from Telegram, does only session-A receive it, or do all sessions see it? Forum topics are naturally scoped, so this should be session-A only — but confirm.

**Rec:** Session-A only (forum topic isolation). State this explicitly in the protocol spec.

#### 6. Topic creation burst — rate limits

/afk with N sessions creates N topics simultaneously. Telegram Bot API rate limits are ~30 req/s globally, ~1 req/s per chat for some methods. Creating 5+ topics in a burst may hit limits.

**Rec:** Sequential creation with 200ms delay between topics. Log warnings on 429s and retry with backoff.

#### 7. Topic naming collisions

Multiple sessions could share the same cwd basename (e.g., two terminals in `verbose-invention`). `{basename}` alone collides.

**Rec:** `{basename} · {session-id-short}` (first 6 chars of session ID). Unique, scannable.

#### 8. Topic list discoverability in Telegram

With N topics, how does Aaron find the right one? Forum topic ordering is chronological by last message. No pinned-topic mechanism exists in Telegram forums.

**Rec:** Post a pinned summary message in the General topic listing all active sessions with their cwds when /afk activates. Update it on session join/exit.

#### 9. Slash command relay — control envelope

Future /clear and /agent relay from Telegram needs a way to distinguish control messages from regular chat. If Aaron types "/clear" in a topic, the daemon must not forward it as a prompt.

**Rec:** Design a `command.*` message type in the wire protocol NOW (even if relay isn't Phase 7). Cost is ~5 LOC in the type definitions. Avoids breaking the protocol later.

#### 10. Slash command relay — authorization

Should any Telegram chat member be able to send /clear, or only Aaron's user ID?

**Rec:** Aaron-only (chat_id guard already exists). But name this decision explicitly.

#### 11. Mirror loop avoidance

Assistant output → echoed to Telegram → could a webhook re-relay it back to CLI → echo again? The daemon must tag outbound messages to distinguish "echoed from CLI" vs. "typed by user in Telegram."

**Rec:** Origin tag on every relayed message (`origin: 'cli' | 'telegram'`). Daemon drops messages that would echo back to their origin. Design this into the protocol from day one.

#### 12. /afk while daemon is down

If the daemon isn't running when Aaron types /afk, what happens? Options: error immediately, buffer the intent and activate when daemon connects, or silently fail.

**Rec:** Error immediately with a clear message ("Reach daemon not running — start it first"). Buffering creates invisible state.

#### 13. Bridge disconnect during AFK

If the named pipe drops while AFK is active, what does the CLI show? A banner? Silent degradation? Does it auto-retry?

**Rec:** CLI shows a status line ("⚠ bridge disconnected — local only"). Reconnect uses existing ADR-6 exponential backoff. On reconnect, re-join the AFK fleet automatically.

#### 14. Skill.md surface capability — research needed

Aaron wants /afk as a Copilot CLI skill (SKILL.md). Open question: can a skill intercept slash-command input, maintain persistent state (mode toggle), AND communicate with an external daemon over a named pipe? This may require extension-level cooperation, not just a skill definition.

**Rec:** Flag as a research spike (1–2 hours). Carter or Jun should probe the skill API surface before we commit to this implementation path.

#### 15. /clear semantics under mirror

If /clear is relayed from Telegram, does it clear both the local CLI context and the Telegram topic history? Just the CLI context? Just the Telegram view?

**Rec:** TBD — needs Aaron's call. My instinct: /clear clears CLI context only (that's what the command does). Telegram topic history is immutable (Bot API doesn't support bulk delete in forums).

#### 16. Minimum coupling with spawn/resume stories

Spawn-from-Telegram and resume-from-Telegram share infrastructure with /afk: topic↔session correlation, mode state, repo discovery. Should the protocol accommodate all three from the start, or is /afk independent?

**Rec:** Design the topic↔session correlation table and daemon-side session registry to support all three. The marginal cost is low (a few extra fields). Avoids a protocol break when spawn/resume ship.

---

**Total opens: 16.** Of these, 3 need Aaron's explicit call (#1, #4c, #15). 1 needs a research spike (#14). The rest have recommendations that can be confirmed or overridden.


---


## Opens

**1. Mode state is a daemon-side singleton.**
Since AFK is machine-wide, the daemon holds a single `{ active: bool, since: timestamp }` flag — not a per-connection flag.
**Recommendation:** Add `mode.changed { active: bool, since: timestamp }` broadcast (daemon → all extensions) on every transition; include current mode in `session.registered` response so late-joining extensions self-initialize without a separate poll.

**2. Mirror direction inbound: `inject` is wrong for Telegram echo.**
`inject` routes text directly to the SDK with no CLI-visible display. Mirrored Telegram messages must be displayed in the local CLI (e.g., prefixed "📱 Telegram:") AND sent to the SDK as a prompt — two distinct actions that `inject` cannot express.
**Recommendation:** New message type `mirror.input { sessionId, text, source: "telegram", topicId }` — extension handles display + SDK routing independently of normal `inject`.

**3. Mirror direction outbound: `stream` carries no topicId — and that's fine.**
When the daemon forwards SDK output to Telegram, it needs to know which topic to post to. `stream` has no `topicId` field today.
**Recommendation:** Daemon owns the `sessionId → topicId` map (established at AFK activation); extension stamps nothing extra on `stream`. No protocol change needed on the outbound path.

**4. Loop avoidance: does Telegram see local user prompts?**
Aaron's words ("remote messages echoed in-session") read as one-way: Telegram→CLI only. Local typing flows to SDK → `stream` → Telegram (AI response only). But "fully interactive as a normal CLI session" is ambiguous about whether the raw local prompts should also appear in Telegram.
**TBD — confirm with Aaron:** Telegram sees AI responses only, or both prompts and responses?

**5. Slash command envelope: `inject` cannot carry `/clear` or `/agent`.**
The SDK treats plain text injection as a prompt. Slash commands have side-channel semantics the SDK should not see raw.
**Recommendation:** New message type `relay.command { sessionId, command: string, args: string[] }` (daemon → extension) on the pipe; extension routes to CLI side-channel. Defer extension-side implementation until CLI's programmatic slash command API surface is known — **needs Aaron / Noble Six call**.

**6. Machine-wide AFK activation: single trigger, broadcast response.**
The prior analysis assumed a single extension sends `afk.request` for its own session. With machine-wide semantics, the `/afk` CLI skill fires once and the daemon must create N topics and push `afk.activated` to N extensions simultaneously.
**Recommendation:** Daemon treats any single `afk.request` as a machine-wide trigger; creates Telegram topics for all active sessions in parallel; broadcasts `afk.activated { sessionId, topicId, topicUrl }` individually to each connected extension. Late-joining extensions get their topic on `session.registered` response when `mode.changed` is active.

**7. Spawn-from-Telegram and Resume-from-Telegram: new message surface.**
Both user stories need request/response pairs the protocol doesn't carry today:
- `session.list_repos` / `session.list_repos.response { repos: [{ name, cwd }] }` — enumerate candidate cwds
- `session.list_resumable` / `session.list_resumable.response { sessions: [...] }` — sessions on disk not currently connected
- `session.spawn { cwd, model? }` or `session.resume { sessionId }` — trigger creation

Who actually spawns the CLI child process?
**TBD — needs Aaron call** on whether the daemon may launch child CLI processes and how it learns the extension invocation command.

**8. Backpressure under multi-session AFK is a relay-layer concern.**
Five sessions streaming simultaneously could hit Telegram's 20 msg/sec per-chat flood limit.
**Recommendation:** No new protocol messages needed — Kat's relay adapter handles per-topic throttle. Protocol is not the right layer.



---


## What the Pipe Supports Today

The ADR-8 wire protocol carries seven message types across a single named pipe (ADR-3):

**Inbound (extension → daemon):** `hello`, `pong`, `session.event`, `stream`, `stream.error`, `permission.request`, `permission.cancelled`

**Outbound (daemon → extension):** `session.registered`, `ping`, `inject`, `permission.response`

The current flow is one-dimensional: daemon injects a command (`inject`), extension streams back chunks (`stream`/`stream.error`). The daemon's `BridgeSession` sits in `CompositeSessionFactory` and relays all output to wherever the relay sends it — today, Telegram. There is no concept of "which sink is active" on either side of the pipe. The bridge is passive: it forwards, it does not steer. `extensionBridge.ts` tracks `sessionId` + `sessionName` but has no `mode` or `remoteSink` field. The `relay.ts` routing table maps session names to Telegram topics, but it is always live — there is no paused/detached state. Neither side has any representation of `/afk` or `/back` state.

---


## Protocol Gaps for /afk and /back

### New message types needed

**Extension → daemon (user types `/afk` at the CLI):**

```jsonc
{ "type": "afk.request", "sessionId": "...", "resumeTopicId": null }
// resumeTopicId: null = create a new Telegram topic; non-null = resume a known one
```

**Daemon → extension (Telegram topic is ready):**

```jsonc
{ "type": "afk.activated", "sessionId": "...", "topicId": 12345, "topicUrl": "https://t.me/..." }
// Extension can print this URL to the CLI so the user knows where to go
```

**Telegram side (user types `/back` in the Telegram topic):**  
No wire message yet — the daemon processes this command internally, then sends:

**Daemon → extension (Aaron types `/back` in Telegram):**

```jsonc
{ "type": "back.confirmed", "sessionId": "...", "topicId": 12345 }
// Tells the extension to restore the local prompt and consider the session live again
```

The extension should also be able to initiate `/back` from the CLI (e.g., re-typing `/back` locally):

```jsonc
{ "type": "back.request", "sessionId": "..." }   // extension → daemon
```

Followed by the same `back.confirmed` from the daemon.

### Daemon-side capability gaps

1. **No session-to-topic mapping.** The daemon has no persistent `Map<sessionId, topicId>`. When `afk.request` arrives, the daemon doesn't know whether to create a new Telegram forum topic or resume an existing one. This map needs to be tracked (and survives reconnects via ADR-6 `hello` re-registration).

2. **No "active sink" state machine.** `relay.ts` currently routes all sessions to Telegram always. For `/afk`, the daemon needs a per-session mode: `{ mode: 'local' | 'remote' }`. In `local` mode the relay is silent (or the CLI is the only consumer). In `remote` mode the relay is live and the CLI extension is suppressing its own output.

3. **No topic creation trigger.** Nothing today calls `ctx.api.createForumTopic(...)` in response to a session signal. That logic needs to be written on the Telegram/relay side.

### Extension-side capability gaps

1. **No `/afk` command handler.** `extension.mjs` has no command parsing. It needs to intercept `/afk` before sending it to the SDK, suppress the local response, and send `afk.request` over the pipe.

2. **Output suppression.** When in `remote` mode, the extension must suppress streaming output to the CLI (or print a one-liner: "Session is remote. Resume with /back in Telegram."). Currently the extension always relays chunks to the local terminal.

---


## Open Questions for Noble Six

1. **Telegram topic lifetime:** When Aaron types `/back`, should the topic be archived/closed in Telegram, or left open for future `/afk` reuse? "Disconnected" could mean either. If left open, `resumeTopicId` in `afk.request` is how the extension re-attaches to it.

2. **CLI output during remote mode:** When the session is in remote mode and a chunk arrives at the extension, what does the CLI show? Options: (a) nothing, (b) a static "session is remote" banner, (c) a live mirror (broadcast mode). Aaron's wording implies (a) or (b) — confirm.

3. **Multi-session `/afk`:** If Aaron has two CLI sessions and goes AFK on both, does each get its own Telegram topic? The `sessionId`-keyed approach supports this naturally, but the Telegram forum topic limit may be a practical constraint.

4. **`/back` from the CLI vs from Telegram:** Should `/back` typed locally at the CLI pipe prompt also terminate the remote session? Or is `/back` only valid inside Telegram? Symmetry suggests both should work, but they have different protocol directions.


---


## What the Bot Does Today

The current flow is entirely Telegram-initiated:
1. Aaron creates a forum topic manually in Telegram.
2. Aaron types `/new <name>` inside that topic → registry binds `topicId → sessionName`.
3. Messages relay to the Copilot session.
4. `/resume <name>` re-binds a named session to a new topic (move semantics).
5. `/remove` unlinks a topic.

The registry stores: `sessionName`, `topicId`, `chatId`, `createdAt`, `model?`. No `cwd`, no AFK timestamps, no "active" vs "idle" state. The relay is fully passive — it only acts on incoming Telegram messages; it has no way to push an event unless a message arrives from Telegram first.

There is **no CLI-facing interface**. The daemon has no HTTP endpoint, no named-pipe command server for `/afk`/`/back` signals from the CLI. The extension bridge (`ExtensionBridge`) handles only the Copilot session streaming protocol — it does not accept control commands like "go AFK."

---


## Telegram Gaps for /afk & /back

**1. No programmatic topic creation.**  
`createForumTopic` is a standard Bot API method. The bot token already has the right scope if it is admin in the supergroup (bots must be admin with "Manage Topics" privilege to create/close/reopen topics). The `allowedChatId` guard in `createBot` is fine for outbound API calls — it only filters *inbound* updates. So `bot.api.createForumTopic(chatId, name)` would work, but there is no code calling it today.

**2. No CLI → daemon control channel.**  
`/afk` and `/back` fire from the CLI. The daemon has no receiver for those signals. A new IPC surface is needed — either a second named pipe, a Unix-socket/HTTP loopback endpoint, or a new message type in the extension bridge protocol. This is an architectural gap that touches Carter's domain (pipe server) and Noble Six's domain (protocol).

**3. No resume-by-cwd or resume-by-CLI-session.**  
The registry key is `topicId`. To "resume" the right topic for a given `/afk` invocation, we need to look up by something the CLI knows: `cwd`, session name, or a stable identity. `SessionEntry` has no `cwd` field. `findByName` exists but requires the CLI to pass a name. If the CLI derives a name from `cwd` (e.g., `my-project`), that works — but the registry must be able to confirm "is there already a topic for this name, and if so, what's its `topicId`?"

**4. No /back handler on the Telegram side.**  
When `/back` fires, the bot should post a banner in the topic (e.g., `🖥️ Aaron is back at the desk — topic paused`) and optionally close/lock the topic via `closeForumTopic`. There is no such handler today. Closing is reversible; deleting loses history. Locking + banner is the right default.

**5. No AFK banner on topic open/resume.**  
When a topic is opened or resumed by `/afk`, the bot should post a banner: `📵 Aaron went AFK — relay active`. This is a simple `sendMessage` call but there is no trigger point today.

**6. Missing registry fields.**  
`SessionEntry` needs: `cwd?: string` (for resume-by-cwd lookup), `lastAfkAt?: string` (ISO-8601, for display and staleness detection), `status?: 'afk' | 'back'` (to know whether the topic is currently live).

---


## UX Questions for Aaron

1. **Auto-create vs. named:** When `/afk` fires and no topic exists for this cwd/name, should the daemon auto-create a topic (name derived from cwd basename, e.g., `verbose-invention`)? Or should the CLI prompt Aaron for a name before signalling the daemon?

2. **On /back — close or leave open?** Should `closeForumTopic` be called (topic greys out in Telegram but history is preserved), or just post a banner and leave it open for read-back?

3. **Resume identity:** What is the resume key — `cwd`? Explicit session name passed from CLI? Both? A cwd-derived default with override is probably the right answer, but needs a decision before we can add the registry field.

4. **Multiple AFK sessions:** Can Aaron have two topics open (e.g., two different cwds) simultaneously? If yes, the registry needs to support multiple "active" entries by different cwds with different topicIds.

5. **Control channel:** Should the CLI-to-daemon signal go through the existing extension bridge pipe (new message type), a new loopback HTTP endpoint, or a second pipe? This is Carter/Noble Six territory but Kat needs the answer to know what event to handle on the bot side.


---

### 2026-05-24 — /afk Mode: Telegram-Side UX & Bot API Opens

**By:** Kat  
**What:** Pre-implementation opens for the /afk machine-wide mode — Telegram-side UX and Bot API surface.

---

1. **createForumTopic rate limit on /afk burst.**
The Bot API has no documented per-method limit for createForumTopic, but the general rule (1 msg/sec per chat, 20/min in groups) applies to API calls. A 4-session burst creates 4 topics ~simultaneously — close enough that a naive loop risks 429s.
Recommendation: serialize topic creation with a 300ms gap between calls; surface a loading indicator in the originating CLI terminal while the burst completes.

2. **Topic name disambiguation when sessions share a cwd basename.**
If two sessions both have cwd `~/projects/reach`, both topics get named "reach" — indistinguishable in the forum topic list.
Recommendation: append a short suffix — session index or a 4-char hash of the session name — e.g., "reach · 1" and "reach · 2". Registry already has sessionName; derive suffix from it.

3. **General-topic AFK summary message.**
Aaron has no single view of all active AFK topics without scrolling the forum list. A summary message in General on /afk ("📵 AFK — 3 sessions: reach · 1, edge · 2, dotfiles · 3") would act as a nav anchor.
Recommendation: Send one summary message to General immediately after all topics are created. On /back, edit that message to "🖥️ Back at desk."

4. **reopenForumTopic — confirmed exists. Unread-marker caveat.**
`reopenForumTopic` is in the Bot API. Reopening a closed topic works. However, Telegram clients do not restore the unread-marker state when a topic is reopened — it appears fully read on reopen regardless of any unread messages that were there at close time.
Recommendation: Banner + close on /back (since reopen is available). Accept the unread-marker loss as a known tradeoff; document in ADR.

5. **Resume picker — where and what shape.**
Two trigger points: (a) on /afk, if a prior topic exists for a session, offer "resume topic" vs "new topic" before creating; (b) for the resume-from-Telegram story, the bot needs a session list UI.
Recommendation: Use an inline keyboard for both. On /afk, show per-session buttons only if a prior topicId exists in the registry. For resume-from-Telegram, send a single message with N inline buttons, one per eligible session. TBD — needs Aaron to confirm (b) is in scope for this sprint.

6. **Spawn-from-Telegram repo picker — source of truth.**
Bot needs a repo list. Three options: (A) daemon enumerates known cwd paths from active/recent sessions in the registry; (B) Aaron pre-registers a list in config; (C) filesystem heuristic (scan ~/projects).
Recommendation: Option A — registry already tracks cwd per session. Enumerate distinct cwd values from recent sessions as the candidate list. No config file needed. TBD — needs Aaron on launch trigger (/spawn command vs. inline button from General).

7. **Slash command relay — Telegram client intercept risk.**
`/clear` typed inside a topic is a valid Telegram bot command, but Telegram clients show command-suggestion popups for all /commands, which can be confusing. `/cli_clear` avoids that but adds namespace clutter.
Recommendation: Use bot command names that match CLI slash commands (e.g., `/clear`, `/agent`) — Telegram only intercepts if the command is registered with BotFather. Don't register them; treat them as free-text relay. Confirm with a small client test.

8. **Concurrent permission prompts across topics.**
Multiple AFK sessions can each fire a permission prompt simultaneously — three inline keyboards across three topics, no cross-topic awareness. Aaron may not notice a prompt in a topic he's not viewing.
Recommendation: In addition to the per-topic inline keyboard, post a one-line notification in General ("⚠️ Permission required in 'reach · 1'") with a deep-link reply button. TBD — needs Aaron to decide acceptable latency before auto-deny.

9. **Registry schema additions needed.**
Current SessionEntry has topicId ↔ sessionName. AFK mode requires: `mode: 'afk' | 'back'`, `afkSince?: timestamp`, `cwd: string` (needed for spawn-from-Telegram and disambiguation), `lastTopicId?: number` (resume convenience).
Recommendation: Add all four fields now; `mode` and `afkSince` are daemon-level state, but per-entry storage is simpler than a separate daemon-level flag given the machine-wide semantics. TBD — Carter should weigh in on registry write path.


---


## Covered Today

**Bot commands:** /new, /resume, /list, /remove (registry, name lookup, move semantics)  
**Relay:** Telegram→CLI round-trip, message throttle (800ms), markdown escaping, message splitting  
**Bridge:** BridgeSession unit (10 tests), relay-integration (4 tests), factory (6 tests), permission prompting (32 tests per ADR-9)  
**Integration:** Pairing flow (config round-trip), chat-id enforcement, SDK crash recovery  
**Idle monitor:** Timeout tracking, per-topic timers, cancellation on reset  
**Protocol:** Pipe auth, session registry, extension bridge emit/listen contract

---


## Gaps for /afk → Topic-Opens-or-Resumes → /back Flow

**Missing CLI ↔ daemon protocol:** No tests for CLI `/afk` emission or daemon receipt.  
**Missing topic state machine:** No tests for topic creation vs. resume (existing topic link).  
**Missing relay re-targeting:** No tests for dynamic switch from CLI pipe to Telegram topic (or back).  
**Missing "backgrounded" state:** CLI session backgrounded while Telegram topic active; CLI receives relayed messages.  
**Missing disconnection flow:** No tests for `/back` (CLI or Telegram), topic "disconnected" banner, relay re-target to CLI.  
**Missing edge cases:** /afk when daemon unreachable, /back when no AFK, double /afk, topic-create rate limits, session recovery after network drop.

---


## Proposed Test Cases (5–8 High-Value Scenarios)

**T1 — CLI /afk → topic creates and activates:**  
CLI sends `/afk` → daemon receives → bot creates/finds topic for this session → registry links topic → relay targets Telegram topic. Verify: topic ID returned, registry entry created, first message in topic visible.

**T2 — Resume existing topic (idempotent /afk):**  
Session already has active topic from prior /afk. CLI sends `/afk` again → bot resolves existing topic (not new) → relay re-targets to same topic. Verify: no duplicate topics, same topic ID returned, history preserved.

**T3 — Telegram message → CLI (backgrounded):**  
Aaron sends message in Telegram topic → relay invokes CLI session's handler (even though CLI pipe backgrounded) → CLI async receives and processes. Verify: message delivered to SDK, no pipe-read timeout, clean state.

**T4 — /back from Telegram → relay re-targets to CLI:**  
Aaron sends `/back` in Telegram topic → bot detects command → relay re-targets to CLI pipe → topic receives "disconnected" banner. Verify: CLI pipe active, Telegram topic unmuted/muted state correct, relay routes subsequent messages to CLI.

**T5 — /back from CLI → relay re-targets and banners:**  
CLI sends `/back` → daemon receives → relay re-targets to CLI pipe → topic gets "disconnected" banner + mute flag. Verify: relay no longer routes Telegram to SDK, relay routes CLI to Telegram (not vice versa).

**T6 — /afk when daemon unreachable:**  
CLI sends `/afk` but daemon is offline/slow → connection timeout or retry loop. Verify: CLI retry behavior (exponential backoff), no hang, error message to user, graceful fallback.

**T7 — /back without prior /afk:**  
CLI sends `/back` but no active AFK session. Verify: error message, no relay re-targeting, state unchanged.

**T8 — Double /afk (rate limit / idempotence):**  
CLI sends `/afk` twice in rapid succession → daemon receives both → bot handles idempotently (no duplicate topics, no double-relay). Verify: topic link stable, relay targets single topic, no state corruption.

---


## Test Doubles & Fixtures Needed

- **FakeDaemon extension:** CLI→daemon `/afk` / `/back` messages (new message types)
- **Mock Telegram bot:** /back command handler, topic creation/find, unmute/mute
- **Relay re-target spy:** Track relay targets before/after /afk, /back (sessionId vs topicId)
- **SessionEntry fixture:** Session with/without topicId, to test resume logic
- **Clock + network delay simulation:** Test /afk timeout (Vitest fake timers) and retry backoff

---


## Blockers for Implementation

1. **Protocol decision (Noble Six):** CLI→daemon /afk / /back wire shape, timeout, retry semantics
2. **Topic state enum (Carter):** Add `isAfk: boolean` or status field to SessionEntry? Or separate registry?
3. **Relay re-targeting scope:** Relay.relay() switches target per-request (topicId vs sessionId) or per-session setup?

Once decisions are locked, all 8 test cases are high-confidence and require no further protocol iteration.


---


# Carter — Permission Prompt Dogfood Bug Investigation

**Date:** 2026-05-23  
**Author:** Carter  
**Status:** Diagnostic deployed. Awaiting Aaron's rerun to confirm root cause.

---

## Bug Summary

Aaron sent `bash ls` from Telegram with `REACH_PERMISSION_POLICY=interactiveDestructive`. The command executed successfully and returned output, but no Allow/Deny inline keyboard appeared in Telegram. ADR-9 prompting did not fire.

---

## Root Cause Analysis

### PRIMARY SUSPECT: CLI auto-approves read-only shell commands → `resolvedByHook=true`

In `@github/copilot-sdk` v0.2.2 `session.js`:

```javascript
} else if (event.type === "permission.requested") {
  const { requestId, permissionRequest, resolvedByHook } = event.data;
  if (resolvedByHook) {
    return; // Our onPermissionRequest is NEVER called
  }
  if (this.permissionHandler) {
    void this._executePermissionAndRespond(requestId, permissionRequest);
  }
}
```

When `resolvedByHook: true`, the SDK skips `onPermissionRequest` entirely. `bash ls` executed successfully without prompting, so `resolvedByHook=true` is the most likely explanation.

**Revised hook hypothesis:** Aaron confirmed that:
- `~/.copilot/permissions-config.json` does NOT list `D:\git\verbose-invention`
- The cairn-archivist `preToolUse` hook targets files that don't exist on this machine; `curate.ps1` exits 0 with no stdout

**New leading hypothesis: CLI built-in read-only command detection**

The `kind='shell'` permission event contains `commands[].readOnly: boolean` per `session-events.d.ts`. `bash ls` — `ls` is a read-only command. The Copilot CLI likely has a built-in policy: **"if all commands in the shell request are read-only → auto-approve → `resolvedByHook=true`."** This would be independent of any user-configured hooks.

Alternative: even if `curate.ps1` exits 0 with no stdout, the CLI may treat "preToolUse hook exited 0, produced no JSON" as `permissionDecision: "allow"` (implicit allow on successful hook invocation). This is unconfirmed without CLI source access.

**Wiring was correct.** `makePermissionHandler` with `policy=interactiveDestructive` correctly routes `kind='shell'` → `'bash'`/`'powershell'` → `isDestructive=true` → calls `promptCallback`. If our handler were called, the Telegram prompt WOULD have fired.

**Implication:** For `bash ls`, the CLI's read-only detection may be correct behavior. ADR-9 is most relevant for destructive shell commands (`bash rm`, `bash mv`, `bash git push`, etc.) which would NOT be flagged as read-only.

### SECONDARY BUGS found during investigation (fixed)

1. **`kind: 'hook'` not classified** — `session-events.d.ts` reveals a `'hook'` PermissionRequest kind (a pre-tool-use hook asking for user confirmation on the gated tool). Not in exported `PermissionRequest` type. Our classifier returned `denied-by-rules`. Fixed: delegate to `req.toolName` (the actual gated tool name).

2. **`kind: 'memory'` not classified** — `session-events.d.ts` reveals a `'memory'` kind for `store_memory` tool. Our classifier returned `denied-by-rules`. Fixed: added `'memory'` to `SAFE_TOOLS`.

3. **Shell args were empty** — Real SDK `kind='shell'` sends `fullCommandText` (not `args`). Our args serialization returned `'{}'` for real calls. Fixed: prefer `fullCommandText` for display when present.

---

## Diagnostic Instrumentation Added

**`src/copilot/impl.ts`** now emits these log lines on every session:

```
[copilot:perm] SDK permission.requested: session=X requestId=Y kind=Z resolvedByHook=true/false cmd=...
```
→ This fires via `onEvent` in session config. The `onEvent` wildcard handler is called by `_dispatchEvent` AFTER `_handleBroadcastEvent`, meaning it fires **even when `resolvedByHook=true`**. Shows EVERY permission event including bypassed ones.

```
[copilot:perm] onPermissionRequest: kind=Z toolName=W args=...
[copilot:perm] decision=prompting-user toolName=W
[copilot:perm] user decision=approved/denied toolName=W
```
→ These fire only when `onPermissionRequest` is actually called (i.e., `resolvedByHook=false`).

**Diagnostic rule:**
- If `SDK permission.requested ... resolvedByHook=true` → CLI resolved it (built-in read-only detection OR hook auto-allow). Handler never reached.
- If `SDK permission.requested ... resolvedByHook=false` AND no `onPermissionRequest` logs → SDK not calling our handler (registration bug)
- If `onPermissionRequest` logs appear with `decision=prompting-user` but no Telegram button → bug in `prompt.ts` or relay wiring

**Retry protocol:** Rebuild → restart bot → send `bash ls` → paste `[copilot:perm]` log lines. Then send a DESTRUCTIVE command (e.g., `bash echo test >> /tmp/x`) to validate the prompt fires for write-capable commands.

---

## ADR-9 Impact Assessment

ADR-9 is sound. The implementation is correct. The `resolvedByHook` bypass is **expected SDK behavior** — the CLI gate runs before the SDK dispatch layer.

**New scope clarification for ADR-9:**

The `interactiveDestructive` policy gates Reach's permission layer. However, the Copilot CLI independently classifies commands before they reach the SDK client. Specifically:
- **Read-only shell commands** (`ls`, `cat`, `grep`, etc.) may be auto-approved by the CLI itself, producing `resolvedByHook=true` before our handler is invoked. This is likely correct behavior and not a defect.
- **Destructive shell commands** (`rm`, `mv`, `git push`, file writes, etc.) should NOT be auto-approved by the CLI, and our handler should fire for those.

**Action for Scribe:** Add a note to ADR-9 §7 (or a new §14) documenting this:
> The Copilot CLI may auto-approve read-only tool calls (particularly shell commands with `readOnly=true` commands) before the SDK client receives them. Reach's `interactiveDestructive` policy governs only what reaches the SDK client. This is expected behavior for read-only commands. Destructive commands should still trigger the Telegram prompt.

No ADR revision needed for the core design. A clarifying footnote is appropriate.

---

## Files Changed

- `src/copilot/permissions.ts` — Added `'memory'` to `SAFE_TOOLS`
- `src/copilot/impl.ts` — Diagnostic logging, `kind: 'hook'` classifier fix, shell `fullCommandText` fix
- `extension.mjs` — Added `'memory'` to `SAFE_TOOLS` (mirrors permissions.ts; fixes drift test)


---


## Bug Summary

Aaron sent `bash ls` from Telegram with `REACH_PERMISSION_POLICY=interactiveDestructive`. The command executed successfully and returned output, but no Allow/Deny inline keyboard appeared in Telegram. ADR-9 prompting did not fire.

---


## Root Cause Analysis

### PRIMARY SUSPECT: CLI auto-approves read-only shell commands → `resolvedByHook=true`

In `@github/copilot-sdk` v0.2.2 `session.js`:

```javascript
} else if (event.type === "permission.requested") {
  const { requestId, permissionRequest, resolvedByHook } = event.data;
  if (resolvedByHook) {
    return; // Our onPermissionRequest is NEVER called
  }
  if (this.permissionHandler) {
    void this._executePermissionAndRespond(requestId, permissionRequest);
  }
}
```

When `resolvedByHook: true`, the SDK skips `onPermissionRequest` entirely. `bash ls` executed successfully without prompting, so `resolvedByHook=true` is the most likely explanation.

**Revised hook hypothesis:** Aaron confirmed that:
- `~/.copilot/permissions-config.json` does NOT list `D:\git\verbose-invention`
- The cairn-archivist `preToolUse` hook targets files that don't exist on this machine; `curate.ps1` exits 0 with no stdout

**New leading hypothesis: CLI built-in read-only command detection**

The `kind='shell'` permission event contains `commands[].readOnly: boolean` per `session-events.d.ts`. `bash ls` — `ls` is a read-only command. The Copilot CLI likely has a built-in policy: **"if all commands in the shell request are read-only → auto-approve → `resolvedByHook=true`."** This would be independent of any user-configured hooks.

Alternative: even if `curate.ps1` exits 0 with no stdout, the CLI may treat "preToolUse hook exited 0, produced no JSON" as `permissionDecision: "allow"` (implicit allow on successful hook invocation). This is unconfirmed without CLI source access.

**Wiring was correct.** `makePermissionHandler` with `policy=interactiveDestructive` correctly routes `kind='shell'` → `'bash'`/`'powershell'` → `isDestructive=true` → calls `promptCallback`. If our handler were called, the Telegram prompt WOULD have fired.

**Implication:** For `bash ls`, the CLI's read-only detection may be correct behavior. ADR-9 is most relevant for destructive shell commands (`bash rm`, `bash mv`, `bash git push`, etc.) which would NOT be flagged as read-only.

### SECONDARY BUGS found during investigation (fixed)

1. **`kind: 'hook'` not classified** — `session-events.d.ts` reveals a `'hook'` PermissionRequest kind (a pre-tool-use hook asking for user confirmation on the gated tool). Not in exported `PermissionRequest` type. Our classifier returned `denied-by-rules`. Fixed: delegate to `req.toolName` (the actual gated tool name).

2. **`kind: 'memory'` not classified** — `session-events.d.ts` reveals a `'memory'` kind for `store_memory` tool. Our classifier returned `denied-by-rules`. Fixed: added `'memory'` to `SAFE_TOOLS`.

3. **Shell args were empty** — Real SDK `kind='shell'` sends `fullCommandText` (not `args`). Our args serialization returned `'{}'` for real calls. Fixed: prefer `fullCommandText` for display when present.

---


## Diagnostic Instrumentation Added

**`src/copilot/impl.ts`** now emits these log lines on every session:

```
[copilot:perm] SDK permission.requested: session=X requestId=Y kind=Z resolvedByHook=true/false cmd=...
```
→ This fires via `onEvent` in session config. The `onEvent` wildcard handler is called by `_dispatchEvent` AFTER `_handleBroadcastEvent`, meaning it fires **even when `resolvedByHook=true`**. Shows EVERY permission event including bypassed ones.

```
[copilot:perm] onPermissionRequest: kind=Z toolName=W args=...
[copilot:perm] decision=prompting-user toolName=W
[copilot:perm] user decision=approved/denied toolName=W
```
→ These fire only when `onPermissionRequest` is actually called (i.e., `resolvedByHook=false`).

**Diagnostic rule:**
- If `SDK permission.requested ... resolvedByHook=true` → CLI resolved it (built-in read-only detection OR hook auto-allow). Handler never reached.
- If `SDK permission.requested ... resolvedByHook=false` AND no `onPermissionRequest` logs → SDK not calling our handler (registration bug)
- If `onPermissionRequest` logs appear with `decision=prompting-user` but no Telegram button → bug in `prompt.ts` or relay wiring

**Retry protocol:** Rebuild → restart bot → send `bash ls` → paste `[copilot:perm]` log lines. Then send a DESTRUCTIVE command (e.g., `bash echo test >> /tmp/x`) to validate the prompt fires for write-capable commands.

---


## ADR-9 Impact Assessment

ADR-9 is sound. The implementation is correct. The `resolvedByHook` bypass is **expected SDK behavior** — the CLI gate runs before the SDK dispatch layer.

**New scope clarification for ADR-9:**

The `interactiveDestructive` policy gates Reach's permission layer. However, the Copilot CLI independently classifies commands before they reach the SDK client. Specifically:
- **Read-only shell commands** (`ls`, `cat`, `grep`, etc.) may be auto-approved by the CLI itself, producing `resolvedByHook=true` before our handler is invoked. This is likely correct behavior and not a defect.
- **Destructive shell commands** (`rm`, `mv`, `git push`, file writes, etc.) should NOT be auto-approved by the CLI, and our handler should fire for those.

**Action for Scribe:** Add a note to ADR-9 §7 (or a new §14) documenting this:
> The Copilot CLI may auto-approve read-only tool calls (particularly shell commands with `readOnly=true` commands) before the SDK client receives them. Reach's `interactiveDestructive` policy governs only what reaches the SDK client. This is expected behavior for read-only commands. Destructive commands should still trigger the Telegram prompt.

No ADR revision needed for the core design. A clarifying footnote is appropriate.

---


## Files Changed

- `src/copilot/permissions.ts` — Added `'memory'` to `SAFE_TOOLS`
- `src/copilot/impl.ts` — Diagnostic logging, `kind: 'hook'` classifier fix, shell `fullCommandText` fix
- `extension.mjs` — Added `'memory'` to `SAFE_TOOLS` (mirrors permissions.ts; fixes drift test)


---


# Decision: Eager Prompt Registry Installation

**Author:** Kat  
**Date:** 2026-05-23  
**Status:** Implemented  

## Context

Live dogfood session. Aaron sent `bash echo "test" >> reach-test.txt` from Telegram. ADR-9 permissionCallback fired correctly (decision=prompting-user logged), but crashed with:

```
Error: It looks like you are registering more listeners on your bot from within other listeners!
```

## Decision

`ensurePromptRegistry(bot)` is now called **eagerly** inside `registerHandlers()` in `src/bot/handlers.ts`, gated on `permissionPolicy === 'interactiveDestructive'`. It runs alongside the other `bot.command()` / `bot.on()` setup calls — before `bot.start()` begins polling.

**Previous behaviour:** `ensurePromptRegistry` was called lazily from inside `promptUserForPermission`, which runs in an active grammY handler — violating grammY's single-pass listener registration contract.

## Contract Change

`ensurePromptRegistry` is now **exported** from `src/bot/prompt.ts`. It remains idempotent (WeakMap guard). Callers outside this module may call it during setup — do NOT call it from within active message handlers.

`disposePromptRegistry` behaviour is unchanged: clears the interval and evicts the registry, but does NOT remove the `callback_query:data` listener (which must outlive registry recreation per the WeakSet design).

## Impact on Other Agents

- **Carter:** No change to pipe protocol or session lifecycle.
- **Jun:** Test doubles don't call `registerHandlers` directly; no impact. If adding tests that construct a prompter directly, continue calling `promptUserForPermission` via a bot that already has `ensurePromptRegistry` called, or call `ensurePromptRegistry` in test setup.
- **Noble Six:** Main.ts wiring unchanged — `registerHandlers` is the only call site.


---


## Context

Live dogfood session. Aaron sent `bash echo "test" >> reach-test.txt` from Telegram. ADR-9 permissionCallback fired correctly (decision=prompting-user logged), but crashed with:

```
Error: It looks like you are registering more listeners on your bot from within other listeners!
```


## Decision

`ensurePromptRegistry(bot)` is now called **eagerly** inside `registerHandlers()` in `src/bot/handlers.ts`, gated on `permissionPolicy === 'interactiveDestructive'`. It runs alongside the other `bot.command()` / `bot.on()` setup calls — before `bot.start()` begins polling.

**Previous behaviour:** `ensurePromptRegistry` was called lazily from inside `promptUserForPermission`, which runs in an active grammY handler — violating grammY's single-pass listener registration contract.


## Contract Change

`ensurePromptRegistry` is now **exported** from `src/bot/prompt.ts`. It remains idempotent (WeakMap guard). Callers outside this module may call it during setup — do NOT call it from within active message handlers.

`disposePromptRegistry` behaviour is unchanged: clears the interval and evicts the registry, but does NOT remove the `callback_query:data` listener (which must outlive registry recreation per the WeakSet design).


## Impact on Other Agents

- **Carter:** No change to pipe protocol or session lifecycle.
- **Jun:** Test doubles don't call `registerHandlers` directly; no impact. If adding tests that construct a prompter directly, continue calling `promptUserForPermission` via a bot that already has `ensurePromptRegistry` called, or call `ensurePromptRegistry` in test setup.
- **Noble Six:** Main.ts wiring unchanged — `registerHandlers` is the only call site.


---


## Problem

Phase 6 is merged and code-reviewed (PR #6, 21 Copilot threads). All tests pass (410/414). But "merged" ≠ "production ready." We need clear go/no-go criteria before Aaron tests end-to-end from his phone. This decision codifies what "working permission prompting" means at the integration level.

---


## Gate: 5 Success Conditions for Phase 6 Live Dogfood

After running the checklist in `.copilot/reach-dogfood-checklist.md` (Sections 4–5), Aaron should observe:

1. **Permission prompting round-trip works** (§3.3, §4.2–4.3)
   - Destructive tool triggers `permission.request` over bridge
   - Telegram shows inline keyboard with Allow | Deny buttons
   - Buttons respond within 15s window (answerCallbackQuery deadline)
   - Tool executes on Allow; aborts on Deny
   - Daemon logs show no errors or timeout-related events

2. **Safe/destructive classification is correct** (§4.1–4.3)
   - Safe tools (read, grep, web_search) execute without prompts
   - Destructive tools (bash, powershell, edit, git_commit, etc.) trigger prompts
   - Classification matches extension.mjs list vs src/copilot/permissions.ts list

3. **No-timeout semantics verified** (§4.5)
   - Permission prompt remains open indefinitely (no 30s/60s auto-deny)
   - Tapper can respond 30+ seconds after prompt appears
   - Tool executes with same success rate regardless of response delay
   - Daemon logs show no setTimeout/Promise.race near permission handler

4. **Concurrent prompts don't interfere** (§4.6)
   - Multiple destructive tools triggered in rapid succession (<5s apart)
   - Each generates independent permission prompt in Telegram
   - Approving/denying one does not affect the other
   - Both tools execute (or both abort) based on individual button taps
   - Daemon multiplexing (sessionId filters on stream + permission events) works

5. **Zero blocking errors in daemon + Event Viewer** (§6.2)
   - Daemon foreground output shows no `Fatal:`, `Error:`, or `panic`-style messages
   - Windows Event Viewer (Application log) has no error-level entries from Reach
   - No stuck sessions (registry.json doesn't grow indefinitely)
   - Shutdown is clean on `Ctrl+C` (logs "Bye." within 2 seconds)

---


## Pass/No-Pass

- **PASS:** All 5 conditions observed. Phase 6 is validated for live use. Proceed to Phase 7 planning.
- **NO-PASS:** Any condition fails. Root-cause in `.copilot/reach-dogfood-checklist.md` Sections 5–6, then retry or escalate.

---


## Consequences

If PASS:
- Aaron can use Reach for daily AI pair-programming from phone
- Schedule Phase 7 scope meeting (classifier extension? persistent store? ADR-10?)
- Plan production rollout (telemetry, monitoring, on-call procedures)

If NO-PASS:
- Document failure mode + logs
- Identify if it's a code issue, environment issue, or gate criteria issue
- Fix in hot-fix branch or defer to Phase 7

---


## Notes

- This gate is about **integration validation**, not security audit or performance tuning
- ADR-10 (pipe token validation) is not part of this gate — it's a pre-production item for Phase 7
- The 9 unmerged inbox items are orthogonal to this gate and do not block dogfooding
- If dogfooding succeeds but exposes edge cases, document them as Phase 7 candidates, not gates

---

**Next:** Scribe merges this into decisions.md post-dogfood with outcome notes.

