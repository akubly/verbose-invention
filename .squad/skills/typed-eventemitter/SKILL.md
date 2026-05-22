# Skill: Typed EventEmitter (Composition Pattern)

**Trigger:** You need a class that emits typed events (named events with typed arguments) in TypeScript under `@typescript-eslint/recommended` rules.

---

## Problem

The standard TypeScript pattern for typed EventEmitters is **declaration merging**:

```typescript
// ❌ Triggers @typescript-eslint/no-unsafe-declaration-merging
export declare interface MyEmitter {
  on(event: 'foo', listener: (x: string) => void): this;
}
export class MyEmitter extends EventEmitter { ... }
```

The `no-unsafe-declaration-merging` rule blocks this pattern.

## Solution: Composition + Typed Overloads

Wrap a private `EventEmitter` and expose typed `on()` / `off()` overloads directly on the class.

```typescript
import { EventEmitter } from 'node:events';

export class MyEmitter {
  private readonly _emitter = new EventEmitter();

  // Typed overloads — one per event
  on(event: 'foo', listener: (x: string) => void): this;
  on(event: 'bar', listener: (x: string, y: number) => void): this;
  // Implementation signature must use `any[]` (not `unknown[]`) for TS compatibility.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this._emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this._emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // Internal emit — private so consumers can only subscribe, not emit.
  private emitEvent(event: 'foo', x: string): void;
  private emitEvent(event: 'bar', x: string, y: number): void;
  private emitEvent(event: string, ...args: unknown[]): void {
    this._emitter.emit(event, ...args);
  }
}
```

## Optional: Extract a `BridgeEmitter` interface

If consumers of the class only need `on()` / `off()`, extract an interface for type-safe injection:

```typescript
export interface MyEmitterSubscriber {
  on(event: 'foo', listener: (x: string) => void): this;
  on(event: 'bar', listener: (x: string, y: number) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

export class MyEmitter implements MyEmitterSubscriber { ... }
```

## Rules

1. Implementation `on()` uses `(...args: any[]) => void` — suppress with eslint-disable.
2. `emitEvent()` is private — only the class itself fires events.
3. No `declare interface` + `class` with same name — triggers `no-unsafe-declaration-merging`.
4. `off()` can safely use `unknown[]` in both overloads and implementation.

## Codebase example

- `src/bridge/extensionBridge.ts` — `ExtensionBridge implements BridgeEmitter`
