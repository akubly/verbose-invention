/**
 * Cycle5 Thread C — stream.error listener sessionId filter regression test.
 *
 * Reviewer observation: the stream.error listener filtered only by requestId
 * and ignored sessionId, so if a requestId were ever reused across sessions
 * an error could be propagated to the wrong session's generator.
 *
 * Fix: also require sId === this.sessionId before raising the error.
 */

import { describe, it, expect } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

const SESSION_ID = 'sess-cycle5-C';
const FOREIGN_SESSION_ID = 'sess-cycle5-C-other';
const REQUEST_ID = 'req-shared';

describe('Cycle5 Thread C — stream.error listener sessionId filter', () => {
  it('drops stream.error events whose sessionId does not match this.sessionId, even when requestId matches', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    // Foreign session, same requestId — must NOT cause the generator to throw.
    bridge.emitStreamError(FOREIGN_SESSION_ID, REQUEST_ID, 'foreign-error');
    // Our session — must complete the stream normally.
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'our-chunk', true);

    const r1 = await p;
    const r2 = await iter.next();

    expect(r1).toEqual({ value: 'our-chunk', done: false });
    expect(r2.done).toBe(true);
  });

  it('still raises the error when sessionId AND requestId both match', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStreamError(SESSION_ID, REQUEST_ID, 'real-error');

    await expect(p).rejects.toThrow('real-error');
  });
});
