import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IdleMonitor } from '../src/idleMonitor.js';

const DEFAULT_TIMEOUT = 300_000; // matches the module default (5 min)

describe('IdleMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── reset / timer basics ──────────────────────────────────────────────────

  describe('reset()', () => {
    it('fires the onIdle callback after IDLE_TIMEOUT_MS', () => {
      const monitor = new IdleMonitor();
      const onIdle = vi.fn();

      monitor.reset(42, onIdle);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(DEFAULT_TIMEOUT);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('does not fire callback before the timeout elapses', () => {
      const monitor = new IdleMonitor();
      const onIdle = vi.fn();

      monitor.reset(42, onIdle);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT - 1);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('cancels the previous timer when reset is called on the same topicId', () => {
      const monitor = new IdleMonitor();
      const firstCb = vi.fn();
      const secondCb = vi.fn();

      monitor.reset(42, firstCb);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2);

      monitor.reset(42, secondCb);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT);

      expect(firstCb).not.toHaveBeenCalled();
      expect(secondCb).toHaveBeenCalledTimes(1);
    });

    it('restarts the full timeout window on each reset', () => {
      const monitor = new IdleMonitor();
      const onIdle = vi.fn();

      monitor.reset(42, onIdle);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT - 1);
      monitor.reset(42, onIdle); // restart
      vi.advanceTimersByTime(DEFAULT_TIMEOUT - 1);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });
  });

  // ── multiple topics ───────────────────────────────────────────────────────

  describe('multiple topics', () => {
    it('tracks independent timers per topicId', () => {
      const monitor = new IdleMonitor();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      monitor.reset(1, cb1);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2);
      monitor.reset(2, cb2);

      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2); // topic 1 fires
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).not.toHaveBeenCalled();

      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2); // topic 2 fires
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('resetting one topic does not affect another', () => {
      const monitor = new IdleMonitor();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      monitor.reset(1, cb1);
      monitor.reset(2, cb2);

      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2);
      monitor.reset(1, cb1); // reset topic 1 only

      vi.advanceTimersByTime(DEFAULT_TIMEOUT / 2); // topic 2 fires
      expect(cb2).toHaveBeenCalledTimes(1);
      expect(cb1).not.toHaveBeenCalled();
    });
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('cancels the timer for the specified topic', () => {
      const monitor = new IdleMonitor();
      const onIdle = vi.fn();

      monitor.reset(42, onIdle);
      monitor.cancel(42);

      vi.advanceTimersByTime(DEFAULT_TIMEOUT * 2);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown topicId', () => {
      const monitor = new IdleMonitor();
      expect(() => monitor.cancel(999)).not.toThrow();
    });

    it('does not affect other topics', () => {
      const monitor = new IdleMonitor();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      monitor.reset(1, cb1);
      monitor.reset(2, cb2);
      monitor.cancel(1);

      vi.advanceTimersByTime(DEFAULT_TIMEOUT);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // ── cancelAll ─────────────────────────────────────────────────────────────

  describe('cancelAll()', () => {
    it('cancels all active timers', () => {
      const monitor = new IdleMonitor();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const cb3 = vi.fn();

      monitor.reset(1, cb1);
      monitor.reset(2, cb2);
      monitor.reset(3, cb3);
      monitor.cancelAll();

      vi.advanceTimersByTime(DEFAULT_TIMEOUT * 2);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
      expect(cb3).not.toHaveBeenCalled();
    });

    it('is safe to call when no timers are active', () => {
      const monitor = new IdleMonitor();
      expect(() => monitor.cancelAll()).not.toThrow();
    });
  });

  // ── cleanup after fire ────────────────────────────────────────────────────

  describe('cleanup after timer fires', () => {
    it('removes the topicId from internal state after the callback fires', () => {
      const monitor = new IdleMonitor();
      const firstCb = vi.fn();

      monitor.reset(42, firstCb);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT);
      expect(firstCb).toHaveBeenCalledTimes(1);

      // After firing, a new reset should work independently
      const secondCb = vi.fn();
      monitor.reset(42, secondCb);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT);
      expect(secondCb).toHaveBeenCalledTimes(1);

      // First callback was not called again
      expect(firstCb).toHaveBeenCalledTimes(1);
    });

    it('cancel after fire is a harmless no-op', () => {
      const monitor = new IdleMonitor();
      const onIdle = vi.fn();

      monitor.reset(42, onIdle);
      vi.advanceTimersByTime(DEFAULT_TIMEOUT);
      expect(onIdle).toHaveBeenCalledTimes(1);

      // cancel after fire — should not throw
      expect(() => monitor.cancel(42)).not.toThrow();
    });
  });
});
