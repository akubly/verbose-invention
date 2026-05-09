# Decisions Archive

**Last updated:** 2026-05-09

---
# Carter — Phase 6 Spike Report

**Date:** 2026-05-09  
**Author:** Carter  
**Status:** READY FOR REVIEW  
**Addresses:** Phase 6 locked design (decisions.md 2026-05-08), sections 4 and 5

---

## TL;DR

- **Q1 Discovery:** Use the SDK API (`listSessions()`). It works today, enumerates all sessions from the shared disk store, no user changes required. **Confidence: HIGH.**
- **Q2 Attach:** Blocked by a port-discovery gap. True bidirectional attach to a live desktop session requires the desktop CLI to run in `--ui-server` TCP mode — but no mechanism writes the port to disk. **Aaron needs to make a call here** (see Decision Point below).
- **MVP path:** `/list` via SDK API works. `/new` (Reach-owned subprocess) is fully bidirectional today. `/attach` to a running desktop session is the gap.

---

## Q1 — Discovery: How does Reach see live desktop CLI sessions?

**Answer: SDK API.** The SDK exposes `client.listSessions(filter?)` which returns `SessionMetadata[]`. This reads from the shared session store on disk (`~/.copilot/session-state/`). Reach's own SDK client — already running stdio-mode — can call this and get all sessions created by any CLI instance on the machine.

**What `listSessions()` returns:**
- `sessionId` — UUID, stable across restarts
- `startTime`, `modifiedTime` — for recency sorting
- `summary` — optional, user-visible description
- `isRemote` — distinguishes cloud sessions from local ones
- `context.cwd`, `context.gitRoot`, `context.repository`, `context.branch` — filtering hooks

**Filter support:** `SessionListFilter` lets Reach narrow by `cwd`, `gitRoot`, `repository`, or `branch`. The `/list` command can surface sessions filtered to the current repo.

**Live vs dead sessions:** `listSessions()` returns all sessions on disk — active and stale. The session workspace directory (`~/.copilot/session-state/{id}/`) contains an `inuse.{PID}.lock` file when a session is actively open in a CLI process. Reading this lock file lets Reach tag sessions as currently live vs historical. This is a filesystem read — no extra SDK surface needed.

**Verdict:** SDK API is the mechanism. No breadcrumbs needed for discovery. No IPC. Confidence HIGH based on inspecting the SDK's public `.d.ts` types and reading the actual `client.js` implementation.

---

## Q2 — Attach Semantics: What happens to the desktop TUI?

**Short answer: Shared output is technically possible — but blocked on port discovery.**

### What the SDK supports

The SDK has two operating modes:

| Mode | How | Attach semantics |
|------|-----|-----------------|
| **Stdio (default)** | Reach spawns its own CLI subprocess | Cannot attach to desktop — two separate processes on same session data. Creates conflict. |
| **TUI+server (`--ui-server`)** | Desktop CLI exposes TCP port; Reach connects via `cliUrl` | Shared: both desktop and Telegram see all output. `setForegroundSessionId()` lets Reach shift TUI focus. |

The `cliUrl` constructor option (`new CopilotClient({ cliUrl: "localhost:PORT" })`) is purpose-built for this. The `getForegroundSessionId()` / `setForegroundSessionId()` APIs let Reach know what the user is looking at in the TUI and redirect focus if needed. All session events flow to all connected clients — **shared output** is the natural semantic in `--ui-server` mode.

### The blocker

The desktop CLI must be started with `--ui-server`. No breadcrumb file is written to disk by the CLI when this mode is active. The SDK only discovers the port by parsing the CLI's stdout at spawn time (`listening on port (\d+)` pattern) — not usable for a process Reach didn't spawn.

**No port file exists today.** There is no `~/.copilot/server.json` or equivalent convention. The shared session state directory (`~/.copilot/session-state/`) contains `workspace.yaml` (cwd, branch, repo) and `inuse.{PID}.lock` (active PID) — but not port info.

### Three paths forward

| Path | Works today? | User effort | Semantics |
|------|-------------|-------------|-----------|
| **A: Config-based port** | Yes, after config wire | Aaron sets `REACH_CLI_SERVER_URL=localhost:PORT` in config.json; launches CLI with `--ui-server --port PORT` | Shared output |
| **B: Port breadcrumb convention** | After a wrapper script | A thin launch script writes `~/.copilot/reach-server.json` with `{ port, pid }`; Reach polls it | Shared output |
| **C: PID → port lookup** | Yes | None — reads `inuse.{PID}.lock`, queries `Get-NetTCPConnection` for that PID | Shared output (if found) |

Path A is the simplest for Phase 6 MVP: wire a new config key, document that Aaron starts the CLI with the matching `--ui-server --port` flag. Fragile on port mismatches but deterministic.

Path B is cleaner long-term but needs a wrapper that Aaron would have to adopt.

Path C is automatic but relies on `inuse.{PID}.lock` being present (requires an active infinite-session workspace, not guaranteed for all sessions) and `Get-NetTCPConnection` is Windows-only.

---

## Decision Point — Aaron's Call

**Choose one:**

1. **"Phase 6 MVP drops `/attach` to live sessions; only `/new` and `/list` ship."**
   → Cleanest MVP. `/list` enumerates sessions. `/new` spawns a fresh CLI subprocess owned by Reach (fully bidirectional). Users can't "pick up" a session they're running at the desktop and redirect it to phone — they create a new phone-side session instead. No port discovery needed.

2. **"Phase 6 MVP ships `/attach` with Path A (config-based port)."**
   → Wire `REACH_CLI_SERVER_URL` to `config.json`. User must start the desktop CLI with `--ui-server --port <same port>`. Reach connects via `cliUrl`. Shared output semantics. Requires Aaron to change how he launches the CLI at the desktop.

3. **"Phase 6 MVP ships `/attach` with Path C (PID → port auto-discovery)."**
   → Windows-only, fragile (relies on lock file presence + TCP table scan). Works without user config changes. Medium confidence.

**My recommendation: Option 1 for MVP, option 2 as a Phase 6 stretch item.** The `/list` + `/new` surface already satisfies Aaron's stated use case (he overwhelmingly resumes existing sessions). If `/attach` to a live desktop session matters, the config-based approach is a one-day add-on that Aaron can try after the core control plane ships.

---

## Fallback Plan

If SDK attach turns out to be broken (protocol mismatch, `--ui-server` not available in Aaron's CLI build):

1. **`/list`**: Fall back to reading `workspace.yaml` files directly from `~/.copilot/session-state/*/workspace.yaml`. Parse `id`, `cwd`, `repository`, `branch`, `updated_at` without any SDK call. Cross-reference `inuse.{PID}.lock` for live status.
2. **`/attach`**: Fall back to `/new` only. No true live attach. Document this in the bot's help text.
3. **Breadcrumb read**: If Aaron wants to experiment with port discovery, `~/.copilot/reach-server.json` is the convention to define. Reach would poll it on `/afk`.

---

## Concrete Next-Step File Changes (Days 3–5)

| File | Change |
|------|--------|
| `src/discovery/cliDiscovery.ts` | New. Calls `sdk.listSessions()`, cross-references `inuse.{PID}.lock` files to tag live vs stale. Returns `CliSession[]` with `{ sessionId, name, cwd, branch, isLive, pid? }`. |
| `src/control/session0.ts` | New. Owns mode state machine (desktop ↔ AFK). Routes `/afk`, `/back`, `/list`, `/attach`, `/new`, `/kill`. Calls `cliDiscovery` for `/list` and `/attach`. |
| `src/copilot/impl.ts` | Add `listSessions()` wrapper on `CopilotClientImpl`. Exposes `sdk.listSessions(filter?)` through `CopilotSessionFactory` interface. |
| `src/copilot/factory.ts` | Add `listSessions(filter?)` method to `CopilotSessionFactory` interface so the stub and impl stay aligned. |
| `src/sessions/registry.ts` | Semantics shift: track `{ topicId, cliSessionId, attachedAt, mode: 'live' \| 'resumed' }` rather than Reach-owned session names. Drop name-uniqueness enforcement. |
| `src/relay/relay.ts` | For `/new` path: same as today (Reach spawns subprocess). For `/attach` path (if option 2 chosen): swap `sdk` construction to use `cliUrl` from config. |
| `src/bot/handlers.ts` | Split routing: General topic → `session0.ts`; forum topics → data-plane relay. Desktop-mode gate rejects everything except `/afk`. |
| `config.json` schema | Add optional `REACH_CLI_SERVER_URL` key for Path A (option 2) attach. Add `REACH_MODE_DEFAULT` (`desktop` \| `afk`). |

---

## Open Risks

| Risk | Severity | Notes |
|------|----------|-------|
| **No `--ui-server` in Aaron's CLI build** | HIGH | If the bundled `@github/copilot` version doesn't support `--ui-server`, Path A/B/C all fail. Need to verify: `gh copilot --help \| grep ui-server`. |
| **Lock file reliability** | MEDIUM | `inuse.{PID}.lock` is written by the infinite-sessions feature. Sessions without infinite sessions enabled won't have it. Live detection would miss those sessions. |
| **Two-process conflict on resumeSession()** | HIGH | If Aaron `/attach`es to a session still open in the desktop CLI using Reach's own SDK process (not `cliUrl`), both processes write to the same session state. File corruption risk. `cliDiscovery.ts` must warn or block if `isLive=true` and we're in stdio mode. |
| **Windows-only Path C** | MEDIUM | `Get-NetTCPConnection` is PowerShell/Windows. Not portable if Reach ever runs on Linux. |
| **TUI mode assumption** | LOW | `setForegroundSessionId` / `getForegroundSessionId` only work in `--ui-server` mode. In stdio mode, these RPCs will error. `cliDiscovery.ts` must guard against this. |

---

## Confidence Summary

| Item | Confidence | Evidence |
|------|-----------|---------|
| `listSessions()` works for discovery | HIGH | Inspected `client.d.ts` types, `client.js` impl, README. API is real and documented. |
| Shared session store on disk | HIGH | `~/.copilot/session-state/` exists on Aaron's machine with UUID subdirs. `workspace.yaml` confirms cwd/branch/repo metadata. |
| `inuse.{PID}.lock` = active session signal | MEDIUM | Lock file present on machine. Semantics inferred from name — not confirmed by docs, but obvious. |
| `--ui-server` mode exists | MEDIUM | Documented in SDK README and `.d.ts` JSDoc. Not confirmed that Aaron's installed CLI version supports it. |
| Shared output semantics via `cliUrl` | MEDIUM | Follows from SDK architecture (single server process, multiple clients). Inferred — not tested end-to-end. |
| Port breadcrumb exists anywhere | LOW → NONE | No `server.json` or port file found anywhere in `~/.copilot/`. No SDK-written breadcrumb. |

---

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






---

# Carter — CLI Extension Bridge Follow-Up

**Date:** 2026-05-09  
**Author:** Carter  
**Status:** READY FOR REVIEW  
**Addresses:** Aaron's question — can a Copilot CLI extension replace `--ui-server` for session bridging?

---

## Short Answer

**Yes. The extension surface exists, is real, is in `@github/copilot-sdk@0.2.2`, and solves the port-discovery gap cleanly.** If Aaron wants `/attach`, this is the path. If `/attach` is out of scope for MVP, stick with the original spike recommendation (Option 1).

---

## What I Found

### 1. The Extension API Is Real

`@github/copilot-sdk@0.2.2` ships a documented, fully-typed extension entry point:

```ts
import { joinSession } from "@github/copilot-sdk/extension";
const session = await joinSession({ tools: [...], hooks: {...} });
```

Exported from the package's `./extension` subpath (declared in `package.json#exports`). The `.d.ts` and implementation are both present in the installed package. The docs (`node_modules/@github/copilot-sdk/docs/`) cover architecture, examples, and a full authoring guide.

### 2. How Extensions Work

```
┌───────────────────┐  JSON-RPC/stdio  ┌──────────────────────┐
│  Copilot CLI TUI  │ ◄──────────────► │  Extension process   │
│  (parent)         │                  │  (forked child)      │
│  • Forks ext      │                  │  • calls joinSession │
│  • routes tools   │                  │  • registers tools   │
│  • manages lcycle │                  │  • listens to events │
└───────────────────┘                  └──────────────────────┘
```

The extension is a **forked child process** — not a plugin loaded into the CLI's Node.js heap, but a separate process communicating over JSON-RPC via stdio to the CLI. `joinSession()` reads `SESSION_ID` from the env (set by CLI at fork time) and calls `client.resumeSession(sessionId, ...)` using `{ isChildProcess: true }`, which connects to the CLI parent via stdio.

### 3. What an Extension Can See and Do

| Capability | Available | Notes |
|-----------|-----------|-------|
| Read live session events | ✅ | `session.on("assistant.message", ...)`, `session.on("user.message", ...)`, `session.on("assistant.streaming_delta", ...)`, `session.on("session.idle", ...)`, all event types |
| Inject user input | ✅ | `session.send({ prompt: "..." })` — creates a new user turn, visible in TUI |
| Register slash commands | ✅ | via `tools` array |
| Async background code | ✅ | Extension is a regular Node.js process; long-lived awaits, timers, setInterval all work |
| Network / open sockets | ✅ | Full Node.js net access: `fetch()`, `net.createServer()`, named pipes, TCP |
| Hook user prompt | ✅ | `onUserPromptSubmitted` can read and modify every user message before the agent sees it |
| Hook tool execution | ✅ | `onPreToolUse`, `onPostToolUse` |
| Session lifecycle | ✅ | `onSessionStart` (fires on startup, resume, new), `onSessionEnd` |
| `sessionId` at runtime | ✅ | `process.env.SESSION_ID` set by CLI, and `invocation.sessionId` in handlers |
| `session.workspacePath` | ✅ | Path to `~/.copilot/session-state/<id>/` workspace |
| `console.log()` | ❌ | stdout is reserved for JSON-RPC; use `session.log()` instead |

### 4. Lifecycle

- **Discovery**: On CLI startup, scans `.github/extensions/` (git root, project-scoped) and `<copilot_config_dir>/extensions/` (user-scoped, all repos). Looks for `extension.mjs` inside each subdirectory.
- **Load timing**: Extensions load when the CLI starts AND each time `/clear` fires or the foreground session changes. Each reload forks a fresh extension process.
- **Lifecycle = foreground session lifecycle**: One extension process per foreground session. Daemon gets a fresh registration event on each session start; deregistration when the process terminates.
- **Shutdown**: CLI exit → SIGTERM → 5 second grace → SIGKILL. Extension connection to daemon drops; daemon marks session dead.
- **Entry point filename**: `extension.mjs` (`.mjs` only; `.cjs`/`.js` are in the source list but the scaffold tool always generates `.mjs`).

### 5. Discovery Shape With Extensions

Today (spike recommendation): daemon polls `listSessions()` + cross-references `inuse.{PID}.lock` files to determine live sessions.

With extension bridge:

```
CLI starts → extension forks
  → extension calls joinSession()
  → extension POSTs to Reach daemon named pipe / loopback HTTP:
      { sessionId, pid: process.pid, cwd: process.cwd() }
  → daemon adds session to live map
  → on extension SIGTERM: daemon removes from live map
```

This is **authoritative** live-session inventory — no lock file polling. The daemon knows in real time which sessions are alive and can bind the `sessionId` to a `pid` and `cwd` without disk reads.

### 6. Attach Shape With Extensions

```
Telegram /attach <session>
  → daemon looks up extension connection for sessionId
  → daemon sends "inject" over named pipe to extension
  → extension calls session.send({ prompt: "..." })
  → TUI shows user turn; CLI starts processing
  → extension streams events: session.on("assistant.streaming_delta", ...)
  → extension forwards deltas to daemon via same named pipe / HTTP
  → daemon → Relay → Telegram
```

No `--ui-server`, no port discovery, no port file. The extension is already in the CLI process's stdio tree. It receives and sends via the JSON-RPC session it holds from `joinSession()`. The daemon communicates with the extension via a named pipe or loopback socket that the extension opens at startup.

**Key caveat on UX**: `session.send()` inserts a message as a new user turn. The desktop TUI will show the Telegram-injected message as if the user typed it. That's visible and slightly awkward but functionally correct. This is identical to how the Copilot SDK's own test harness injects messages.

### 7. Extension Activation — User Friction

| Scope | Path | Who sets it up | Coverage |
|-------|------|----------------|----------|
| Project | `D:\git\verbose-invention\.github\extensions\reach\extension.mjs` | Aaron or Reach installer (once per repo) | Only sessions opened in this repo |
| User | `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs` | Aaron (once per machine) | ALL CLI sessions, any repo |

The user-scoped location covers everything — no per-repo setup. Reach's install flow (`src/service/install.ts`) could write the extension file to the user extensions dir as part of service installation. This would make it completely ambient after `reach install`.

### 8. SDK Version Bound

The `./extension` export is present in `@github/copilot-sdk@0.2.2` (the version Reach has). The `joinSession()` function, the typed hooks, the `session.send()` and `session.on()` APIs — all present and typed in the installed package. No upgrade needed.

---

## Side-by-Side Comparison

| | **Option A — Original Spike** | **Option B — Extension Bridge** |
|--|-------------------------------|--------------------------------|
| **Delivers** | `/list` + `/new`; no attach to desktop sessions | `/list` + `/new` + `/attach` to live desktop sessions |
| **Port discovery** | N/A (new sessions only) | N/A (extension sidestepped it entirely) |
| **User setup** | None | Install `reach` extension to user extensions dir once (automated in `reach install`) |
| **Discovery accuracy** | `listSessions()` + lock file cross-ref | Extension registers on startup — authoritative live map, no polling |
| **Attach semantics** | Not available | Bidirectional: inject via `session.send()`, receive via `session.on()` |
| **TUI impact** | None | Injected messages appear as user turns in TUI (visible to desktop user) |
| **Reload behavior** | N/A | Extension restarts on `/clear` — brief gap in daemon registration (reconnects in <1s) |
| **Effort (incremental)** | 0 | ~2 days on top of Option A |
| **Risk** | LOW | MEDIUM — new file plane, named pipe/HTTP channel, extension load failure handling |
| **File plan delta** | No new files for bridge | + `extension.mjs`, + `src/discovery/extensionBridge.ts`, + `src/bot/commands/attach.ts` |

**Effort breakdown for Option B add-on:**
- `extension.mjs` (register + stream events via named pipe): ~4 hours
- `extensionBridge.ts` (named pipe server in daemon, session map): ~4 hours  
- `/attach` Telegram command + relay wiring: ~4 hours
- Integration test + error handling (reconnect, timeout): ~4 hours
- Total add-on: **~2 days**

---

## My Recommendation

**If Aaron wants `/attach`: use Option B (extension bridge). The blocker is gone.**

The `--ui-server` port-discovery gap was the only thing standing between Reach and true bidirectional attach to a live desktop session. The extension surface solves it from the inside — no port files, no polling, no user changes to how they launch the CLI. The only setup cost is writing `extension.mjs` to the user extensions directory, which `reach install` can do automatically.

**If Aaron is happy with `/list` + `/new` for MVP**: stick with Option A. It's 2 fewer days, lower risk, and the UX works fine for creating phone-side sessions.

**Decision gate for Aaron:**

1. **"Option A: MVP ships `/list` + `/new` only."** → No change from spike recommendation. Cleanest MVP. Extension bridge deferred.

2. **"Option B: MVP ships `/list` + `/new` + `/attach` via extension bridge."** → ~2 day add-on. Full bidirectional attach to desktop sessions. Extension installed as part of `reach install`. 

My call if Aaron doesn't specify: **Option A for MVP, Option B as first post-MVP feature.** The extension approach is solid but adds implementation surface. Better to ship the core control plane cleanly first, then add the bridge as a tight follow-on.

---

## Risks (Option B)

| Risk | Severity | Mitigation |
|------|----------|------------|
| Extension fails to load (syntax error, crash) | MEDIUM | Daemon falls back to listSessions() polling; `/attach` degrades to "session not reachable" |
| Extension reconnection gap on `/clear` | LOW | Daemon tolerates brief deregistration; marks session as "reconnecting" for <2s |
| Named pipe access on Windows | LOW | Named pipes fully supported on Windows (`\\.\pipe\reach-<sessionId>`); tested pattern |
| TUI shows injected messages as user turns | LOW | Acceptable — matches how SDK test harness works; could prefix messages with "[Telegram]" |
| User extensions dir path varies by machine | LOW | Discoverable via `copilot settings` or `APPDATA` env; write once in `reach install` |
| Tool name collision with other extensions | LOW | Reach extension uses unique namespaced tool names (`reach_*`) |
