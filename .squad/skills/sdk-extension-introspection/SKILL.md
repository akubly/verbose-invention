# Skill: SDK Extension / Plugin Introspection

**Maintained by:** Carter  
**Last updated:** 2026-05-09  
**Applies to:** Any investigation of whether an SDK has an extension or plugin surface

---

## Purpose

When given an SDK package, systematically determine whether it exposes an extension or plugin API — what hooks it provides, what lifecycle it has, how extensions are discovered, and what in-process access they have. Applies to `@github/copilot-sdk` and analogous SDK packages.

---

## Step-by-Step Workflow

### Step 1: Check `package.json#exports`

```powershell
Get-Content node_modules\@vendor\sdk\package.json | ConvertFrom-Json | Select-Object -ExpandProperty exports
```

Look for subpath exports like `"./extension"`, `"./plugin"`, `"./hooks"`. These are explicit extension entry points the package maintainers publish.

**Finding:** `@github/copilot-sdk@0.2.2` ships `"./extension"` → `dist/extension.d.ts` / `dist/extension.js`.

### Step 2: Enumerate `.d.ts` files

```powershell
Get-ChildItem node_modules\@vendor\sdk\dist -Recurse -Filter "*.d.ts" | Select-Object Name
```

Look for `extension.d.ts`, `plugin.d.ts`, `hooks.d.ts`. These are the canonical surfaces — if they exist, the API is real and typed.

**Finding:** `extension.d.ts` exports `joinSession(config?)` — the sole extension entry point.

### Step 3: Read the `.d.ts` and implementation

Read both the `.d.ts` (public contract) and the `.js` implementation. The `.js` reveals how it actually connects (e.g., reads `process.env.SESSION_ID`, uses `isChildProcess: true`, connects to parent via stdio).

**Pattern:** Look for:
- Environment variables used as identity (`SESSION_ID`, `EXTENSION_ID`, etc.)
- `isChildProcess`, `useStdio`, `connectToParent` constructor options
- `process.env.*` reads at startup

### Step 4: Read the docs folder

```powershell
Get-ChildItem node_modules\@vendor\sdk\docs | Select-Object Name
```

Read every `.md` file. SDK docs often describe the full lifecycle, discovery mechanism, and activation rules that aren't obvious from types alone.

**Finding for copilot-sdk:** `docs/extensions.md` explains lifecycle, discovery, reload rules. `docs/examples.md` shows network access patterns.

### Step 5: Search the CLI/host binary for discovery logic

The CLI that loads extensions will have the extension manager embedded. Search for extension paths in the minified source:

```powershell
$content = Get-Content node_modules\@vendor\cli\app.js -Raw
$idx = $content.IndexOf('.github/extensions')
$content.Substring([Math]::Max(0,$idx-100), 800)
```

Look for:
- Discovery directories (project-level vs user-level paths)
- Launch mechanism (`fork`, `spawn`, `require`)
- Environment variables passed to child process
- Reload triggers (what causes extension reload)
- Allowed file names (`extension.mjs`, `plugin.js`, etc.)

**Finding:** `.github/extensions/<name>/extension.mjs` (project) and `<config_dir>/extensions/<name>/extension.mjs` (user). Forks with `SESSION_ID` + `EXTENSION_PATH` + `COPILOT_SDK_PATH` env vars. Reloads on `/clear` or foreground session change.

### Step 6: Determine what the extension CAN do

Assess the following against the extension API:

| Capability | How to check | Signal |
|-----------|--------------|--------|
| Observe session events | `session.on()` in `.d.ts` | Event union type width |
| Inject user input | `session.send()` in `.d.ts` | Present? Parameters? |
| Register tools/commands | `tools` / `commands` in `SessionConfig` | Config shape |
| Network access | Examples using `fetch()` or `net` | Node.js APIs used |
| Async background code | Event loop model | Always yes in Node.js child process |
| In-process vs out-of-process | `.js` implementation | `fork()` → separate process; `require()` → in-process |

### Step 7: Assess discovery and activation friction

- **Ambient** (no user action): extension placed in user-level dir during install
- **Per-project**: extension placed in `.github/extensions/` in the repo — requires repo checkout
- **Manual**: user must run a command to install

User-level extensions are always preferred for daemon/bridge use cases because they activate for all sessions without per-repo configuration.

---

## Key Patterns Found in `@github/copilot-sdk@0.2.2`

- Extension = separate Node.js process forked by CLI, JSON-RPC over stdio
- `joinSession()` reads `SESSION_ID` env var → `resumeSession(sessionId, { isChildProcess: true })`
- Full Node.js network access (fetch, net, named pipes)
- `session.send({ prompt })` = inject user turn
- `session.on(eventType, handler)` = observe all events
- Hooks: `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred`
- User extensions dir (Windows): `%APPDATA%\GitHub Copilot\User\extensions\`
- Entry point: `extension.mjs` (ES module only)
- Reload: on `/clear`, foreground session change, `extensions_reload` tool call

---

## When This Skill Applies

Use this workflow when:
- A task says "investigate whether SDK X has an extension surface"
- You need to understand what a daemon/bridge pattern looks like for a given SDK
- You're evaluating whether to implement an in-process bridge vs. an out-of-process client
- You need to understand the lifecycle and activation rules of a plugin system

The investigation typically takes 20–40 minutes and should produce: (a) a clear yes/no on extension surface existence, (b) a list of capabilities, (c) the discovery mechanism and friction assessment.
