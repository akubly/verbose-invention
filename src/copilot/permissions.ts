export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'create',
  'powershell',
  'bash',
  'git_commit',
  'gh_pr_create',
  'gh_issue_create',
]);

export function isDestructive(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}
