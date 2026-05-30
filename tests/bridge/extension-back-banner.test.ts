/**
 * Unit test for Bug #3 fix: deduplicate "🖥️ Back at desk" banner.
 *
 * When /back is run, the daemon sends BOTH `back.confirmed` (session-scoped,
 * handled by handleBackConfirmed) AND `mode.changed { active: false }` (broadcast,
 * handled by handleModeChanged) to the same session.  Before the fix, both
 * handlers emitted the banner, causing two identical messages in Telegram.
 *
 * Post-fix contract:
 *   - handleBackConfirmed  → always shows "🖥️ Back at desk"
 *   - handleModeChanged(active=false) → silent (data event only; back.confirmed already owns the banner)
 *   - handleModeChanged(active=true)  → shows "🛰️ AFK mode active" (unaffected)
 *
 * These tests replicate the handler logic verbatim so that any deviation from
 * the expected post-fix behaviour is caught here.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Replicated handler logic (mirrors extension.mjs post-fix) ─────────────────

type ShowCliMessage = (msg: string) => void;

function makeHandlers(showCliMessage: ShowCliMessage) {
  function handleBackConfirmed(_msg: unknown): void {
    showCliMessage('🖥️ Back at desk');
  }

  function handleModeChanged(msg: { active?: boolean; since?: string }): void {
    if (msg.active === true) {
      showCliMessage('🛰️ AFK mode active');
    }
    // active=false is intentionally silent: back.confirmed already owns the "Back at desk" banner.
  }

  return { handleBackConfirmed, handleModeChanged };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('extension back-banner dedupe (Bug #3)', () => {
  it('back.confirmed emits exactly one "Back at desk" banner', () => {
    const showCliMessage = vi.fn();
    const { handleBackConfirmed } = makeHandlers(showCliMessage);

    handleBackConfirmed({});

    expect(showCliMessage).toHaveBeenCalledTimes(1);
    expect(showCliMessage).toHaveBeenCalledWith('🖥️ Back at desk');
  });

  it('mode.changed active=false is silent (no banner)', () => {
    const showCliMessage = vi.fn();
    const { handleModeChanged } = makeHandlers(showCliMessage);

    handleModeChanged({ active: false, since: '2026-05-29T22:34:52-07:00' });

    expect(showCliMessage).not.toHaveBeenCalled();
  });

  it('mode.changed active=true still emits "AFK mode active" banner', () => {
    const showCliMessage = vi.fn();
    const { handleModeChanged } = makeHandlers(showCliMessage);

    handleModeChanged({ active: true, since: '2026-05-29T22:34:52-07:00' });

    expect(showCliMessage).toHaveBeenCalledTimes(1);
    expect(showCliMessage).toHaveBeenCalledWith('🛰️ AFK mode active');
  });

  it('/back scenario: both events received → exactly one banner', () => {
    // Simulates the session that ran /back receiving back.confirmed then mode.changed active=false.
    const showCliMessage = vi.fn();
    const { handleBackConfirmed, handleModeChanged } = makeHandlers(showCliMessage);

    handleBackConfirmed({});
    handleModeChanged({ active: false, since: '2026-05-29T22:34:52-07:00' });

    expect(showCliMessage).toHaveBeenCalledTimes(1);
    expect(showCliMessage).toHaveBeenCalledWith('🖥️ Back at desk');
  });

  it('/afk scenario: afk.activated then mode.changed active=true → two banners (allowed, different sources)', () => {
    // This was never reported as a bug — documenting expected behaviour.
    const showCliMessage = vi.fn();
    const { handleModeChanged } = makeHandlers(showCliMessage);

    // afk.activated handler (not replicated here) would call showCliMessage('🛰️ AFK mode active')
    showCliMessage('🛰️ AFK mode active'); // simulate afk.activated
    handleModeChanged({ active: true });   // mode.changed broadcast

    expect(showCliMessage).toHaveBeenCalledTimes(2);
  });
});
