export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'create',
  'powershell',
  'bash',
  'git_commit',
  'gh_pr_create',
  'gh_issue_create',
]);

export const SAFE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'url',
  'view',
  'grep',
  'glob',
  'list_powershell',
  'read_powershell',
  'list_agents',
  'read_agent',
  'fetch_copilot_cli_documentation',
  'web_fetch',
  'web_search',
  'session_store_sql',
  'github-mcp-server-get_file_contents',
  'github-mcp-server-get_copilot_space',
  'github-mcp-server-list_copilot_spaces',
  'github-mcp-server-search_code',
  'github-mcp-server-search_users',
  'memory-read_graph',
  'memory-open_nodes',
  'memory-search_nodes',
]);

export function isDestructive(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

export function isKnownSafe(toolName: string): boolean {
  return SAFE_TOOLS.has(toolName);
}
