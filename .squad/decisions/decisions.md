# Team Decisions

This document records architectural decisions, design choices, and recommendations that guide Reach development.

---

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
