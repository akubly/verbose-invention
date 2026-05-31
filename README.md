# Reach

Personal Telegram bridge for GitHub Copilot CLI sessions on Windows. Control Copilot from your phone using Telegram forum topics as the UI. One topic = one named session.

## How It Works

Reach runs as a Windows daemon that connects Telegram ↔ GitHub Copilot CLI. Each Telegram forum topic maps to a named Copilot session. Messages you send in a topic are relayed to the session; Copilot's responses stream back to the same topic.

**Architecture:** Telegram Bot API (grammY) ↔ Session Registry ↔ Relay ↔ GitHub Copilot SDK (`@github/copilot-sdk`).

## Prerequisites

- **Node.js 20+**
- **Telegram Bot token** — Create a bot via [@BotFather](https://t.me/BotFather) and save the token
- **Telegram supergroup with forum topics enabled** — Create a supergroup, enable Topics (in group settings), add your bot as admin
- **GitHub Copilot CLI access** — Requires an active GitHub Copilot subscription with access to `@github/copilot-sdk`

## Quick Start

```powershell
git clone https://github.com/akubly/verbose-invention.git
cd verbose-invention
npm install
npm run build
npm run init
```

The `npm run init` command orchestrates the full setup: configuration wizard → extension install → Windows Service install. It requires your TELEGRAM_BOT_TOKEN and prompts for other credentials if needed.

## Installation

### What `npm run init` Does

1. **Config wizard** — Checks for required environment variables. Prompts for `TELEGRAM_BOT_TOKEN` if missing; warns about optional `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_CHAT_ID`.
2. **Extension install** — Copies `extension.mjs` to `%APPDATA%\GitHub Copilot\User\extensions\reach\` so the Copilot CLI can load the Reach extension.
3. **Service install** — Registers Reach as a Windows Service under your user account. Prompts for your Windows password once (required for service registration; not stored by Reach).
4. **Next steps** — Prints instructions for configuring Telegram and creating your first session.

### Configuration

**Required:**

- `TELEGRAM_BOT_TOKEN` — Bot token from [@BotFather](https://t.me/BotFather)
- `TELEGRAM_ALLOWED_USER_IDS` — Your Telegram numeric user ID (prevents unauthorized access). Find it by messaging [@userinfobot](https://t.me/userinfobot) in Telegram; it replies with your ID.

**Optional:**

- `TELEGRAM_CHAT_ID` — Your supergroup chat ID (e.g., `-1001234567890`). If not set, Reach starts in pairing mode — send `/pair <code>` from your supergroup to link it.
- `REACH_MODEL` — Default Copilot model for new sessions (default: `claude-sonnet-4`)
- `IDLE_TIMEOUT_MS` — In-memory session eviction timeout in ms (default: `300000` / 5 min)
- `REACH_PERMISSION_POLICY` — Tool approval policy: `approveAll` (default), `denyAll`, or `interactiveDestructive`

The config wizard will write required variables to `.env` on first run. You can edit `.env` anytime to adjust settings.

### Windows Service Details

Reach runs as a Windows Service under your user account.

- **Service name:** Reach
- **Auto-restart:** Enabled (restarts on crash)
- **Event logging:** Logs to Windows Event Viewer
- **State preservation:** Configuration and session registry are stored in `%LOCALAPPDATA%\reach\`

At startup, the daemon creates a randomized named pipe and writes auth credentials to `%LOCALAPPDATA%\reach\bridge-auth.json` (user-only ACL).

## Using Reach

### Telegram Commands

**Session management:**

- `/new <name> [--model <model>] [--cwd <alias-or-path>]` — Create a session in this topic. Optionally specify a Copilot model or working directory alias.
- `/list` — Show all active sessions with their topic IDs and models.
- `/resume` — Resume a named session (equivalent to `/new <name>` if it exists).
- `/remove` — Unlink this topic from its session. Session history persists.

**CWD registry (General Topic only):**

- `/cwd list` — Show all known directory aliases with last-used times.
- `/cwd add <alias> <path>` — Register a directory alias (e.g., `/cwd add myrepo C:\src\myrepo`).
- `/cwd remove <alias>` — Remove an alias.

**Other:**

- `/status` — Show session orientation (session ID, CWD, model, AFK mode start time, and last assistant message excerpt).
- `/help` — List all bot commands.
- `/pair <code>` — Pair Reach to a Telegram supergroup (used during setup if `TELEGRAM_CHAT_ID` is not configured).

### CLI Commands Pass-Through

Any command not in the list above is forwarded verbatim to your Copilot CLI session. This includes core CLI commands like `/clear`, `/agent`, `/model`, `/exit`, and any extensions you've installed in the Copilot CLI. Same UX as typing in the terminal.

### Orientation Message

When you first activate AFK mode in a topic (or after restarting the Reach daemon), an orientation message is sent once per session:

```
📍 Session active
━━━━━━━━━━━━━━━━━━
🆔 my-session
📂 C:\src\myproject
🤖 claude-sonnet-4
🎚️ Mode: AFK (since 14:23 UTC)

💬 Last from claude-sonnet-4:
> Here's the implementation for the config parser. I added validation for the schema fields and included unit tests in tests/config/...
```

Use `/status` to refresh this manually. The last assistant message excerpt is cached from the most recent CLI response, truncated to 500 characters.

### Getting Started: CWD Registry Example

```
/cwd add myrepo C:\src\myrepo
/cwd add scratch D:\scratch
/cwd list
/new my-session --cwd myrepo
```

### Platform Note

Path arguments accept Windows-style absolute paths (e.g., `C:\path`). UNC paths (`\\server\share`) are not currently supported and will be rejected with an error.

## Development Workflow

**Fast extension iteration:**

Set `NODE_ENV=development` when installing the extension. Instead of copying, it creates a junction (Windows directory link) so your `extension.mjs` edits apply immediately without re-running the installer.

```powershell
$env:NODE_ENV='development'
npm run install:extension
```

Then edit `extension.mjs` and restart the Copilot CLI to pick up changes.

**Manual extension reinstall:**

```powershell
npm run install:extension
```

This re-copies the extension without running the full setup wizard or service install.

## Upgrading

Pull the latest changes and rebuild:

```powershell
git pull
npm run build
npm run install:extension
```

Or to re-run the full setup (e.g., to update configuration):

```powershell
npm run init
```

## Uninstall

**Preserve state (default):**

```powershell
npm run uninstall
```

Removes the Windows Service and extension. Your configuration and session registry remain in `%LOCALAPPDATA%\reach\` so you can reinstall later without reconfiguring.

**Full reset:**

```powershell
npm run uninstall -- --wipe
```

Also deletes `%LOCALAPPDATA%\reach\`, removing all configuration and session history.

## Platform Support

**Windows-only for Phase 8.5–9.** Cross-platform support (macOS launchd, Linux systemd) is planned for a future release.

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather | — |
| `TELEGRAM_CHAT_ID` | No | Supergroup chat ID (numeric, e.g. `-1001234567890`). Resolved in order: env var → `config.json` → pairing mode (`/pair <code>`) | — |
| `REACH_MODEL` | No | Default Copilot model for new sessions | `claude-sonnet-4` |
| `IDLE_TIMEOUT_MS` | No | In-memory session eviction timeout (ms) | `300000` (5 min) |
| `REACH_PERMISSION_POLICY` | No | Tool approval policy: `approveAll` (default), `denyAll`, or `interactiveDestructive` (prompt for coarse-grained destructive tools) | `approveAll` |

## Development

### Run tests

```powershell
npm test
```

### Type check

```powershell
npm run typecheck
```

### Build

```powershell
npm run build
```

### Watch mode (dev)

```powershell
npm run dev
```

## License

MIT
