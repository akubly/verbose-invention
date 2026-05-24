/**
 * Cycle5 Thread B — stream chunk listener sessionId filter regression test.
 *
 * Reviewer observation: the stream listener filtered only by requestId and
 * ignored the sessionId argument, so if a requestId were ever reused across
 * sessions a chunk could be delivered to the wrong session's generator.
 *
 * Fix: also require sId === this.sessionId before accepting the chunk.
 */

import { describe, it, expect } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

const SESSION_ID = 'sess-cycle5-B';
const FOREIGN_SESSION_ID = 'sess-cycle5-B-other';
const REQUEST_ID = 'req-shared';

describe('Cycle5 Thread B — stream listener sessionId filter', () => {
  it('drops stream chunks whose sessionId does not match this.sessionId, even when requestId matches', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const chunks: string[] = [];
    const consuming = (async () => {
      for await (const c of session.send('hello')) {
        chunks.push(c);
      }
    })();

    // Same requestId but FOREIGN session — must be dropped.
    bridge.emitStream(FOREIGN_SESSION_ID, REQUEST_ID, 'foreign-chunk', false);
    // Our session, same requestId — must be delivered.
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'our-chunk', true);

    await consuming;

    expect(chunks).toEqual(['our-chunk']);
    expect(chunks).not.toContain('foreign-chunk');
  });
});
