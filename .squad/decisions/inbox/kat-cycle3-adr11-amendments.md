# Kat Cycle 3 ADR-11 Amendments

## D1 — ADR-11 §4 Wire Protocol: `error` frame

Add a daemon-to-extension `error` frame:

```json
{ "type": "error", "sessionId": "abc-123", "error": "Not in AFK mode.", "code": "afk.not_active" }
```

Schema: `{ type: 'error', sessionId: string, error: string, code?: string }`. `code` values are advisory and non-breaking; well-known values are exported from `src/bridge/protocol.ts` as `ERROR_CODES`.

## D2 — ADR-11 Boundary: `AfkBridgePort`

`AfkModeController` depends on the narrow `AfkBridgePort` port, not the concrete bridge adapter. `ExtensionBridge` satisfies the port structurally and is wired at the composition root (`src/main.ts`). Tests provide adapters through `FakeBridge`/contract helpers so AFK mode can be exercised without a named-pipe server.

## D3 — ADR-11 Auth: `allowedUserIds` semantics

The chat ID guard always applies. `allowedUserIds: undefined` means allow all Telegram users inside the configured chat with no user-level gate. `allowedUserIds: Set([...ids])` enables a fail-closed user allowlist. `allowedUserIds: Set([])` is an explicit deny-all state and should be treated as a misconfiguration, not as unset.

## D4 — ADR-11 Testing Seam: `AfkModeController.forTesting(seedDTO)`

`AfkModeController.forTesting(deps, seedDTO)` is the accepted test-only construction seam for seeded AFK state. The seed is a DTO, not raw internal Maps, and the factory rebuilds private controller state internally. The factory is protected by a runtime guard and throws unless `NODE_ENV === 'test'` or `VITEST === 'true'`.
