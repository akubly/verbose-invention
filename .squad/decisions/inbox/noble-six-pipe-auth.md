# ADR-10: Named Pipe Authentication (Pipe ACL + Per-Install Token)

**Status:** PROPOSED  
**Author:** Noble Six (Lead / Architect)  
**Date:** 2026-05-22  
**Relates to:** ADR-3 (pipe), ADR-5 (daemon runs as logged-in user), ADR-8 (wire protocol)

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
