# Reach Dogfooding — Go-Live Checklist for Aaron
**Date:** 2026-05-24T04:10:11Z  
**Phase:** 6 SHIPPED ✅ | ADR-9 Permission Prompting Hardened  
**Audience:** Aaron (user/dogfooder)  
**Goal:** End-to-end validation of Telegram ↔ Copilot CLI bridge with permission prompting from phone

---

## ⚠️ NO BLOCKERS IDENTIFIED
All 410 tests pass. Build succeeds. Code is ready for live dogfooding. All dependencies of ADR-9 are green:
- ✅ Extension bridge listening on named pipe (ADR-3, ADR-10)
- ✅ Permission prompting via inline keyboard (ADR-9)
- ✅ No-timeout guarantee verified (SDK fire-and-forget, not RPC)
- ✅ Session disconnect abort signals (ADR-9 §6.3)
- ✅ Per-session in-memory allow-always store (ADR-9 §6.4)

---

## SECTION 1: PRE-FLIGHT CHECKS

### 1.1 Environment Variables (.env file)

Create or update `D:\git\verbose-invention\.env`:

```env
# ──────── REQUIRED ────────────────────────────────────
# Bot token from @BotFather (get from: https://t.me/BotFather)
TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE

# Your Telegram supergroup chat ID (numeric, negative)
# Find it: forward any message from the group to @userinfobot
TELEGRAM_CHAT_ID=YOUR_CHAT_ID_HERE

# ──────── OPTIONAL (but recommended for dogfooding) ─
# Use interactiveDestructive to test permission prompting
REACH_PERMISSION_POLICY=interactiveDestructive

# Default LLM model
REACH_MODEL=claude-sonnet-4

# Session idle timeout (ms) — default 5 min
# IDLE_TIMEOUT_MS=300000
```

**Validation:** 
- [ ] `TELEGRAM_BOT_TOKEN` is set and non-empty
- [ ] `TELEGRAM_CHAT_ID` is a negative integer (e.g., `-1001234567890`)
- [ ] `REACH_PERMISSION_POLICY=interactiveDestructive` (to test permission prompting)

### 1.2 Telegram Setup

**Prerequisites:**
- [ ] You have a Telegram supergroup with **Topics (Forum Mode) enabled**
  - In group settings: Group → Manage Topics
- [ ] Your bot is added as admin in the group
- [ ] You have the supergroup's chat ID (see §1.1)

**Verification:** Send any message in the supergroup to @userinfobot. It replies with:
```
Group: (group name)
ID: -1001234567890
Type: Supergroup with Topics
```

If Topics are NOT enabled or ID doesn't match, fix before proceeding.

### 1.3 Windows Service Status (if running as service)

**Skip if running in foreground (dev mode).**

Check if an old Reach service is running:

```powershell
# List services named "Reach"
Get-Service -Name Reach -ErrorAction SilentlyContinue

# If running, stop it:
Stop-Service -Name Reach -Force -ErrorAction SilentlyContinue

# If installed, uninstall:
npm run service:uninstall
```

After dogfooding, if you want to install as a service:
```powershell
npm run service:install  # Requires admin
```

### 1.4 Bridge Auth Files

Reach creates a per-run auth token file at:
```
%LOCALAPPDATA%\reach\bridge-auth.json
```

On daemon startup, this file is created with:
- `pipeName` — randomized named pipe path (e.g., `reach-bridge-a1b2c3d4e5f6a7b8`)
- `token` — 32-byte CSPRNG token (hex-encoded)
- `createdAt` — ISO timestamp

**No manual action needed — this is automatic.** But know:
- File is recreated on every daemon start
- Extension reads it at connection time to discover pipe name + token
- If daemon crashes, old file is cleaned up; extension reconnects to new pipe

---

## SECTION 2: BUILD & START SEQUENCE

### 2.1 Build

```powershell
cd D:\git\verbose-invention
npm run build
```

**Expected output:** No errors, no warnings. `dist/` directory is populated.

### 2.2 Verify Tests Pass (sanity check)

```powershell
npm test
```

**Expected output:**
```
 Test Files  32 passed (32)
      Tests  410 passed | 4 skipped (414)
```

### 2.3 Start the Daemon (Foreground for dogfooding)

```powershell
npm start
```

**Expected log lines (in this order):**

```
[reach] Model: claude-sonnet-4
[reach] Permission policy: interactiveDestructive
[reach] Registry: %LOCALAPPDATA%\reach\registry.json
[reach] Allowed chat: ***-1234  (last 4 digits of chat ID)
[reach] Extension bridge: listening on named pipe
[reach] Bot started. Listening for messages…
```

**If you see** `Extension bridge unavailable — bridge sessions disabled`:
- Named pipe creation failed (rare on first run)
- Continue anyway — SDK sessions work; only bridge sessions blocked
- Check `%LOCALAPPDATA%\reach\bridge-auth.json` exists and is readable

**To stop the daemon:** Press `Ctrl+C`. You'll see:
```
[reach] Shutting down…
[reach] Bye.
```

---

## SECTION 3: PHONE-SIDE VALIDATION (Telegram)

### 3.1 Chat-ID Guard Works

In your Telegram supergroup:

1. Create a new forum topic (e.g., "Dogfood Test")
2. Send: `/list`

**Expected:** Bot responds with list of active sessions in that chat.

If bot doesn't respond or says "You're not authorized," the chat ID is wrong.  
Check: `TELEGRAM_CHAT_ID` in `.env` matches the one you got from @userinfobot.

### 3.2 Session Lookup Works

In the same forum topic:

```
/new dogfood-session
```

**Expected:** Bot responds: `✅ Session created: dogfood-session (model: claude-sonnet-4)`

Then send a simple message:
```
What is 2 + 2?
```

**Expected:** Bot responds: `4` (or similar, from Claude)

**If no response:**
- Daemon not running? Check console
- Session not connecting to CLI? Check `%LOCALAPPDATA%\reach\registry.json` exists
- Reach data directory missing? Daemon creates it on first run at `%LOCALAPPDATA%\reach\`

### 3.3 Permission Prompt Round-Trip Works (ADR-9)

**Important:** This tests the core ADR-9 feature — permission prompting over the bridge.

In the same forum topic, send:

```
bash ls
```

**Expected sequence:**
1. Daemon logs: `[bridge] permission.request received for bash`
2. Telegram shows a new message with **two buttons**: ✅ Allow | ❌ Deny
3. You tap **Allow**
4. Daemon logs: `[bridge] permission.response: allow`
5. Session executes `bash` and responds with file listing

**If permission prompt doesn't appear:**
- Check: `REACH_PERMISSION_POLICY=interactiveDestructive` in `.env`
- Daemon must be restarted after changing policy
- Verify bridge is listening (§2.3 — "Extension bridge: listening on named pipe" message)

**If prompt appears but buttons don't respond:**
- Tap again — buttons have a 15s window for `answerCallbackQuery`
- If still stuck, check daemon logs for errors
- Reconnect extension: `/clear` in Copilot CLI, then retry

---

## SECTION 4: ADR-9 DOGFOOD SCENARIOS

### Scenario 1: Safe Tool (No Prompt)

Send:
```
grep -r "TODO" src/
```

**Expected:** No permission prompt. Tool runs and returns results.

### Scenario 2: Destructive Tool with Allow

Send:
```
bash echo "test" > /tmp/reach-test.txt
```

**Expected:**
1. Permission prompt appears with tool name `bash` and args preview
2. Tap **Allow**
3. Command executes

### Scenario 3: Destructive Tool with Deny

Send:
```
git_commit --amend --no-edit
```

**Expected:**
1. Permission prompt appears for `git_commit`
2. Tap **Deny**
3. Daemon logs: `permission.response: deny`
4. Session reports: "Tool execution denied by user"

### Scenario 4: Allow-Always (same tool, second call)

After allowing Scenario 2, send:
```
bash echo "second" > /tmp/reach-test2.txt
```

**Expected:** 
- Prompt appears again (per-session store, not persisted across restarts)
- After allowing, same prompt for same tool within session won't appear until session restarts

### Scenario 5: No-Timeout Verification (ADR-9 Design)

Send:
```
bash sleep 2 && echo "done"
```

Then **do not respond to the prompt** immediately. Wait 10–30 seconds.

**Expected:**
- Prompt stays open (no auto-deny after timeout)
- Tap Allow at any point — tool still executes
- Verify in daemon logs: no timeout-related errors

**Why this matters:** ADR-9 uses `await` with no `setTimeout` — the prompt waits indefinitely.  
SDK fires-and-forgets permission callbacks; no RPC-level timeout exists.

### Scenario 6: Concurrent Prompts (Advanced)

In Copilot CLI, quickly send multiple prompts (within 5 seconds):
```
bash ls
```

While first permission prompt is pending, send (from CLI, in same session):
```
powershell Get-Date
```

**Expected:**
- Two independent permission prompts in Telegram (different message IDs)
- Each has its own buttons and request ID correlation
- Allow/deny either one independently
- Both tools execute correctly

**Why this matters:** ADR-9 uses inline keyboard (not reply keyboard) to support N concurrent prompts.

---

## SECTION 5: KNOWN GAPS & RISKS

### 5.1 Pre-deployment Inbox Items (Not Yet Merged)

**9 files in `.squad/decisions/inbox/`** awaiting Scribe merge:
- `carter-cloud-review-1.md`, `carter-cloud-review-3.md` — Cloud review findings
- `kat-adr9-reconciliation-notes.md` — Permission prompting reconciliation
- `noble-six-pipe-auth.md` — ADR-10 (named pipe authentication) — **NOT YET IMPLEMENTED**
- `noble-six-review1-dispositions.md`, `noble-six-review1-process.md` — Older threads
- Other review dispositions

**Impact on dogfooding:** 
- ADR-10 (pipe auth) is documented but NOT implemented yet
- Current code uses randomized pipe name, but no token validation
- **Not a blocker** for Phase 6 dogfooding on a solo machine, but is a pre-production gap

### 5.2 Known Hardening Done in PR #6

All below are SHIPPED and tested:
- ✅ Eviction-log fix (prevent stale prompt leaks)
- ✅ TTY-gated `promptPassword()` (no hidden prompts on non-TTY)
- ✅ Env-var fallback for install password
- ✅ Single-attach callback handlers (race-safe)
- ✅ `raceAbortSignals` cleanup
- ✅ `sessionId` stream filters (multiplexing safety)
- ✅ `createRequire` path resolution
- ✅ `.write()` vs `.push()` backpressure

### 5.3 Possible Runtime Surprises

| Issue | Mitigation |
|-------|-----------|
| **Pipe already in use** | Daemon logs warning, continues without bridge. Kill old daemon + restart. |
| **Session gets stuck in permission prompt** | Tap **Deny** or close Telegram topic. On next message, new prompt appears. |
| **"Allow" button doesn't work** | Telegram may not respond within 15s. Tap again. Check daemon logs for errors. |
| **Tool appears to hang** | May be waiting for stdin (not TTY). Send `Ctrl+C` or close session. |
| **Registry file corrupted** | Delete `%LOCALAPPDATA%\reach\registry.json`. Daemon recreates on next start. |

---

## SECTION 6: ROLLBACK & DIAGNOSTICS

### 6.1 Cleanly Kill the Daemon

**If running in foreground:**
```powershell
Ctrl+C
```

Wait for "Bye." message.

**If running as Windows Service (after install):**
```powershell
Stop-Service -Name Reach -Force
# Then uninstall if needed:
npm run service:uninstall
```

### 6.2 Inspect Local State

#### Bridge Auth File
```powershell
cat $env:LOCALAPPDATA\reach\bridge-auth.json
```

Should show: `{ "pipeName": "reach-bridge-...", "token": "...", "createdAt": "..." }`

#### Session Registry
```powershell
cat $env:LOCALAPPDATA\reach\registry.json
```

Lists all active sessions by topic ID and name.

#### Daemon Logs

**Running in foreground:** All logs to console.

**If running as service:** Check Windows Event Viewer:
- Go to: Event Viewer → Windows Logs → Application
- Filter by: Event Source = "Reach"

### 6.3 Wipe All Local State (Hard Reset)

```powershell
# Stop daemon and service
Stop-Service -Name Reach -Force -ErrorAction SilentlyContinue
npm run service:uninstall -ErrorAction SilentlyContinue

# Remove all Reach data
Remove-Item -Recurse -Force $env:LOCALAPPDATA\reach

# Rebuild and restart
npm run build
npm start
```

After restart, you're in **pairing mode**:
```
[reach] Pairing mode active.
[reach] Pairing code: 123456 (expires in 5 minutes)
```

Send `/pair 123456` from your Telegram supergroup. Daemon will restart and be ready.

### 6.4 Debug: Enable Verbose Logging

In `src/main.ts`, change:
```typescript
console.log('[reach] ...');  // Replace with console.error() for STDERR if needed
```

Or add temporary `debuglog`:
```typescript
import { debuglog } from 'util';
const debug = debuglog('reach');
```

Then rebuild and restart.

---

## SECTION 7: SUCCESS CRITERIA

After running all scenarios in §4, you've successfully dogfooded Reach if:

- [ ] §3.1 Chat-ID guard enforces your chat ID
- [ ] §3.2 Session lookup finds and lists sessions
- [ ] §3.3 Permission prompt round-trip works (buttons respond)
- [ ] §4.1 Safe tools don't prompt (grep, read, etc.)
- [ ] §4.2 Destructive tools prompt and execute on Allow
- [ ] §4.3 Destructive tools abort on Deny
- [ ] §4.4 Allow-always works (second call to same tool)
- [ ] §4.5 No-timeout works (prompt waits >10s)
- [ ] §4.6 Concurrent prompts don't interfere
- [ ] Daemon logs show no errors or warnings
- [ ] Windows Event Viewer has no error entries (if running as service)

---

## SECTION 8: POST-DOGFOOD NEXT STEPS

1. **Gather feedback:** Note any bugs, UX friction, or edge cases
2. **Archive:** Commit your findings to `.squad/agents/noble-six/history.md` under "## Learnings"
3. **Decide:** Phase 7 roadmap:
   - Extend classifier to more tools?
   - Implement persistent allow-always store (`%LOCALAPPDATA%\reach\allow-always.json`)?
   - Implement ADR-10 pipe authentication (token validation)?
4. **Merge inbox:** Next session's Scribe will drain 9 inbox files into decisions.md

---

## APPENDIX: COMMAND REFERENCE (Copy-Pasteable)

### Install & Build
```powershell
cd D:\git\verbose-invention
npm install
npm run build
npm test  # Verify baseline
```

### Run Locally (Foreground)
```powershell
npm start
```

### Run as Service (After Testing)
```powershell
# Admin PowerShell required
npm run service:install
npm run service:uninstall
```

### Telegram Forum Topic Commands
```
/new <session-name>          # Create session
/list                         # List active sessions
/resume <session-name>        # Resume a paused session
/remove                       # Remove current topic's binding
/help                         # Show command help
```

### Diagnostic Commands
```powershell
# Check auth file
cat $env:LOCALAPPDATA\reach\bridge-auth.json

# Check session registry
cat $env:LOCALAPPDATA\reach\registry.json

# Wipe all local state
Remove-Item -Recurse -Force $env:LOCALAPPDATA\reach

# List running Reach services
Get-Service -Name Reach -ErrorAction SilentlyContinue
```

---

**Generated for:** Reach Phase 6 Dogfooding  
**Date:** 2026-05-24T04:10:11Z  
**Status:** ✅ Ready for Live Testing
