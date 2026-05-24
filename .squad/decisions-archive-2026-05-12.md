# Decisions Archive

**Last updated:** 2026-05-19

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

# Carter — Phase 5 Review Fixes Decision Summary

**Date:** 2026-05-02  
**Author:** Carter (Bridge Dev)  
**Scope:** relay.ts, markdownV2.ts, messageSplitter.ts  
**Trigger:** 6-persona panel review of Phase 5 (MarkdownV2 escaping + message splitting)

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

# Kat — PR #5 Copilot Review Fixes Decision Summary (Copilot Review)

**Date:** 2026-05-03
**Author:** Kat (Bot Dev)
**Scope:** `src/bot/handlers.ts`, `src/sessions/registry.ts`
**Trigger:** Copilot code review on PR #5 — findings F-B and F-C

---

# Noble Six — Dogfood Readiness Verdict

**Date:** 2026-05-04  
**Author:** Noble Six (Lead/Architect)  
**Context:** Phases 1–5 complete. PR #5 merged (commit de4a196). No open issues.

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



## Phase 3 Architecture Designs

**Author:** Noble Six  
**Date:** 2026-04-20  
**Status:** Proposed (awaiting Aaron's approval)

This section covers architectural designs for the remaining P1/P2 features in Phase 3.

### 1. SDK Crash Auto-Recovery (P1)

#### Problem

Currently, `CopilotClientImpl` starts the SDK lazily via `ensureStarted()`. The startup promise is set to `null` on error, allowing retry. This handles pre-connection failures well.

However, the SDK manages a CLI subprocess. If that process dies mid-session, subsequent `session.send()` calls will fail. The current implementation has no mechanism to detect or recover from mid-session SDK crashes.

#### Options Considered

**Option A: Error-Triggered Restart with Backoff**

On any `send()` error (not timeout, but SDK connection/process errors):
1. Evict all cached sessions from the relay
2. Null out `startPromise` in `CopilotClientImpl`
3. Let the next message trigger a fresh `ensureStarted()` → SDK restart
4. Add exponential backoff to prevent restart loops

**Trade-offs:**
- ✅ Simple recovery model — treat every SDK error as "restart needed"
- ✅ No health checks or polling — reactive, not proactive
- ✅ Stateless — no crash detection state machine
- ❌ All sessions dropped on crash — users see "Creating new session..." on next message
- ❌ Brief downtime window between crash and next message

**Option B: Health Check Polling**

Poll `sdk.getSessionMetadata()` on a 30-second interval. If it throws, trigger restart.

**Trade-offs:**
- ✅ Proactive detection — no user message required to detect crash
- ❌ Adds polling overhead and complexity
- ❌ Still drops all sessions on restart (SDK doesn't expose "is alive?" API)
- ❌ Unclear if `getSessionMetadata()` is a reliable health signal

**Option C: Process Monitoring**

Monitor the SDK's CLI subprocess PID. If the process exits, restart.

**Trade-offs:**
- ✅ Immediate detection — no latency
- ❌ SDK doesn't expose the subprocess PID (internal implementation detail)
- ❌ Brittle — relies on SDK internals that may change

#### Recommendation: Option A (Error-Triggered Restart)

**Rationale:**
- **Reactive is sufficient.** Aaron is the only user. If the SDK crashes, he'll send a message within seconds. No need for proactive polling.
- **Simplicity wins.** No new state, no timers, no PID tracking. Just catch errors in the relay and evict sessions.
- **SDK session history survives.** Even though the in-memory `CopilotSession` handle is lost, the SDK persists session data to disk. When `resume()` is called after restart, the conversation history is intact. Users don't lose context.

**Implementation sketch:**

1. **Relay error handling** — in `relay.ts`, wrap `session.send()` in try/catch. On SDK errors (not timeout), call `relay.evict(topicId)` and re-throw. The eviction forces the next message to call `factory.resume() ?? factory.create()` again.

2. **CopilotClientImpl restart** — in `impl.ts`, on `ensureStarted()` failure, set `startPromise = null` so the next call retries. Already implemented.

3. **Exponential backoff** — add `lastRestartTime` and `restartCount` fields to `CopilotClientImpl`. If restarts happen <60s apart, increment `restartCount` and add `Math.min(2^restartCount, 60)` seconds delay before `sdk.start()`. Reset `restartCount` on successful 60s uptime.

4. **Error discrimination** — only restart on SDK connection/process errors. Timeouts and user-facing errors (permission denied, invalid input) should NOT trigger restart.

---

### 2. HUD Footer (P2)

#### Problem

The bot replies to Telegram messages with plain text or Markdown. Users have no visibility into which session or model they're talking to without running `/list`.

#### Available Data

From `SessionEntry`:
- `sessionName` (human-readable, e.g., `reach-myapp`)
- `topicId` (Telegram forum topic ID, e.g., `42`)
- `chatId` (Telegram chat ID, e.g., `-1001234567890`)
- `createdAt` (ISO timestamp)
- `model` (per-session override, optional, e.g., `claude-opus-4.5`)

From `CopilotClientImpl`:
- `this.model` (global default model from `REACH_MODEL` env var)

From `@github/copilot-sdk`:
- `sessionId` (string, matches `sessionName` since we pass it explicitly)
- Unknown: Does the SDK expose `repoPath` or `branch`? **Action: Check SDK types.**

#### Options Considered

**Option A: Session Name + Model Only**

Append a single-line footer to every final message:
```
📎 reach-myapp · claude-sonnet-4
```

**Trade-offs:**
- ✅ Minimal — no clutter
- ✅ Always available (session name and model are always known)
- ❌ No repo/branch info

**Option B: Full Context Footer (if SDK exposes repo/branch)**

If the SDK provides `repoPath` or `branch` metadata:
```
📎 reach-myapp · claude-sonnet-4 · D:\git\myapp · main
```

**Trade-offs:**
- ✅ Maximum context — users know exactly which repo/branch the session is in
- ❌ Longer footer — may feel cluttered on mobile
- ❌ Conditional on SDK API (may not be exposed)

**Option C: No Footer (status quo)**

Users run `/list` to see session metadata.

**Trade-offs:**
- ✅ Clean messages
- ❌ Poor UX — no at-a-glance context

#### Recommendation: Option A (Session Name + Model)

**Rationale:**
- **Always available.** No dependency on SDK internals.
- **Low noise.** One line of metadata is acceptable; more feels heavy.
- **Actionable.** Seeing the model name helps users remember if they're in a fast session (Haiku) or a deep-thought session (Opus).

**Implementation sketch:**

1. **Relay footer** — in `relay.ts`, after assembling the final response, append:
   ```typescript
   const footer = `\n\n📎 ${entry.sessionName} · ${entry.model ?? this.globalModel}`;
   await ctx.editMessageText(fullResponse + footer, { parse_mode: 'Markdown' });
   ```

2. **Global model access** — `Relay` needs access to the global default model. Pass it in the constructor:
   ```typescript
   constructor(
     private readonly registry: SessionRegistry,
     private readonly factory: CopilotSessionFactory,
     private readonly globalModel: string,
   ) { ... }
   ```

3. **Graceful fallback** — If `entry.model` is undefined, use `globalModel`.

**Open question:** Should the footer use Markdown? (Yes — emoji + monospace model name looks cleaner.)

---

### 3. Two-Tier Permissions (P2)

#### Problem

Currently, `CopilotClientImpl` uses `approveAll` for `onPermissionRequest`. This auto-approves all tool executions — file writes, command execution, API calls. Acceptable for a personal tool running on Aaron's machine, but risky if the daemon is ever exposed to untrusted inputs (e.g., shared Telegram group).

#### SDK Permission API

From `@github/copilot-sdk` types (need to verify):

```typescript
type PermissionHandler = (request: PermissionRequest) => Promise<PermissionResponse>;

interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  // Other fields TBD — check SDK docs
}

type PermissionResponse = 'approve' | 'deny';
```

**Action: Verify the exact shape of `PermissionRequest` and `PermissionResponse` from the SDK.**

#### Options Considered

**Option A: Two-Tier Handler with Telegram Prompt**

Replace `approveAll` with a custom handler:

1. **Auto-approve read-only tools:**
   - `view`, `grep`, `glob`, `list_files`, `read_*`, `get_*`, etc.
   - Return `'approve'` immediately.

2. **Prompt for destructive tools:**
   - `edit`, `create`, `powershell`, `bash`, `write_*`, `delete_*`, etc.
   - Send a Telegram message to Aaron: "Session `reach-myapp` wants to run `powershell rm -rf /`… Approve? (Reply /approve or /deny within 60s)"
   - Wait for response or timeout.
   - Return `'approve'` or `'deny'`.

**Trade-offs:**
- ✅ Security boundary — prevents unintended destructive ops
- ✅ User control — Aaron sees and approves risky actions
- ❌ Latency — every destructive tool adds 1-2 seconds (or 60s timeout)
- ❌ UX friction — interrupts flow, especially for batch edits

**Option B: Configurable Policy via Env Var**

Add `REACH_PERMISSION_POLICY` env var:
- `approveAll` (default, current behavior)
- `interactiveDestructive` (Option A behavior)
- `denyAll` (reject all tools — read-only session)

**Trade-offs:**
- ✅ Flexibility — Aaron can choose his risk tolerance
- ✅ Backward compat — default is current behavior
- ❌ Complexity — three modes instead of two

**Option C: Deny-List via Env Var**

Add `REACH_DENIED_TOOLS` env var (comma-separated list, e.g., `powershell,bash,edit`). Auto-approve everything else.

**Trade-offs:**
- ✅ Simple — one env var, explicit control
- ❌ Maintenance burden — deny-list must be updated as new tools are added
- ❌ No Telegram prompt — just deny, no approval flow

#### Recommendation: Option B (Configurable Policy)

**Rationale:**
- **Flexibility for future.** Aaron may want different policies for different deployment contexts (personal machine vs. shared machine).
- **Safe default.** Keep `approveAll` as default for v0.1 (Aaron is the only user, trusted environment). Add `interactiveDestructive` as opt-in for Phase 4 or later.
- **Gradual rollout.** Implement the policy switch now, implement Telegram prompts later.

**Implementation sketch:**

1. **Policy enum** — in `src/copilot/impl.ts`:
   ```typescript
   type PermissionPolicy = 'approveAll' | 'interactiveDestructive' | 'denyAll';
   ```

2. **CopilotClientImpl constructor** — accept `permissionPolicy` param (default `'approveAll'`):
   ```typescript
   constructor(
     private readonly model = 'claude-sonnet-4',
     private readonly permissionPolicy: PermissionPolicy = 'approveAll',
   ) { ... }
   ```

3. **Handler factory** — create `makePermissionHandler(policy)`:
   ```typescript
   function makePermissionHandler(policy: PermissionPolicy): PermissionHandler {
     if (policy === 'approveAll') return approveAll;
     if (policy === 'denyAll') return async () => 'deny';
     // interactiveDestructive implementation deferred to Phase 4
     throw new Error('interactiveDestructive not yet implemented');
   }
   ```

4. **Env var binding** — in `main.ts`:
   ```typescript
   const policy = (process.env.REACH_PERMISSION_POLICY || 'approveAll') as PermissionPolicy;
   const factory = new CopilotClientImpl(model, policy);
   ```

**Open question:** What's the exact SDK permission request shape? Need to check `@github/copilot-sdk` types to design the read-only vs. destructive classifier.

---

### 4. Pairing Codes (P2)

#### Problem

First-time setup requires proving that the user owns both:
1. The Telegram group (to send messages from)
2. The machine running Reach (to receive messages on)

Currently, this relies on manually setting `TELEGRAM_CHAT_ID` in the `.env` file. If the daemon is accidentally pointed at the wrong chat ID, it could respond to unintended messages.

#### Options Considered

**Option A: One-Time Pairing Code on Startup**

On daemon startup, if no `TELEGRAM_CHAT_ID` is set:
1. Generate a 6-digit random code (e.g., `831947`)
2. Print to console: `Reach pairing code: 831947 (expires in 5 minutes)`
3. User sends `/pair 831947` in their Telegram group
4. Daemon validates the code, stores the chat ID persistently to `%APPDATA%\reach\config.json`
5. Restart the daemon (or auto-reload config)

**Trade-offs:**
- ✅ Cryptographic proof — attacker can't guess the code in 5 minutes (6 digits = 1M possibilities)
- ✅ No manual env var editing — better UX
- ❌ Requires persistent config file (new `config.json` alongside `registry.json`)
- ❌ Requires daemon restart or config reload after pairing

**Option B: `/pair <bot-username>` Command**

User runs `/pair @reach_bot` in their Telegram group. Daemon sees the message, extracts the chat ID, persists it.

**Trade-offs:**
- ✅ Simpler — no random code, no expiration
- ❌ No proof of machine ownership — anyone who knows the bot username can pair
- ❌ Security risk if bot is public

**Option C: QR Code**

Daemon generates a QR code encoding the pairing URL: `tg://resolve?domain=reach_bot&start=pairing_code_123456`. User scans with phone, opens Telegram, confirms pairing.

**Trade-offs:**
- ✅ Excellent mobile UX
- ❌ Requires QR code library and terminal rendering (Windows Terminal supports it, but adds complexity)
- ❌ Overkill for a personal tool

**Option D: Keep `TELEGRAM_CHAT_ID` Env Var (Status Quo)**

Manual setup is acceptable for a personal tool.

**Trade-offs:**
- ✅ Simple — no new features
- ❌ Poor UX — requires finding the chat ID manually (via bots like `@userinfobot`)

#### Recommendation: Option A (One-Time Pairing Code)

**Rationale:**
- **Security.** Proves ownership of both machine and group without manual chat ID lookup.
- **UX.** Users don't need to find their chat ID or edit `.env` — just send `/pair <code>`.
- **Low complexity.** Pairing code logic is ~50 lines; persistent config file is ~30 lines. Total <100 LOC.

**Implementation sketch:**

1. **Config file** — `src/config/config.ts`:
   ```typescript
   interface ReachConfig {
     telegramChatId?: number;
   }
   // Load from %APPDATA%\reach\config.json
   // Save with atomic write (tmp + rename)
   ```

2. **Pairing code generation** — in `main.ts`:
   ```typescript
   if (!config.telegramChatId) {
     const code = Math.floor(100000 + Math.random() * 900000).toString();
     console.log(`Reach pairing code: ${code} (expires in 5 minutes)`);
     startPairingMode(bot, code, config);
     return; // Don't start normal handlers yet
   }
   ```

3. **`/pair` command handler** — in `src/bot/handlers.ts`:
   ```typescript
   bot.command('pair', async (ctx) => {
     const userCode = ctx.match?.trim();
     if (userCode === expectedCode && !isPairingExpired()) {
       config.telegramChatId = ctx.chat.id;
       await persistConfig(config);
       await ctx.reply('Pairing successful! Restart the daemon.');
       process.exit(0); // Trigger restart
     } else {
       await ctx.reply('Invalid or expired pairing code.');
     }
   });
   ```

4. **Backward compat** — If `TELEGRAM_CHAT_ID` env var is set, skip pairing mode (use env var). Allows users to opt out of the pairing flow.

**Open question:** Should the pairing code be alphanumeric or numeric-only? (Numeric is easier to type on mobile.)

---

## Summary

| Feature | Priority | Recommendation | LOC Estimate |
|---------|----------|----------------|--------------|
| SDK Crash Auto-Recovery | P1 | Error-triggered restart with backoff | ~40 |
| HUD Footer | P2 | Session name + model appended to replies | ~20 |
| Two-Tier Permissions | P2 | Configurable policy via env var (implement Telegram prompts in Phase 4) | ~30 |
| Pairing Codes | P2 | One-time 6-digit code on startup | ~100 |

**Total estimated LOC:** ~190 (excluding tests)

**Next steps:**
1. Verify SDK permission request shape and repo/branch metadata availability
2. Get Aaron's approval on recommendations
3. Assign implementation to team (Carter for relay changes, Kat for bot handlers, Noble Six for SDK bindings)

---

## Phase 6 Revised — Session 0 Control Plane + Extension Bridge

**Date:** 2026-05-19  
**Author:** Noble Six (Lead/Architect)  
**Status:** PROPOSED  
**Supersedes:** Phase 6 v2 LOCKED (2026-05-08) — Session 0 Control Plane + Data Plane Topics  
**Trigger:** Carter spike (2026-05-09) + extension-bridge follow-up (2026-05-09) changed the attach feasibility picture. Aaron requested architectural revision.

### 0. Decision: Extension-Bridge Is the Right Call

**Option 1 — Spike Recommendation (ship `/list` + `/new`, defer `/attach`):**
- Lowest risk. Ship a clean control plane with no new install surface.
- `/attach` deferred indefinitely — no known clean path without the extension.
- Reach remains a session *factory* from phone, never a session *viewport*.
- Aaron's session data says 80%+ of usage is resume-existing. A factory-only model misses the primary use case.

**Option 2 — Extension Bridge (`/list` + `/new` + `/attach` via CLI extension):**
- Delivers the core Phase 6 value prop: Reach becomes a remote viewport into live desktop sessions.
- Adds install surface: user-scoped `extension.mjs` deployed by `reach install`.
- Depends on `@github/copilot-sdk@0.2.2` extension API (`joinSession`, `session.send`, `session.on`).
- ~2 day incremental effort over Option 1.

### Trade-Off Analysis

| Dimension | Option 1 (defer) | Option 2 (extension bridge) |
|-----------|-------------------|----------------------------|
| **Install footprint** | Daemon only | Daemon + user-scoped extension file |
| **Upgrade story** | No SDK coupling beyond `listSessions` | Coupled to `./extension` subpath. If 0.3.x renames/removes `joinSession`, bridge breaks. |
| **Failure mode: extension crash** | N/A | Extension dies → daemon loses live registration for that session. Fallback to `listSessions()` poll. `/attach` degrades to "session unreachable." Daemon stays healthy. |
| **Failure mode: multi-install** | N/A | User-scoped extension dir is per-Windows-user. Multiple OS users = each needs own `reach install`. Same user, one extension — no collision. |
| **Security surface** | Daemon only (named pipe listener) | Extension has full Node.js + network in CLI's process tree. But it's *our* code running in *our* user's CLI — same trust boundary as the daemon itself. |
| **Delivers primary use case** | ❌ No attach to existing sessions | ✅ Bidirectional attach to live desktop sessions |
| **Effort** | Baseline | +2 days |

### Verdict

**Ship Option 2 (extension bridge) as the Phase 6 MVP.**

Rationale:
1. Aaron's 30-day session data shows resume-existing is the dominant pattern. A factory-only MVP (`/new` from phone) serves the minority use case.
2. The extension-bridge architecture is *structurally simpler* than any port-discovery alternative — no polling, no breadcrumb files, no config-based port coordination. The extension self-registers with the daemon on startup.
3. The SDK coupling risk is real but bounded: `joinSession()` is the *documented* extension entry point, not an internal. If it changes in 0.3.x, we pin 0.2.x until we adapt. The extension file is <100 lines — migration cost is low.
4. The incremental effort (~2 days) is small relative to the value delta (factory-only vs full viewport).

### 1. TL;DR

Reach is a remote I/O channel. Session 0 (General topic) is a command-only control plane with desktop/AFK modes. Data-plane topics pipe bidirectionally to live desktop CLI sessions via a Copilot CLI extension that self-registers with the daemon over a named pipe. Discovery is authoritative (extension push), not polled (lock files). `/attach` is the headline capability.

### 2. The Model

```
Reach Daemon (single host)
│
├── Session 0  ── General topic (permanent)
│   ├── Desktop mode (default): silent. Only accepts /afk.
│   └── AFK mode: /list, /attach, /new, /kill, /back
│
├── Extension Bridge (named pipe server)
│   ├── Accepts registrations from CLI extension instances
│   ├── Maintains authoritative live-session map
│   └── Routes inject/stream messages per session
│
└── Data-plane topics (on-demand)
    └── 1:1 mapping: topic ↔ attached CLI session
        ├── User messages → daemon → extension → session.send()
        └── session.on(events) → extension → daemon → topic
```

### Locked Design Decisions

| # | Decision | Status |
|---|----------|--------|
| 1 | Session 0 is command-only. No conversational AI. | CARRIED |
| 2 | 1 topic : 1 CLI process, enforced. | CARRIED |
| 3 | Data-plane topics created on-demand, not auto-created. | CARRIED |
| 4 | Session 0 lives in General topic. Mode state is daemon's. | CARRIED |
| 5 | Topic naming uses CLI's session name. Fallback: `{repo}-{branch}-{id4}`. | CARRIED |
| 6 | Extension-bridge is the attach mechanism. No `--ui-server`, no port files, no polling. | NEW |
| 7 | Extension is user-scoped (`%APPDATA%\GitHub Copilot\User\extensions\reach\`). Not per-repo. | NEW |
| 8 | Named pipe protocol between extension and daemon. Single pipe: `\\.\pipe\reach-bridge`. | NEW |
| 9 | Discovery is push-based (extension registers on startup). `listSessions()` is fallback only. | NEW |
| 10 | `/new` still spawns a CLI subprocess from the daemon. Extension bridge is for *existing* desktop sessions only. | NEW |

### New ADRs

- **ADR-1:** Use Copilot CLI extension API for session attach, not `--ui-server`, port files, or polling.
- **ADR-2:** Push-based discovery (extension registers on startup). `listSessions()` fallback for dormant sessions.
- **ADR-3:** Single named pipe, multiplexed by sessionId.
- **ADR-4:** Extension crash = session unreachable (no auto-recovery).

### Division of Labor

| Agent | Scope | Delta from LOCKED |
|-------|-------|-------------------|
| **Carter** | Build `extensionBridge.ts` (named pipe server + session map). Build `extension.mjs`. Wire inject/stream protocol. Refactor `relay.ts` for bridge-attached relay path. | **NEW:** Extension bridge is Carter's primary deliverable. |
| **Kat** | Build `session0.ts` command router. Bot routing changes: General-topic surface, mode gates, topic lifecycle. `/attach` command handler. Update `install.ts` for extension deployment. | **DELTA:** `/attach` command is new. Extension deployment is new. |
| **Jun** | Integration tests: mode transitions, attach/detach cycles, extension registration/deregistration, graceful degradation. Named pipe protocol tests. Windows-only CI matrix. | **DELTA:** Test surface expands ~93% (3.5→6.75 days). 10 new edge cases. |

### Open Questions (Require ADR Before Implementation)

1. **Named pipe protocol framing:** Line-delimited JSON or length-prefixed frames? **Rec:** Line-delimited JSON.
2. **Extension crash recovery:** Daemon marks session as unreachable or attempts re-fork? **Rec:** Option (a) — mark unreachable.
3. **Streaming delta batching:** Per-event or time-windowed? **Rec:** Time-windowed (100ms, same as relay).

---

## Kat — Phase 6 Bot-Side Impact Assessment

**Date:** 2026-05-19  
**Author:** Kat (Bot Dev)  
**Status:** ASSESSMENT — Awaiting Noble Six lock  

### What Changes for the Bot Side

**`/list`:** Cleaner, not harder. Direct read of `extensionBridge.getLiveSessions()` — no lock-file polling. One new edge case: sessions visible in `listSessions()` but extension not registered yet should show as `[starting…]`.

**`/attach`:** Meaningfully different mechanics, same UX surface. Daemon looks up registered extension connection, opens named pipe, establishes relay. New failure path: pipe write fails on attach attempt.

**`/new`:** No change. CLI subprocess auto-loads extension on startup.

**`/kill`:** Signal path changes. Sessions spawned by `/new` use SIGTERM path. Bridge-attached sessions send `shutdown` control message over named pipe. Registry needs `source: spawned | bridged` field.

### Topic Lifecycle

Unchanged: `/attach <session>` → mode gate check → topic create → relay bind. CLI exit → SIGTERM → pipe closes → daemon marks session dead. Bot receives `sessionDead(sessionId)` event, archives topic after 30-second grace.

### New Failure Modes

| F1 | Extension not installed | `"⚠️ Extension not installed — run \`reach install\` to enable /attach."` |
| F2 | Extension registered but not reporting in 30s | `"⚠️ Session '{{name}}' is stale — send a message to test or use /kill."` |
| F3 | Two CLI sessions with same name | Present disambiguation list with cwd + PID. Accept bare session-ID as second form. |
| F4 | Extension bridge connect failure on attach | `"❌ Could not attach to '{{name}}' — try closing and reopening the CLI."` Don't create zombie topic. |

### Concerns for Noble Six

- **C1:** Registry needs `source: spawned | bridged` field for `/kill` routing.
- **C2:** Aaron's Option A vs. Option B decision needed before finalizing command surface.
- **C3:** Zombie topic risk if `extensionBridge.attach()` fails after topic creation.
- **C4:** `[starting…]` state needs registry representation or fallback handling.
- **C5:** Named pipe path convention needs locking before Carter implements.

### Effort Delta

**Approximately a wash.** `/list` simplification offsets `/kill` dual-path and failure-mode UX. Net: +0.5 days for error handling polish.


## Jun — Phase 6 Test Impact Assessment

**Date:** 2026-05-19T21:49:56-07:00  
**Author:** Jun (Test Engineer)  
**Status:** READY FOR REVIEW  

### Executive Summary

Extension-bridge expands test surface from one process boundary (bot ↔ daemon) to three (Telegram ↔ daemon, daemon ↔ extension, extension ↔ CLI). Named pipe protocol adds contract layer. Net: **scope grows ~93% (3.5→6.75 days).**

### Testability Triage

**Unit-testable:** Daemon bridge handlers (mocked pipe), session map CRUD, mode state machine, extension disconnect detection.

**Contract-testable:** Named pipe message parsing, schema validation, version negotiation.

**Integration-testable (CI-able):** Pipe server + fake extension client, extension absent, abrupt disconnect, concurrent registrations, race conditions.

**Requires live CLI (manual):** `joinSession()` happy path, `session.send()` + streaming, full `/attach` end-to-end.

### 10 New Edge Cases

| EC-01 | `joinSession()` fails at startup | Extension logs error, doesn't open pipe, fails silent. |
| EC-02 | Daemon restarts mid-session | Extension reconnects with backoff. Needs impl spec. |
| EC-03 | CLI killed abruptly (SIGKILL, OOM) | Daemon detects dead pipe within 5s. Requires heartbeat timeout. |
| EC-04 | Two daemon instances running | Second `CreateNamedPipe()` fails; second daemon exits. |
| EC-05 | Protocol version mismatch | Handshake rejects with `version_mismatch` error. Extension logs; user sees "run reach install." |
| EC-06 | CLI Admin, daemon LocalSystem | Pipe DACL must grant cross-integrity access. **BLOCKER** — manual test. |
| EC-07 | 10+ concurrent CLI sessions | Daemon handles concurrent connections without data interleaving. |
| EC-08 | Extension installed, daemon not running | Extension catches `ENOENT`, logs silent, CLI continues. **HIGHEST RISK.** |
| EC-09 | Race: `/attach` arrives as extension disconnects | Daemon fires disconnect event; handler finds no extension; returns clean error. |
| EC-10 | Extension deltas faster than relay can forward | Back-pressure: daemon buffers or drops under load. |

### Named Pipe Protocol Schema (Required Before Implementation)

```typescript
interface PipeMessage {
  method: string;
  id?: string;
  params?: unknown;
}

// Extension → Daemon: hello, session.disconnect, assistant.delta, tool.use
// Daemon → Extension: session.registered, inject, error

// Framing: UTF-8 JSON, \n delimited
// Max message: 64 KB per line
// Heartbeat: ping/pong every 30 seconds
```

### CI Implications

**Can run in CI:** Unit + contract + integration tests on `windows-latest` runner. 10 new edge cases covered via mocked pipe or integration harness.

**Cannot run in CI:** Full attach E2E (needs real CLI), EC-06 (needs elevated context).

**New requirement:** Windows-only CI matrix. Named pipe is Windows-specific. Tests must clean up pipe names (`\\.\pipe\reach-test-{randomSuffix}`) to avoid collisions between parallel workers.

### Effort Delta

| Area | Original | Extension-Bridge | New |
|------|----------|------------------|-----|
| Mode transitions | 1 day | 1 day | — |
| EC-08: Extension fails silent | — | 0.5 day | **New** |
| Contract tests: pipe protocol | — | 1 day | **New** |
| Daemon unit tests (EC-03, -04, -07, -09) | — | 1.5 days | **New** |
| Extension unit tests (EC-01, -02, -05) | — | 1 day | **New** |
| CI matrix setup | — | 0.5 day | **New** |
| Load test (EC-10) | — | 0.5 day | **New** |
| Manual checklist | — | 0.25 day | **New** |
| Skeleton work | 1 day | 0.5 day | -0.5 day |
| **Total** | **3.5 days** | **6.75 days** | **+3.25 days** |

### Blockers for Noble Six

1. **Named pipe security (HIGH):** Node `net.createServer()` uses default descriptor (owner-only). If daemon is LocalSystem and CLI is user/admin, extension fails silently. Need `\\.\pipe\LOCAL\` or explicit DACL before implementation.
2. **Extension reconnect spec:** Does `extension.mjs` reconnect after daemon restart? Retry policy? Needed for EC-02 tests.
3. **Heartbeat requirement:** Is ping/pong in the protocol, or rely on pipe teardown events? Affects EC-03 timing determinism.
4. **SDK testability:** Can `joinSession()`, `session.send()`, `session.on()` be mocked or do they require live CLI? Affects extension unit test feasibility.
5. **Test doubles (immediate):** Need `FakeDaemon` and `FakeExtensionClient` test helpers on Days 1–2 before implementation.
6. **CI matrix:** Full test suite must pass on Windows before named-pipe tests are added.

---

**Decision inbox merged and deduplicated. All three assessments (Noble Six's Phase 6 revised, Kat's bot-side impact, Jun's test impact) now consolidated in decisions.md.**



---
