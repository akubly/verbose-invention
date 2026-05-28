# Fleet Simulation Skill

Pattern for testing bulk-operation correctness (parallel dispatch, compensation,
and per-call retry) at fleet scale (N > 15) using the project's existing
`AfkContractDriver` harness.

---

## When to Use

- You need to verify that a `Promise.all`-based bulk operation handles N > 15
  items without leaks, duplicates, or runaway retries.
- You need to simulate 429 retry pressure across a large concurrent dispatch.
- The trigger condition in a watch item has fired (e.g. A6-6: N > 15 sessions).

---

## Core Pattern

### 1. Build a fleet harness

```ts
async function makeFleetHarness(fleetSize = 20) {
  const sessionDefs = Array.from({ length: fleetSize }, (_, i) => ({
    sessionId: `fleet-${i + 1}`,
    sessionName: `reach-fleet-${String(i + 1).padStart(2, '0')}`,
  }));

  const daemon = new FakeDaemon();
  const clients = sessionDefs.map(({ sessionId, sessionName }) =>
    new FakeExtensionClient(sessionId, sessionName),
  );
  for (const client of clients) {
    client.connect(daemon);
    client.sendHello();
  }
  await flush(); // drain readline hello events

  const telegram = makeMockTelegramBot();
  const entries = sessionDefs.map(({ sessionId, sessionName }) =>
    makeSessionEntry({ sessionId, sessionName }),
  );
  const driver = loadAllowAllAfkContractDriver({ daemon, clients,
    telegram, registry: new MemoryAfkRegistry(entries), ... });

  return { clients, telegram, driver, sessionDefs };
}
```

Key: `delay: async () => undefined` (no-op) is already injected by
`loadAllowAllAfkContractDriver` — retries complete as microtasks, no timer
advancement needed for the happy path.

### 2. Inject a post-fleet failure trigger

To test compensation over the full fleet, fail AFTER all N items are created.
For AFK mode, fail at `postGeneralSummary` by detecting its unique option:

```ts
telegram.api.sendMessage.mockImplementation(
  async (_chatId, _text, options) => {
    if (options?.['parse_mode'] === 'MarkdownV2') {
      throw new Error('Fleet test: postGeneralSummary injected failure');
    }
    return { message_id: 100 };
  },
);
```

### 3. Build a 429 mock with pre-calculated topic IDs

`makeMockTelegramBot` assigns topic IDs sequentially from `nextTopicId = 9001`.
Pre-calculate which IDs to target before the mock fires:

```ts
const FLEET_SIZE = 20;
const FIRST_TOPIC_ID = 9001;
// Every 3rd topic (7/20): 9001, 9004, 9007, 9010, 9013, 9016, 9019
const TOPICS_TO_429 = new Set(
  Array.from({ length: FLEET_SIZE }, (_, i) => FIRST_TOPIC_ID + i)
    .filter((_, i) => i % 3 === 0),
);
const already429d = new Set<number>();

telegram.api.closeForumTopic.mockImplementation(
  async (_chatId, topicId) => {
    const id = topicId as number;
    if (TOPICS_TO_429.has(id) && !already429d.has(id)) {
      already429d.add(id);
      throw Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
    }
    return true;
  },
);
```

The `error_code: 429` shape is required by `retryAfterMs()` in `afkMode.ts`.

### 4. Drain async chains

With `vi.useFakeTimers` and a no-op `delay`, the entire activation + compensation
chain runs as microtasks and completes before the `setImmediate` in
`handleAfkRequest`. A small `drainAsync(20)` guards edge cases:

```ts
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
async function drainAsync(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}
```

### 5. Assert no-leak, no-duplicate, timer-bound

```ts
// No leaks: every created topic ID is in the close calls
const closedIds = telegram.api.closeForumTopic.mock.calls.map((c) => c[1] as number);
expect(new Set(closedIds).size).toBe(FLEET_SIZE);
for (const topicId of telegram.createdTopicIds) {
  expect(closedIds).toContain(topicId);
}

// No duplicates: unique close count equals fleet size
expect(new Set(closedIds).size).toBe(FLEET_SIZE);

// Total calls with retries = N + N_429
expect(telegram.api.closeForumTopic).toHaveBeenCalledTimes(
  FLEET_SIZE + TOPICS_TO_429.size,
);

// Compensation timeout timers pending (none fired = closes beat the 7 s cap)
expect(vi.getTimerCount()).toBe(FLEET_SIZE);
```

---

## Important Constraints

- **Public surface only.** Do not access private methods or internal state of
  `AfkModeController`. Kat may restructure internals; tests must survive refactors.
- **`vi.useFakeTimers` is required** for compensation close timeout tests.
  Without it, the 7 s `setTimeout` fires for real and the test hangs.
- **Topic ID determinism** only holds if no other test in the same file or
  `beforeEach` calls `makeMockTelegramBot` and creates topics before yours. Each
  test must create a fresh `makeMockTelegramBot()` instance.
- **29 flush iterations** is comfortably above the observed minimum for N=20.
  Scale proportionally for larger fleets.

---

## Reference

- First used: `tests/integration/afk-mode-fleet-compensation.test.ts` (A6-6)
- Date: 2026-05-28T10:00:30-07:00
- Verdict produced: A6-6 CLOSED (safe at N=20+)
