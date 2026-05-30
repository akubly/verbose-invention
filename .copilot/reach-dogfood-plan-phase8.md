# Reach Dogfooding Plan — Phase 8 MVP + Hardening

**Date:** 2026-05-29T21:53:17-07:00  
**Phase:** 8 COMPLETE (P1 + watch sweep shipped 2026-05-27/28)  
**Audience:** Aaron Kubly (dogfooder)  
**Goal:** Validate `/afk`/`/back` MVP + stream routing hardening + config guards on daily machine before Phase 9 design

---

## Overview

Phase 8 ships **four production hardening items** built on Phase 6–7 foundation:

1. **Permission prompting (ADR-9):** Already validated Phase 6; re-test edge cases
2. **AFK mode (ADR-11):** New in Phase 7; comprehensive scenario matrix below
3. **Stream routing (F4 refactor + Cycle 3 fixes):** Extracted to `afkStreamRouter.ts`, multi-chunk edge cases handled
4. **Config guard (N2):** Empty allowed-user list now fatal-exits with actionable message

**Total scenarios: 16 high-risk behaviors across 4 areas. Target: ≥80% green before Phase 9.**

---

## SECTION 1: PREFLIGHT CHECKS

### 1.1 Environment Setup (Reuse from Phase 6)

Create or update `.env`:

```env
# ──── REQUIRED ─────────────────────────
TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE
TELEGRAM_CHAT_ID=-1001234567890

# ──── OPTIONAL (for testing) ───────────
REACH_PERMISSION_POLICY=interactiveDestructive
REACH_MODEL=claude-sonnet-4
```

**Validation checklist:**
- [ ] Bot token set and non-empty (get from @BotFather)
- [ ] Chat ID is negative integer (from @userinfobot forward)
- [ ] Supergroup has **Topics enabled** (Group → Manage Topics)
- [ ] Bot is admin in the supergroup

### 1.2 Build & Start

```powershell
cd D:\git\verbose-invention
npm run build
npm start
```

**Expected log lines (first 60 seconds):**
```
[reach] Model: claude-sonnet-4
[reach] Permission policy: interactiveDestructive
[reach] Registry: %LOCALAPPDATA%\reach\registry.json
[reach] Allowed chat: ***-1234
[reach] Extension bridge: listening on named pipe
[reach] Bot started. Listening for messages…
```

### 1.3 Sanity Smoke Test

In Telegram supergroup:
```
/help
```

**Expected:** Bot responds with command list (or similar acknowledgment). If no response, daemon not reachable — check logs.

---

## SECTION 2: SCENARIO MATRIX

### GROUP A: Permission Prompting (ADR-9)

**Context:** These scenarios validate the permission prompting round-trip over the extension bridge. Use `interactiveDestructive` policy.

#### A1: Single Allow-Once Destructive Command

**Setup:** Topic ready, session bound.

**Steps:**
1. Send: `bash ls /tmp`
2. Observe permission prompt in Telegram with ✅ Allow and ❌ Deny buttons
3. Tap **Allow**

**Expected:** Command executes; output appears in topic. Daemon logs no errors.

**Pass/fail:** ✅ PASS if output received; ❌ FAIL if prompt doesn't appear or buttons unresponsive.

---

#### A2: Allow-Always (Second Call)

**Setup:** Same topic, same session as A1 (or fresh session after A1).

**Steps:**
1. Send: `bash echo "second"` 
2. Observe new permission prompt
3. Tap **Allow** again

**Expected:** Second prompt appears (per-session store resets on daemon restart, so each session gets prompted once). Command executes.

**Pass/fail:** ✅ PASS if both prompts appear and both execute; ❌ FAIL if second prompt missing or doesn't execute.

---

#### A3: Deny (No Execution)

**Setup:** Fresh topic or new session.

**Steps:**
1. Send: `powershell Remove-Item /tmp/nonexistent.txt`
2. Observe permission prompt
3. Tap **Deny**

**Expected:** Daemon logs `permission.response: deny`. Session reports "denied" or "aborted". No file deletion attempted.

**Pass/fail:** ✅ PASS if execution blocked; ❌ FAIL if command runs despite deny.

---

#### A4: Concurrent Prompts (Two Tools, Same Session)

**Setup:** One topic, one active CLI session.

**Steps:**
1. In Telegram topic, rapidly type two commands (within 3 seconds):
   - `bash ls`
   - `powershell Get-Date`
2. Observe two separate permission prompts (different message IDs in Telegram)

**Expected:** Two independent prompts, each with own buttons. Allow/deny either one independently. Both tools execute in order.

**Pass/fail:** ✅ PASS if both prompts appear with independent buttons; ❌ FAIL if prompts clobber each other or only one appears.

---

#### A5: Prompt Timeout (No Auto-Deny)

**Setup:** One topic, permission prompt pending.

**Steps:**
1. Send: `bash sleep 1`
2. Observe permission prompt
3. **Do NOT tap Allow or Deny**. Wait 15+ seconds.
4. Tap **Allow** after the wait.

**Expected:** Prompt is still active. Tool executes after you tap Allow. No auto-deny after timeout.

**Pass/fail:** ✅ PASS if tool executes after 15s+ wait; ❌ FAIL if prompt auto-denies or becomes unresponsive.

---

### GROUP B: AFK Mode (ADR-11)

**Context:** `/afk` activates AFK fleet mode; `/back` deactivates. Topics auto-create on AFK activation.

#### B1: `/afk` Creates Topic (No Prior Sessions)

**Setup:** Fresh session, nothing active.

**Steps:**
1. In CLI, run: `/afk`
2. Observe Telegram supergroup

**Expected:** New topic appears (titled "Reach AFK" or similar). Banner message in topic: `📡 AFK mode active — 1 session. Ready for Telegram input.`

**Pass/fail:** ✅ PASS if topic created with banner; ❌ FAIL if topic missing or no banner.

---

#### B2: `/afk` Auto-Binds Active Session

**Setup:** CLI session already running (e.g., from prior scenario).

**Steps:**
1. In CLI, run: `/afk`
2. Observe Telegram

**Expected:** If session was already bound to a topic, that topic is reused. If unbound, new topic created. Banner updates to show session count.

**Pass/fail:** ✅ PASS if topic reused or created, banner correct; ❌ FAIL if wrong topic, duplicate topics, or no banner.

---

#### B3: New CLI Session Auto-Joins AFK Fleet

**Setup:** AFK mode active with 1+ topic(s).

**Steps:**
1. Open new CLI window, connect to same daemon
2. In new CLI, run: `/new my-session-2`
3. Observe Telegram

**Expected:** New session auto-joins the active AFK topic. Banner updates to show 2 sessions.

**Pass/fail:** ✅ PASS if new session appears in topic, banner count increases; ❌ FAIL if session not bound or count wrong.

---

#### B4: `/back` Closes Topic (Deactivates AFK)

**Setup:** AFK mode active, 1+ sessions bound.

**Steps:**
1. In CLI, run: `/back`
2. Observe Telegram

**Expected:** AFK topic closes. Banner: `🏠 Back to local — AFK mode off.` Sessions return to local CLI.

**Pass/fail:** ✅ PASS if topic closes, banner appears; ❌ FAIL if topic remains open or no banner.

---

#### B5: CLI Exit While in AFK

**Setup:** AFK mode active, session bound to topic.

**Steps:**
1. In CLI, run: `exit` or `Ctrl+D`
2. Observe Telegram topic

**Expected:** Topic closes with banner: `🏠 Session ended — AFK mode off.` No stray messages or errors.

**Pass/fail:** ✅ PASS if topic closes cleanly; ❌ FAIL if topic hangs or orphaned messages appear.

---

#### B6: `/clear` Command (Phase 8 Deferred)

**Setup:** AFK mode active.

**Steps:**
1. In CLI, run: `/clear`
2. Observe behavior (expected: deferred — should not break the pipe)

**Expected:** Pipe remains open. Command may be ignored or may clear SDK session state (implementation TBD). No crash or pipe corruption.

**Pass/fail:** ✅ PASS if pipe stable; ⚠️ AMBER if behavior unclear but no pipe break; ❌ FAIL if pipe closes or daemon crashes.

---

### GROUP C: Stream Routing & Hardening (Phase 8 Cycles 1–3)

**Context:** Long-running commands, multi-chunk output, truncation edge cases, transient failures, mid-stream deactivation.

#### C1: Long-Running Multi-Chunk Stream

**Setup:** AFK mode active, one topic.

**Steps:**
1. Send to Telegram: `bash for i in {1..100}; do echo "Line $i"; done`
2. Watch Telegram topic as output streams in

**Expected:** Messages appear gradually (not all at once). Multiple Telegram messages or single message edited repeatedly. Output does not appear truncated.

**Pass/fail:** ✅ PASS if streaming renders smoothly; ❌ FAIL if all text appears at once or stream freezes mid-output.

---

#### C2: Output Exceeding 4096 Chars (Truncation)

**Setup:** AFK mode active.

**Steps:**
1. Send: `bash python3 -c "print('x' * 5000)"`
2. Wait for output in Telegram

**Expected:** Message text capped at ~4000 chars. Suffix: `…(truncated)\n` followed by last N chars. No Telegram message-too-long error.

**Pass/fail:** ✅ PASS if truncated with marker; ❌ FAIL if truncation missing, marker absent, or Telegram rejects message.

---

#### C3: Empty Placeholder Edge Case

**Setup:** AFK mode active.

**Steps:**
1. Send: `bash sleep 0.5 && echo "delayed"`
2. Watch topic closely for first update

**Expected:** Even if first chunk arrives empty, placeholder `…` appears immediately (never blank message). Final output with "delayed" appears after 0.5s.

**Pass/fail:** ✅ PASS if `…` placeholder appears, then resolves to real output; ❌ FAIL if blank message or no placeholder.

---

#### C4: Transient sendMessage Failure (Simulate Airplane Mode)

**Setup:** AFK mode active, Telegram connection stable.

**Steps:**
1. Send: `bash sleep 2 && echo "test"` (long-running command)
2. While output is streaming, **toggle Airplane Mode** on phone (or kill network for 3–5 seconds)
3. Restore connectivity

**Expected:** Daemon detects send failure, retries once connectivity returns. Output eventually appears in topic. No missing chunks.

**Pass/fail:** ✅ PASS if output recovers after network restore; ⚠️ AMBER if one chunk lost but stream continues; ❌ FAIL if stream hangs or crashes.

---

#### C5: `/back` Mid-Stream (Error Frame Race)

**Setup:** AFK mode active, long-running command streaming.

**Steps:**
1. Send: `bash sleep 5 && echo "done"`
2. After 1–2 seconds (mid-stream), run: `/back`

**Expected:** Topic closes cleanly. No spurious "❌ Error" message after deactivation. Stream stops gracefully.

**Pass/fail:** ✅ PASS if clean close, no error frame; ❌ FAIL if error message leaks or topic corrupts.

---

#### C6: Fleet Under Load (N=20+ Sessions)

**Setup:** Advanced scenario — manually create 20+ unbound sessions before AFK.

**Steps:**
1. In daemon logs, verify 20 sessions exist (or use registry inspection)
2. Run: `/afk` with all 20 sessions
3. Watch Telegram as all 20 topics are created/bound
4. Send a command to one topic
5. Observe output routing

**Expected:** All 20 sessions bind without hang or 429 cascade. Output goes to correct topic. Banner shows 20 sessions. No timeouts.

**Pass/fail:** ✅ PASS if all 20 bind and output routes correctly; ⚠️ AMBER if one or two topics fail with 429 but others succeed; ❌ FAIL if hang, crash, or output misrouted.

---

### GROUP D: Configuration Guard (N2 — Phase 8)

**Context:** N2 guard prevents empty allowed-user list (security: deny-all bug).

#### D1: Empty Config Array (Fatal Exit)

**Setup:** Fresh start, `config.json` present with `telegramAllowedUserIds: []`.

**Steps:**
1. Kill daemon (if running)
2. Edit `config.json` to set: `telegramAllowedUserIds: []`
3. Run: `npm start`

**Expected:** Daemon immediately logs error:
```
[reach] Fatal: allowed user list is empty (env var TELEGRAM_ALLOWED_USER_IDS or config telegramAllowedUserIds resolved to size 0) — this would deny all users. Unset to allow all, or provide at least one ID.
```
Process exits with code 1. No bot starts.

**Pass/fail:** ✅ PASS if fatal message + exit 1; ❌ FAIL if daemon starts with empty list.

---

#### D2: Empty Env Var (Fatal Exit)

**Setup:** Fresh start, `TELEGRAM_ALLOWED_USER_IDS=` (empty) in `.env`.

**Steps:**
1. Kill daemon
2. Set `.env`: `TELEGRAM_ALLOWED_USER_IDS=` (empty string)
3. Run: `npm start`

**Expected:** Same fatal error + exit 1 (env var variant).

**Pass/fail:** ✅ PASS if fatal error + exit 1; ❌ FAIL if daemon starts or different error.

---

## SECTION 3: KNOWN GAPS & DEFERRED ITEMS

### Out of Scope (Phase 8 Dogfooding)

- **`/clear` command semantics** — Behavior deferred; pipe stability tested (§B6)
- **Resume-from-Telegram** — Not implemented; not tested
- **Spawn-from-Telegram** — Not implemented; not tested
- **Persistent allow-always store** — Currently in-memory; persisted store deferred to Phase 9+
- **Mirror rate limiter extraction** — Identified as next extractable (note in decisions.md); no code impact

### Watch Items (Dormant)

- **A2:** ERROR_CODES namespacing — P2; defer until first relay error code added
- **F8:** AuthorizationPort extraction — P2; defer until dynamic auth arrives
- **F5:** AfkBridgePort event expansion — P2; monitor event count
- **A10-4:** Fourth topic lifecycle operation — Future; defer until feature expands

---

## SECTION 4: ISSUE TRIAGE PROTOCOL

**If a scenario fails or exposes unexpected behavior:**

1. **Reproduce & document:**
   - Exact command sent, expected output, actual output
   - Daemon logs (copy full error messages)
   - Timestamp (use `CURRENT_DATETIME` above if same session)

2. **File issue in GitHub:**
   - Label: `squad` (required)
   - Title: "Dogfood finding: [area] [symptom]" (e.g., "Dogfood finding: AFK mode topic does not auto-bind")
   - Body: reproduction steps, logs, expected vs. actual

3. **Severity:**
   - **CRITICAL** (data loss, security): File immediately, halt dogfooding, notify via Slack
   - **HIGH** (command fails, stream broken): File immediately, continue other scenarios
   - **MEDIUM** (UX friction, edge case): Capture in single "dogfood findings" issue after session

4. **Lead triages to squad:**
   - Noble Six assigns to `squad:{member}` (Kat, Carter, Jun, or TBD)
   - Expected resolution: hot-fix in branch, re-test, merge before next phase

---

## SECTION 5: SUCCESS CRITERIA

**Phase 8 validated if all three hold:**

### 5.1 Preflight: All Green ✅

- [ ] §1.1 env vars set correctly
- [ ] §1.2 build succeeds, daemon starts cleanly
- [ ] §1.3 `/help` responds in Telegram

### 5.2 Scenario Matrix: ≥80% Green

- [ ] Permission prompting: ≥4/5 scenarios green (A1–A5)
- [ ] AFK mode: ≥5/6 scenarios green (B1–B6; B6 AMBER acceptable)
- [ ] Stream routing: ≥4/6 scenarios green (C1–C6)
- [ ] Config guard: 2/2 scenarios green (D1–D2)

**Target: ≥13/16 (81%).**

### 5.3 Severity: Zero Critical

- [ ] No data loss observed
- [ ] No security issues (pipe, auth, escalation)
- [ ] No daemon crashes or pipe corruption
- [ ] All HIGH issues filed and assigned before Phase 9 design

### 5.4 Optional: Design Notes

- [ ] Document any surprising behaviors or UX friction (even if not blockers)
- [ ] Capture architectural notes for Phase 9 (e.g., rate limiter extraction readiness)

---

## SECTION 6: TIME ESTIMATE & ROLLBACK

**Estimated time:** 45–90 minutes
- **Preflight:** 5–10 min
- **Scenario matrix:** 30–60 min (parallelizable: run A scenarios while streaming C scenarios)
- **Triage & documentation:** 5–15 min

**Rollback (if needed):**
```powershell
# Kill daemon
Ctrl+C

# Wipe all Reach state
Remove-Item -Recurse -Force $env:LOCALAPPDATA\reach

# Restart from fresh state
npm start
```

---

## SECTION 7: DIAGNOSTICS (Copy-Pasteable)

### Inspect Local State

```powershell
# Bridge auth file
cat $env:LOCALAPPDATA\reach\bridge-auth.json

# Session registry
cat $env:LOCALAPPDATA\reach\registry.json

# Daemon logs (if running foreground)
# All logs to console; Ctrl+C to stop
```

### Wipe & Restart

```powershell
Stop-Service -Name Reach -Force -ErrorAction SilentlyContinue
npm run service:uninstall -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:LOCALAPPDATA\reach
npm run build
npm start
```

---

**Generated for:** Reach Phase 8 Dogfooding  
**Date:** 2026-05-29T21:53:17-07:00  
**Status:** ✅ Ready for Live Testing
