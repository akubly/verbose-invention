import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_TOOLS,
  SAFE_TOOLS,
  isDestructive,
  isKnownSafe,
} from '../../src/copilot/permissions.js';

describe('copilot permission tool classification', () => {
  it.each([
    ['edit', true],
    ['create', true],
    ['powershell', true],
    ['bash', true],
    ['git_commit', true],
    ['gh_pr_create', true],
    ['gh_issue_create', true],
    ['view', false],
    ['grep', false],
    ['glob', false],
    ['unknown_tool', false],
  ])('isDestructive(%s) -> %s', (tool, expected) => {
    expect(isDestructive(tool)).toBe(expected);
  });

  it.each([
    ['read', true],
    ['url', true],
    ['view', true],
    ['grep', true],
    ['glob', true],
    ['edit', false],
    ['unknown_tool', false],
  ])('isKnownSafe(%s) -> %s', (tool, expected) => {
    expect(isKnownSafe(tool)).toBe(expected);
  });

  it('exports a destructive tool set with the baseline write-capable tools', () => {
    expect(DESTRUCTIVE_TOOLS).toBeInstanceOf(Set);
    expect(DESTRUCTIVE_TOOLS.size).toBeGreaterThanOrEqual(7);

    for (const tool of [
      'edit',
      'create',
      'powershell',
      'bash',
      'git_commit',
      'gh_pr_create',
      'gh_issue_create',
    ]) {
      expect(DESTRUCTIVE_TOOLS.has(tool)).toBe(true);
    }
  });

  it('exports a safe tool set with the baseline read-only tools', () => {
    expect(SAFE_TOOLS).toBeInstanceOf(Set);
    expect(SAFE_TOOLS.size).toBeGreaterThanOrEqual(7);

    for (const tool of ['read', 'url', 'view', 'grep', 'glob']) {
      expect(SAFE_TOOLS.has(tool)).toBe(true);
    }
  });
});
