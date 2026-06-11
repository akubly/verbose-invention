# Teams Env Contract and TeamsChannel Stub Shape

**Author:** Carter (Bridge Dev)
**Date:** 2026-06-10
**Branch:** `user/aaron/phase2a` (commit: 1b4862a)
**Status:** IMPLEMENTED — locked contract for downstream agents (Jun P2a-6, Kat P2a-5)

---

## 1. TEAMS_* Environment Variable Contract (P2a-2)

All five vars are required when `REACH_CHANNEL=teams`. Validation fires in
`parseEnv()` conditional on `reachChannel === 'teams'`. Fail-fast with
`[reach] Fatal:` prefix + `process.exit(1)`, mirroring the Telegram block.

| Env var             | EnvConfig field      | Description                                               |
|---------------------|----------------------|-----------------------------------------------------------|
| `TEAMS_TENANT_ID`   | `teamsTenantId`      | Azure AD tenant ID (Directory ID in portal.azure.com)     |
| `TEAMS_CLIENT_ID`   | `teamsClientId`      | Azure AD application (client) ID                         |
| `TEAMS_CLIENT_SECRET` | `teamsClientSecret` | Azure AD client secret (Certificates & secrets)          |
| `TEAMS_TEAM_ID`     | `teamsTeamId`        | Teams team GUID — `{team-id}` in Graph API paths         |
| `TEAMS_CHANNEL_ID`  | `teamsChannelId`     | Channel ID within the team — `{channel-id}` in Graph API |

**Type declaration in `EnvConfig`:** `string | undefined` (required property, not `?` optional).
All five fields are present on every `EnvConfig` object; they are `undefined`
when the channel is not `teams`.

**Graph API path:** `POST /teams/{teamsTeamId}/channels/{teamsChannelId}/messages`

**OAuth2 flow:** Client-credentials (`/oauth2/v2.0/token` on
`https://login.microsoftonline.com/{teamsTenantId}`). Required permissions:
`Chat.ReadWrite`, `ChannelMessage.Send`, `ChannelMessage.Read.All`.

---

## 2. TeamsChannel Capability Flags (P2a-3)

| Flag                      | Value   | Rationale                                          |
|---------------------------|---------|----------------------------------------------------|
| `supportsMessageEdit`     | `false` | OD-1: no in-place edits for Teams v1               |
| `supportsThreadCreation`  | `false` | Pre-existing channels only; `createThread` OMITTED |
| `supportsInteractivePrompts` | `false` | Text-fallback in stub; Adaptive Cards in Phase 2b |
| `supportsStreaming`        | `false` | OD-2: accumulate full response, single send        |
| `maxMessageLength`         | `28000` | Teams channel message character limit              |

**`createThread` is NOT implemented.** Per the I4 optional-method contract
(noble-six-i4-createthread-optional.md), an adapter with
`supportsThreadCreation=false` MUST omit `createThread` entirely.

---

## 3. TeamsChannel Stubbed Method Signatures (P2a-3)

All methods implemented in `src/channel/teams/index.ts`:

```typescript
// Lifecycle
start(): Promise<void>
  → throws Error('[teams] not configured for live Graph')

stop(): Promise<void>
  → resolves (no-op)

// Outbound
sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef>
  → returns { id: String(++counter) }  // in-memory stub

editMessage(ctx: ChannelContext, ref: MessageRef, text: string): Promise<boolean>
  → returns false  // supportsMessageEdit=false

// Formatting
formatForTransport(markdown: string): string
  → returns markdown unchanged  // Phase 2b wires Kat's formatting module

splitMessage(text: string, footer?: string): string[]
  → character-boundary split at maxMessageLength (28000)

// Interactive prompts (text-fallback, supportsInteractivePrompts=false)
promptUser(
  ctx: ChannelContext,
  question: string,
  options: readonly PromptOption[],
  signal?: AbortSignal,
): Promise<string>
  → sends question + options as plain text, waits for matching inbound text or abort

// Inbound registration
onMessage(handler: MessageHandler): void
onCommand(command: string, handler: CommandHandler): void

// Internal (Phase 2b polling will call these)
protected dispatchInboundMessage(ctx: ChannelContext, text: string): Promise<void>
protected dispatchInboundCommand(command: string, ctx: ChannelContext, args: string): Promise<void>
```

---

## 4. Self-Registration Pattern

```typescript
// src/channel/teams/index.ts — module scope
registerChannel('teams', (cfg) => {
  if (!cfg.teamsTenantId || !cfg.teamsClientId || !cfg.teamsClientSecret) {
    throw new Error('[teams] TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET are required when REACH_CHANNEL=teams');
  }
  if (!cfg.teamsTeamId || !cfg.teamsChannelId) {
    throw new Error('[teams] TEAMS_TEAM_ID and TEAMS_CHANNEL_ID are required when REACH_CHANNEL=teams');
  }
  return new TeamsChannel();
});

// src/main.ts
import './channel/teams/index.js'; // side-effect: registers 'teams' channel factory
```

---

## 5. Conformance Compatibility (Jun P2a-6)

TeamsChannel passes `runChannelPortConformance(() => new TeamsChannel(), { name: 'teams', skipLifecycle: true })` because:
- `sendMessage` returns a valid `MessageRef` (no Graph call)
- `editMessage` returns `false` (a boolean — conformance accepts any boolean)
- `formatForTransport` returns a string
- `splitMessage` returns an array of strings each ≤ 28000 chars
- `capabilities` has all required fields as correct types
- `name` is `'teams'` (non-empty string)
- `supportsThreadCreation=false` → kit does NOT call `createThread`, only asserts the flag

---

## 6. Text-Fallback Prompt (Kat P2a-5)

Since `supportsInteractivePrompts=false`, `promptUser` uses a text fallback.
Kat's P2a-5 work may refine this. The internal dispatch path:
- `promptUser()` stores a `pendingTextPrompt` with the options
- `dispatchInboundMessage()` checks if inbound text matches an option value
  and resolves the pending prompt

When Phase 2b wires Adaptive Cards, `supportsInteractivePrompts` will be
set `true` and this fallback will be replaced.
