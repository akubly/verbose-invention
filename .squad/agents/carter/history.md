# Carter — History (Summarized 2026-05-09)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery
- **Joined:** 2026-04-12

## Current Status

**Phase 5 complete.** Production-ready. 278 tests passing, tsc clean, lint clean.

**Phase 6 Spike (Days 1–2) complete:** Q1 SOLVED ✅, Q2 BLOCKED ⚠️. Aaron awaits decision gate on `/attach` scope.

---

## Phases 1–5: Key Accomplishments

**Phase 5 Wave 1: MarkdownV2** — Escape-only strategy (18 chars + backslash), code region protection, fallback chain. 22 tests GREEN.

**Phase 5 Wave 2: Message Splitting** — Telegram 4096-char limit, boundary preferences, code block re-fence, two-pass numbering. 21 tests GREEN.

**Phase 5 Review Fixes** — 11 persona findings addressed (F1–F13), 1 escalated (F7 port injection). ports.ts abstraction eliminates cross-layer imports.

**Phase 5 PR #5 Review Fixes** — 3 findings (MarkdownV2 budget, chunk cap, first-chunk failure). Chained discovery + fixes applied.

**Entry point fix** — Aligned package.json to compiled output (`dist/main.js`).

See `history-archive.md` for full Phases 1–5 documentation.

---

## Phase 6 Spike: Session Discovery & Attach Semantics

**Scope:** Answer Q1 (CLI discovery) and Q2 (attach semantics) from locked Phase 6 design.

### Q1 SOLVED ✅

**Discovery mechanism:** SDK `client.listSessions()` API.
- Returns `SessionMetadata[]` from shared disk store (`~/.copilot/session-state/`).
- Live vs dead: cross-reference `inuse.{PID}.lock` files.
- Filter support: `SessionListFilter` by cwd, gitRoot, repository, branch.
- **Confidence: HIGH.** No breadcrumbs needed. API is real, documented, and tested.

**Concrete path forward:**
- Implement `src/discovery/cliDiscovery.ts` — wraps `listSessions()` + lock file cross-reference.
- Returns `CliSession[]` with `{ sessionId, name, cwd, branch, isLive, pid? }`.

### Q2 BLOCKED ⚠️

**Attach semantics gap:** True bidirectional attach to live desktop session blocked on port discovery.

**What works in the SDK:**
- `--ui-server` mode: desktop CLI exposes TCP port
- `new CopilotClient({ cliUrl: "localhost:PORT" })` connects to server
- Shared output: both TUI and Telegram see all events
- `setForegroundSessionId()` lets Reach shift TUI focus

**What doesn't work:**
- No port breadcrumb file written by CLI (`~/.copilot/server.json` doesn't exist)
- SDK only discovers port by parsing CLI stdout at spawn time (not usable for existing process)

**Three paths forward:**

| Path | Effort | User friction | Semantics |
|------|--------|---------------|-----------|
| **A: Config-based port** | Low | Aaron must set config + CLI flag | Shared output |
| **B: Breadcrumb wrapper** | Medium | Needs adoption of wrapper | Shared output |
| **C: PID → port lookup** | Low | None | Shared output (Windows-only, fragile) |

**Recommendation:** MVP drops `/attach` to live sessions. Option 2 (config-based) as Phase 6 stretch item if Aaron prioritizes.

### Aaron's Decision Gate

**Choose one:**

1. **"Phase 6 MVP drops `/attach`; only `/new` and `/list` ship."**
   - Cleanest MVP. `/list` enumerates sessions. `/new` spawns fresh CLI subprocess (fully bidirectional). No port discovery needed.

2. **"Phase 6 MVP ships `/attach` with config-based port (Path A)."**
   - Wire `REACH_CLI_SERVER_URL` to config.json. User starts CLI with `--ui-server --port <PORT>`. Reach connects via `cliUrl`. Requires Aaron coordination.

3. **"Phase 6 MVP ships `/attach` with PID → port auto-discovery (Path C)."**
   - Windows-only, fragile (requires lock file + TCP scan). Works without config. Medium confidence.

**My recommendation:** Option 1 for MVP, Option 2 as stretch. The `/list` + `/new` surface satisfies Aaron's stated use case (resume-primary). If `/attach` matters, Option 2 is a one-day add-on post-core control plane.

---

## Next Steps

1. **Aaron decides:** Which option for `/attach` scope?
2. **Scribe updates:** `.squad/identity/now.md` with spike outcome
3. **Implementation begins:** Once scope is locked, Kat/Jun implement days 3–5

---

## Risk Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| No `--ui-server` in Aaron's CLI | HIGH | Test: `gh copilot --help \| grep ui-server` |
| Lock file reliability | MEDIUM | Document: live detection requires infinite-sessions enabled |
| Two-process conflict | HIGH | Guard in `cliDiscovery.ts`: warn/block attach to live in stdio mode |
| Port mismatch (Path A) | MEDIUM | Config validation at startup; document requirement |

---

## Phase 6 Follow-Up: CLI Extension Bridge (2026-05-09)

**Aaron's question:** Can a CLI extension replace `--ui-server` mode for session bridging?

**Answer: Yes.** `@github/copilot-sdk@0.2.2` ships a real, documented extension API at `@github/copilot-sdk/extension`. `joinSession()` connects the extension (a forked child process) to the current foreground CLI session via JSON-RPC over stdio.

**Key findings:**
- Extensions load from `.github/extensions/<name>/extension.mjs` (project) or `<copilot_config_dir>/extensions/<name>/extension.mjs` (user, all repos). Windows user path: `%APPDATA%\GitHub Copilot\User\extensions\`.
- Lifecycle = per foreground session (reloaded on `/clear`, stopped on CLI exit)
- `session.send()` injects user messages; `session.on()` observes all events including streaming deltas
- Full Node.js network access — extension can open named pipe / loopback HTTP to Reach daemon
- `SESSION_ID` env var available in extension process — authoritative session identity

**Impact on Phase 6 plan:**
- The port-discovery gap (Q2 BLOCKED) is now fully circumvented by the extension bridge
- Option B (extension bridge) enables true bidirectional `/attach` — ~2 days add-on to Option A
- `reach install` can write the extension to the user extensions dir automatically — zero ongoing friction
- Decision still at Aaron: Option A (clean MVP, no attach) or Option B (attach via extension)
- File plan delta: + `extension.mjs`, + `src/discovery/extensionBridge.ts`, + `src/bot/commands/attach.ts`

**What does NOT change:** `/list` (via `listSessions()`) and `/new` (Reach-owned subprocess) are unaffected. Extension bridge only adds the `/attach` path.

---

## Phase 6 Extension-Bridge Adoption (2026-05-19)

**Context:** Aaron requested architectural revision of Phase 6 post-spike results. Team sync held 2026-05-19.

**Outcome: ADOPTED.** Noble Six's revised Phase 6 proposal locked in extension-bridge as the Phase 6 MVP architecture, **not** as a stretch item. This resolves the Q2 attach-scope gate.

**What this means for Carter:**
- **Primary deliverable (Days 1–5):** Build `extensionBridge.ts` (named pipe server + session map), `extension.mjs` (CLI extension), and wire inject/stream protocol.
- **Secondary:** Refactor `relay.ts` to support bridge-attached relay path alongside existing SDK-session path.
- **Named pipe contract:** JSON-Lines encoding with method-based framing (hello, session.registered, inject, error, ping/pong). Single pipe: `\\.\pipe\reach-bridge`.
- **Division of labor:** Carter owns bridge plumbing; Kat builds `session0.ts` command surface + `/attach` handler; Jun writes contract + integration tests.
- **Sequencing:** Days 1–2 Carter builds core bridge + `extension.mjs`; Jun writes test doubles (`FakeDaemon`, `FakeExtensionClient`). Days 3–4 relay refactor. Day 5 integration.

**Blockers to resolve before implementation:**
1. Named pipe security model (pipe DACL for cross-integrity-level access)
2. Extension reconnect spec (does `extension.mjs` reconnect after daemon restart?)
3. Heartbeat requirement (ping/pong in protocol or rely on pipe teardown?)

**Risk focus:** EC-08 (extension crashes CLI when daemon absent) identified as highest-risk edge case. Extension MUST fail silent with `session.log()` error, not unhandled rejection.

---

## Key Design Patterns & Learnings

1. **SDK introspection methodology** — Version, types, README, implementation, actual filesystem state
2. **Escape-only strategy** — Covers 95% of output, avoids AST parsing brittleness
3. **Mid-stream fallback** — Plain text fallback for unclosed fences during streaming
4. **Port injection pattern** — Eliminate cross-layer coupling; relay is pure function of ports
5. **Shared session store discovery** — Filesystem-based, no IPC, scalable to N CLI instances

---

---

## Phase 6 Architecture LOCKED (2026-05-19)

**Event:** Phase 6 architecture finalized and locked for implementation.

**Seven ADRs accepted:**
- ADR-1: Copilot CLI Extension API for session attach
- ADR-2: Push-based discovery with `listSessions()` fallback
- ADR-3: Single named pipe, multiplexed by sessionId
- ADR-4: Extension crash = session unreachable (no auto-recovery)
- ADR-5: Daemon service account runs as logged-in user (fixes `LookupAccountName failed: 1332`)
- ADR-6: Extension reconnect policy using exponential backoff
- ADR-7: Heartbeat protocol using both pipe teardown + ping/pong

**Day 1 task for Carter:** Named pipe server skeleton (`src/bridge/extensionBridge.ts`) + extension handshake + `extension.mjs` skeleton. Can start immediately with no blocking data dependencies.

See `.squad/decisions.md` for full ADR documentation and orchestration log.

---

## Phase 6 Day 1: Bridge Implementation (2026-05-19)

**Deliverables shipped:**

1. **`src/bridge/extensionBridge.ts`** — Named-pipe server (daemon side).
   - Listens on `\\.\pipe\reach-bridge` (ADR-3 single pipe).
   - JSON-Lines protocol, 64 KB frame limit.
   - Map<sessionId, InternalConnection> for all registered sessions.
   - Full heartbeat: `ping` every 30 s, 5 s pong window, 15 s grace (ADR-7).
   - Fast-path disconnect via pipe `close` event (<1 s).
   - Typed event subscription via `BridgeEmitter` interface (composition, not extends).
   - Public API: `start()`, `stop()`, `getSession()`, `sendCommand()`, `on()`, `off()`.
   - `tsc --noEmit` ✅, `npm run lint` ✅.

2. **`extension.mjs`** — CLI extension skeleton (repo root; deployed by `reach install`).
   - Calls `joinSession()` from `@github/copilot-sdk/extension` (uses `SESSION_ID` env var).
   - Connects to daemon pipe, sends `register` on connect.
   - Exponential backoff reconnect: base 1 s, multiplier 2×, ceiling 300 s (ADR-6).
   - Ping/pong heartbeat — extension side (ADR-7).
   - `session.command` handler: stubs full relay; injects `session.send()` on SDK session.
   - `session.event` wiring: stubbed, awaiting relay refactor (Days 3–4).
   - Fail-silent per ADR-4: all errors caught and logged via `session.log()`.

3. **`.squad/decisions/inbox/carter-pipe-protocol.md`** — Canonical message schema for Jun.

**Learnings:**

- **TypeScript `no-unsafe-declaration-merging`:** The standard `declare interface Foo` + `class Foo extends EventEmitter` pattern triggers this eslint rule. Composition (`private _emitter = new EventEmitter()`) with typed method overloads is cleaner and lint-safe. Use this pattern for all future typed event emitters in this codebase.
- **Overload implementation signature must use `any[]`:** TypeScript requires the implementation signature of `on()` overloads to use `(...args: any[]) => void` (not `unknown[]`) to be compatible with specific listener signatures. This is standard; suppress with targeted eslint-disable.
- **`extension.mjs` is a source artifact, not a deployment artifact:** It lives at repo root and is copied to the user extensions dir by `reach install`. This keeps the extension discoverable in the repo while matching the SDK's lifecycle contract.

---

---

## Phase 6 Day 1: Protocol Reconciliation — ADR-8 Canonical Schema (2026-05-19)

**Team Update:**

Contract drift detected in parallel implementation (Carter vs. Jun). Noble Six reconciled via ADR-8:
- **Decision:** Adopt Jun's streaming protocol as canonical (`inject`/`stream`/`requestId`/`chunk`/`done`)
- **Rationale:** Streaming UX preservation (Phase 5 Telegram edit feature), request correlation, terminology consistency
- **Impact on Carter:** Day 2 migration required (~8 changes: rename message types, add `sessionId` to heartbeat, replace single-shot response with streaming)
- **Status:** ADR-8 locked in `decisions.md`. Day 2 migration task assigned.

See orchestration logs for full technical details.

---

## Archive

Full Phases 1–5 documentation in `history-archive.md`.
