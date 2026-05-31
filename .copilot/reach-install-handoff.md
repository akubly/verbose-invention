# Reach Install Story — Handoff for Next Session

**Date:** 2026-05-29T22:22:08-07:00  
**Author:** Noble Six (Lead / Architect)  
**Context:** Aaron tried `/afk`; it doesn't work because `extension.mjs` was never installed to the Copilot extensions directory. Carter's audit confirmed the gap: daemon has an installer (`npm run service:install`), the extension has nothing.

---

## TL;DR for Next Session

**Immediate unblock (do this first, takes 30 min):**
1. Implement `src/install/copyExtension.ts` + `npm run install:extension`
2. Aaron runs it — `extension.mjs` lands at the right path, `/afk` works

**Full install story (rest of Phase 8.5):**
3. Implement `src/install/index.ts` — full orchestrated `npm run install`
4. Update README install section
5. Write tests for extension copy logic

---

## Decision Summary

| Dimension | Decision | Confidence |
|-----------|----------|------------|
| Distribution model | **Option C — one `reach install` command** | HIGH |
| Cross-platform | **Defer** — Windows-only for all of Phase 9 | HIGH |
| Extension upgrade path | **Copy on `npm run install:extension`** (idempotent re-run) | HIGH |
| Extension dev shortcut | **Symlink/junction for dev** — detect `NODE_ENV=development` | MEDIUM |
| Config wizard | **Interactive on first install** — write to `.env` | HIGH |
| Uninstall | **`npm run uninstall`** — service + extension, preserve config by default | MEDIUM |

---

## Why Option C (Trade-offs Named)

### Considered

**Option A — `npm install -g @reach/cli`**
- ✅ One command from anywhere
- ❌ Requires publishing to npm (premature for personal tool)
- ❌ postinstall scripts are banned by many registries and corporate policies
- ❌ npm global prefix detection is fragile on Windows (`%AppData%\npm`)
- ❌ Ungoverned admin elevation (postinstall runs without obvious privilege prompt)
- **VERDICT: Wrong distribution model for a git-clone daemon tool. Shelve.**

**Option B — Two separate scripts (`reach install-service` + `reach install-extension`)**
- ✅ Clear failure boundary — service install failure doesn't block extension
- ✅ Easier to run individually during upgrades
- ❌ Two-step onboarding increases "friction cliff" — users skip step 2
- ❌ No single "did it work?" gate
- **VERDICT: Useful as sub-commands exposed under Option C, not as the primary UX.**

**Option C — `npm run install` → single orchestrated command**
- ✅ One command, human-readable progress, fail-fast on first error
- ✅ Can call both sub-scripts internally (still gives you B's failure isolation)
- ✅ Natural place to put config wizard
- ✅ No packaging, no npm publish — runs from repo root
- ❌ Must be re-run after upgrades (acceptable for personal tool)
- **VERDICT: Right call for a personal developer daemon that lives in a git repo.**

**Option D — MSI installer**
- ✅ Best Windows-native UX (UAC prompt, Programs list, Add/Remove Programs)
- ❌ Enormous lift: WiX or Inno Setup, CI signing, auto-update channel
- ❌ No value until this is multi-user distributed software
- **VERDICT: Phase 12+ problem, if ever. Not relevant today.**

### Chose Option C because:
1. **Git clone is the distribution model.** Aaron clones, `npm install`, `npm run build`, `npm run install`. That's the full flow. No packaging required.
2. **Sub-tasks are composable.** Service install and extension install are still individual scripts under `src/install/`; the orchestrator just calls them in order. Option B's failure boundaries are preserved inside Option C.
3. **Config wizard fits naturally.** The first-run experience (token prompt, allowed-user-IDs warning) lives in the orchestrator, not scattered across two separate scripts.

### What this DOESN'T solve:
- Auto-update: user must `git pull && npm run build && npm run install` manually
- Non-TTY environments: service password prompt requires a TTY (already gated in existing code)
- Multi-machine: each machine needs its own clone + install (by design — personal daemon)
- Distribution to non-developers: this is never the goal

---

## Extension Install Mechanics (Design)

### Path Resolution

```
Windows: %APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs
```

The installer must:
1. Resolve `%APPDATA%` via `process.env.APPDATA`
2. Check `%APPDATA%\GitHub Copilot\User\extensions\` **exists** (Copilot CLI installed)
3. If not found: **fail loudly** — "GitHub Copilot CLI not detected. Install it first."
4. Create `reach\` subdirectory (may not exist on first install)
5. Copy `extension.mjs` from project root → target path

### Upgrade Path

Re-run `npm run install:extension`. The copy is unconditional (overwrites). Simple, deterministic, no version-check logic.

### Dev Shortcut (Dogfooding)

When `NODE_ENV=development`, create a **junction** (Windows symlink for dirs) instead of copying. This means pulling `extension.mjs` edits apply immediately without re-running the script.

Implementation: `fs.symlinkSync(src, dest, 'junction')` on Windows for the directory link. The extension file is directly in the repo root — the junction points the `reach\` dir at the repo root, then `extension.mjs` is referenced by filename. Actually, simpler: junction the `reach\` directory at the `(project root)` level, so Copilot CLI finds `extension.mjs` at the expected path via the junction.

**Aaron: ?** — Is the dev-symlink shortcut worth the complexity, or does re-running `npm run install:extension` feel fast enough for dogfooding? If the latter, skip the junction logic entirely.

---

## Daemon Install Mechanics (What's Already Done)

The existing `src/service/install.ts` (Phase 2) covers:
- ✅ `node-windows` service registration
- ✅ Running as logged-in user account (ADR-5)
- ✅ `.env` file parsing and env var embedding
- ✅ Password prompt (TTY-gated, `REACH_SERVICE_PASSWORD` env var fallback)
- ✅ `alreadyinstalled` event handling (idempotent)
- ✅ `npm run service:uninstall`

**What's missing:**
- ❌ `bridge-auth.json` — intentionally **not** an installer concern. ADR-10 says it is regenerated on every daemon start. The installer doesn't need to touch it.
- ❌ Config wizard — tokens and allowed-user-IDs currently require manual `.env` editing. The orchestrator (Task 2) adds an interactive prompt.

---

## First-Run Config Wizard (in orchestrator)

The `src/install/index.ts` orchestrator runs a lightweight wizard before service install:

```
[reach] Checking configuration…
[reach]   TELEGRAM_BOT_TOKEN  ✅  found in .env
[reach]   TELEGRAM_CHAT_ID    ⚠   missing (you can set it later via /pair command)
[reach]   Allowed user IDs    ⚠   not configured (daemon will fatal-exit until set)
[reach]
[reach] Tip: Set TELEGRAM_ALLOWED_USER_IDS=<your-telegram-id> in .env
[reach] Find your ID: message @userinfobot in Telegram, it replies with your numeric ID.
```

**Prompting behavior:**
- `TELEGRAM_BOT_TOKEN` missing → **prompt interactively** and write to `.env` (or fail if no TTY)
- `TELEGRAM_CHAT_ID` missing → **warn only** (pairing mode handles this at runtime)
- `TELEGRAM_ALLOWED_USER_IDS` missing or empty → **warn** (N2 guard will fatal-exit; give the user the fix command)
- Never write secrets to `config.json` — `.env` is the config surface

**Aaron: ?** — Should the wizard hard-block on missing `TELEGRAM_ALLOWED_USER_IDS`? You can't use the daemon without it (N2 guard), so a hard block might be friendlier than a cryptic fatal-exit message at runtime.

---

## Uninstall Design

`npm run uninstall` → `src/install/uninstall.ts`:
1. Stop and uninstall Windows service (reuse existing uninstall logic)
2. Delete `%APPDATA%\GitHub Copilot\User\extensions\reach\` directory
3. By default: **preserve** `%LOCALAPPDATA%\reach\` (config, session registry)
4. Print: "To wipe all Reach state: `Remove-Item -Recurse -Force $env:LOCALAPPDATA\reach`"

**Aaron: ?** — Should `npm run uninstall --wipe` exist to remove `%LOCALAPPDATA%\reach\` in one command? Or is manual PowerShell fine for a power-user tool?

---

## Implementation Tasks

### Task 1: Extension Copy Script (Owner: Carter)

**Priority: IMMEDIATE — unblocks dogfooding**

**Files to add/modify:**
- `src/install/copyExtension.ts` (new)
- `package.json` — add `"install:extension": "node dist/install/copyExtension.js"`

**What it does:**
```typescript
// src/install/copyExtension.ts
// 1. Resolve target path from APPDATA
// 2. Validate Copilot CLI installed (parent dir check)
// 3. mkdir -p reach/ subdirectory
// 4. Copy extension.mjs from project root to target
// 5. Print "[reach] Extension installed: <path>"
```

**Acceptance:**
- `npm run install:extension` runs without error on Aaron's machine
- `extension.mjs` appears at `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs`
- Re-running overwrites cleanly (idempotent)
- If Copilot CLI dir not found: exits with actionable error message
- `npm run build && npm run install:extension` → Aaron can try `/afk`

**Tests (Jun writes these in Task 3):**
- Happy path: target dir exists, copy succeeds
- Dir creation: `reach/` subdir does not exist → created
- Copilot CLI not found: exits non-zero with message
- Overwrite: existing file replaced without error

---

### Task 2: Full Install Orchestrator (Owner: Kat or Carter)

**Files to add/modify:**
- `src/install/index.ts` (new)
- `src/install/configWizard.ts` (new) — token prompts, `.env` write
- `package.json` — add `"install": "node dist/install/index.js"`, `"uninstall": "node dist/install/uninstall.js"`

**What `npm run install` does (in order):**
1. Check `dist/bin.js` exists (fail if not — "run npm run build first")
2. Run config wizard (`configWizard.ts`) — check/prompt for tokens
3. Run extension copy (`copyExtension.ts`)
4. Run service install (`service/install.ts` install function)
5. Print success summary with next steps

**What `npm run uninstall` does:**
1. Run service uninstall
2. Delete extension dir
3. Print state-preservation note

**Acceptance:**
- `npm run install` is idempotent (re-running on already-installed machine is safe)
- Each sub-step fails fast with actionable message
- Config wizard writes to `.env` if token is missing and TTY is available
- Warns but does not block on missing `TELEGRAM_ALLOWED_USER_IDS`

**Tests:** Integration-level smoke tests for orchestrator happy path and each failure mode.

---

### Task 3: Tests for copyExtension.ts (Owner: Jun)

**Files to add/modify:**
- `tests/unit/install/copyExtension.test.ts` (new)

**Test cases:**
1. Happy path — target dir exists, extension copied
2. First install — `reach/` subdir created, extension copied
3. Upgrade — existing extension file overwritten
4. Copilot CLI not installed — exits 1 with message containing "GitHub Copilot CLI not detected"
5. `APPDATA` not set — exits 1 with message
6. Source file (`extension.mjs`) not found — exits 1 with message

**Acceptance:**
- All 6 cases covered
- Mocked with `vi.mock('node:fs')` or a test filesystem helper
- No process.exit calls escape tests (spy/mock `process.exit`)

---

### Task 4: README Update (Owner: Scribe)

**Files to modify:**
- `README.md` — install section

**Changes:**
- Add step between "4. Build" and "5. Run" for extension install and service install
- Reference `npm run install` as the recommended one-command setup
- Add upgrade instructions: `git pull && npm run build && npm run install:extension`
- Clarify that `npm run service:install` and `npm run install:extension` remain available separately

**Acceptance:**
- README setup section is self-contained — user can follow it without referring to other docs
- Windows-only disclaimer is prominent

---

## Required npm Scripts (package.json additions)

```json
"install:extension": "node dist/install/copyExtension.js",
"install": "node dist/install/index.js",
"uninstall": "node dist/install/uninstall.js"
```

> ⚠️ Note: `"install"` is a reserved lifecycle event in npm (runs after `npm install`). Use `"setup"` instead if this causes issues: `"setup": "node dist/install/index.js"`. **Aaron: ?** — Prefer `npm run setup` to avoid npm lifecycle collision? Or is `npm run install` fine because it requires the explicit `run` invocation?

---

## Required Files

```
src/install/
  copyExtension.ts     ← Task 1 (Carter)
  configWizard.ts      ← Task 2 (Kat/Carter)
  index.ts             ← Task 2 (Kat/Carter)
  uninstall.ts         ← Task 2 (Kat/Carter)

tests/unit/install/
  copyExtension.test.ts   ← Task 3 (Jun)

README.md               ← Task 4 (Scribe)
package.json            ← Updated by Task 1 and Task 2
```

The existing `src/service/install.ts` is unchanged. The new orchestrator calls it by importing `install()` and `uninstall()` functions (already exported).

---

## Open Questions for Aaron

1. **Aaron: ?** — `npm run install` vs `npm run setup` — the former conflicts with npm's `install` lifecycle hook (though explicit `run` invocation avoids the issue). Which do you prefer?

2. **Aaron: ?** — Should the install wizard hard-block on missing `TELEGRAM_ALLOWED_USER_IDS`? Right now N2 will fatal-exit at daemon start, which is confusing. A hard block at install time would be friendlier but more opinionated.

3. **Aaron: ?** — Dev symlink vs copy for dogfooding. A junction from `%APPDATA%\GitHub Copilot\User\extensions\reach\` → repo root means `extension.mjs` edits apply immediately. Does that matter given `/afk` doesn't change the extension?

4. **Aaron: ?** — `npm run uninstall --wipe` flag (removes `%LOCALAPPDATA%\reach`), or is manual PowerShell fine?

5. **Aaron: ?** — Should the config wizard prompt for `TELEGRAM_ALLOWED_USER_IDS` (your Telegram numeric user ID)? Users can find it via @userinfobot. Prompting during install would prevent the N2 fatal-exit surprise.

---

## Phase 8.5 vs Phase 9?

**Recommendation: Phase 8.5** — a micro-sprint with a hard scope boundary.

**Why a separate mini-phase:**
- Task 1 alone (copyExtension.ts) unblocks Phase 8 dogfooding. Without it, Aaron cannot test `/afk` end-to-end.
- The full install story (Tasks 2–4) is ~1 session of work and has no design risk — it's pure plumbing.
- Phase 9 design decisions (persistent allow-always store, ADR-10 pipe auth, mirror rate limiter extraction) are higher-complexity and should start from a fully-dogfooded codebase.
- Shipping install story _before_ Phase 9 means dogfood findings inform Phase 9 scope.

**Phase 8.5 scope:**
- Tasks 1–4 above
- No new daemon features
- No ADR changes
- No Phase 9 features sneaking in

**Exit criteria for Phase 8.5:**
- [ ] Aaron runs `npm run build && npm run install:extension` → `/afk` works
- [ ] `npm run install` exists and is documented in README
- [ ] `npm run uninstall` exists and removes service + extension
- [ ] Tests pass (current baseline + Task 3 additions)

---

## Out of Scope (Explicitly)

The next session MUST NOT do these things:

- **Cross-platform support** — No macOS/Linux launchd/systemd. Windows-only for all of Phase 8.5 and Phase 9. Defer to future phase.
- **Auto-update** — No auto-pull, no version checking. Manual `git pull` is the upgrade path.
- **npm publish / package distribution** — This is a personal tool in a git repo. No packaging.
- **ADR changes** — Install story doesn't require new ADRs. It implements what ADR-10 already specifies for `bridge-auth.json` (which is already correct).
- **New daemon features** — No Phase 9 scope leaking in (persistent allow-always, rate limiter, ADR-10 pipe auth).
- **MSI installer** — Not now, not Phase 9.
- **Pairing mode refactor** — The current pairing mode UX is fine; don't touch it.
- **Config.json restructure** — The current `.env`-based config is adequate. No schema changes.

---

## Quick-Start for Next Session

```
Phase 8.5 kickoff sequence:
1. Read this file
2. Read src/service/install.ts (understand what already exists)
3. Start with Task 1 (Carter): src/install/copyExtension.ts
4. Aaron tests: npm run build && npm run install:extension && /afk
5. If green: Task 3 (Jun tests), Task 2 (orchestrator), Task 4 (README)
6. Exit criteria check → ship-to-pr
```
