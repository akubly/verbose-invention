# Skill: SDK Introspection

**Purpose:** Systematically inspect an installed npm SDK to understand its API surface, undocumented behaviors, and filesystem conventions — without running the SDK itself.

**When to use:** Before building against a new or opaque SDK, when the API surface is unclear, or when you need to understand what the SDK writes to disk.

---

## Steps

### 1. Package metadata
Read `node_modules/{pkg}/package.json`:
- `version` — confirms what's installed vs. what docs cover
- `exports` — which entry points exist (main, extension, etc.)
- `types` — where `.d.ts` files live

### 2. Public API surface
Read the primary `.d.ts` file (usually `dist/index.d.ts`):
- Lists all exported classes, functions, and types
- Shows what's re-exported vs. defined in-file
- Identifies capability-gated types (these often have a "Only available when..." note)

### 3. Detailed types
Read the class `.d.ts` files (e.g., `client.d.ts`, `types.d.ts`):
- Method signatures with full parameter and return types
- JSDoc comments — often the only place constraints are documented
- Look for "Only available when..." guards (these indicate feature flags or modes)
- Look for union types and discriminated unions — they reveal the state machine

### 4. README
Read the SDK's README:
- Canonical usage examples
- Mode descriptions (e.g., TUI+server mode, stdio mode)
- Config option tables
- Known limitations

### 5. Implementation (client.js / index.js)
Search the compiled JS for undocumented behaviors:
- Port discovery patterns (`listening on port (\d+)`)
- File paths the SDK reads or writes
- Lock file conventions
- Environment variable references

Useful patterns to grep:
```
port|socket|listen|lockfile|server\.json|breadcrumb|APPDATA|home
```

### 6. Filesystem validation
Check what the SDK actually writes to disk on the host:
- Common paths: `~/.copilot/`, `%LOCALAPPDATA%\GitHub\`, `%APPDATA%\`
- Look for: state files, lock files, port files, config files
- Cross-reference with what the `.d.ts` types describe

Useful inspection:
```powershell
Get-ChildItem "$env:USERPROFILE\.copilot" -ErrorAction SilentlyContinue
Get-ChildItem "$env:USERPROFILE\.copilot\session-state\{id}" -ErrorAction SilentlyContinue
```

---

## Output

At the end of introspection, produce:
- **API surface summary:** What methods exist, what they return
- **Filesystem conventions:** What the SDK writes to disk and where
- **Undocumented behaviors:** Patterns found only in implementation code
- **Capability gaps:** Things the docs imply but the SDK doesn't actually support
- **Confidence levels:** HIGH (observed in types + docs + implementation), MEDIUM (inferred from one source), LOW (assumed)

---

## Applied Example: `@github/copilot-sdk` v0.2.2

**Key surfaces found:**
- `client.listSessions(filter?)` — reads shared disk store; works across CLI instances
- `client.cliUrl` constructor option — connect to existing TCP server (requires `--ui-server` flag on CLI)
- `session.getForegroundSessionId()` / `setForegroundSessionId()` — TUI focus control; only in `--ui-server` mode
- `~/.copilot/session-state/{id}/workspace.yaml` — session metadata (cwd, branch, repo)
- `~/.copilot/session-state/{id}/inuse.{PID}.lock` — active session lock (PID of owning process)
- **Gap:** No port file written for `--ui-server` mode; port only discoverable from CLI stdout at spawn time
