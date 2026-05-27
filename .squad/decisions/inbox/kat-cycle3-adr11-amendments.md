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

At the env-var layer, `TELEGRAM_ALLOWED_USER_IDS=""` (empty string after trim) is the misconfiguration signal and causes a fatal startup error. `TELEGRAM_ALLOWED_USER_IDS` unset is the documented allow-all entry point; the daemon must emit a loud startup warning that names the configured chat ID and states explicitly that all chat members can send AFK mirror input.

## D4 — ADR-11 Testing Seam: `AfkModeController.forTesting(seedDTO)`

`AfkModeController.forTesting(deps, seedDTO)` is the accepted test-only construction seam for seeded AFK state. The seed is a DTO, not raw internal Maps, and the factory rebuilds private controller state internally. The factory is protected by a runtime guard and throws unless `NODE_ENV === 'test'` or `VITEST === 'true'`.

## Amendment: D4/D5 Compensation Semantics (Cycle 6)

Original D4/D5 language ("compensation must terminate") was ambiguous about whether termination requires serialized queue dispatch or wall-time bounded execution.

**Clarification:** Compensation closes MAY run detached from the topic operation queue when:
1. The activation path serializes against any in-flight `activationPromise` (so a concurrent retry cannot race compensation).
2. Registry state (`lastTopicId`) is cleared on rollback so a retry's `ensureTopic` creates a fresh topicId rather than resurrecting one that an orphaned close might still target.
3. Each detached close is wall-time-bounded via `Promise.race` against a fixed timeout (currently `COMPENSATION_TIMEOUT_MS = 7000`).

**Rationale:** Detached compensation provides stronger latency guarantees than queued serialization (queue can be blocked indefinitely by in-flight ops), while the activationPromise hoist + lastTopicId hygiene together eliminate the resurrection race that queued serialization was implicitly relying on.

**Implementation:** `src/bot/afkMode.ts` — `activate()` activationPromise hoist + rollback `delete lastTopicId` (Cycle 6, commit landed by Kat).

**Note (Cycle 7):** The three conditions (activationPromise serialization, lastTopicId hygiene, COMPENSATION_TIMEOUT_MS cap) are jointly necessary — removing any one reopens a correctness vulnerability: either the resurrection race (conditions 1 and 2) or indefinite blocking (condition 3).
