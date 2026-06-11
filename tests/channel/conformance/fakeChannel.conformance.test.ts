/**
 * Conformance kit exercised against FakeChannel.
 *
 * This serves two purposes:
 *   1. Validates the FakeChannel itself is well-behaved (it IS a ChannelPort impl).
 *   2. Runs the capability-fallback matrix in full.
 */

import { runChannelPortConformance, runCapabilityFallbackMatrix } from './runner.js';
import { FakeChannel } from './FakeChannel.js';

// FakeChannel with all defaults (all capabilities ON).
runChannelPortConformance(() => new FakeChannel(), { name: 'FakeChannel (all caps ON)' });

// Capability-fallback matrix (FakeChannel permutations).
runCapabilityFallbackMatrix();
