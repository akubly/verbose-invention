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
