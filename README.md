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

## Setup

### 1. Clone the repository

```powershell
git clone https://github.com/akubly/verbose-invention.git
cd verbose-invention
```

### 2. Install dependencies

```powershell
npm install
```

### 3. Create `.env` file

Create a `.env` file in the project root with the following variables:

```env
# Required
TELEGRAM_BOT_TOKEN=<your bot token from @BotFather>
TELEGRAM_CHAT_ID=<your supergroup chat ID>

# Optional
REACH_MODEL=claude-sonnet-4
IDLE_TIMEOUT_MS=300000
```

**How to get your chat ID:**
1. Forward any message from your supergroup to [@userinfobot](https://t.me/userinfobot)
2. The bot will reply with the chat ID (a negative number like `-1001234567890`)
3. Copy this value into `TELEGRAM_CHAT_ID` (no quotes)

### 4. Build

```powershell
npm run build
```

### 5. Run

**Foreground (for testing):**

```powershell
npm start
```

**Windows Service (recommended):**

Install and start as a Windows Service (requires admin):

```powershell
npm run service:install
```

The service auto-restarts on failure and runs in the background. To uninstall:

```powershell
npm run service:uninstall
```

## Usage

### Create a session

1. Open your Telegram supergroup
2. Create a new forum topic (any name)
3. In the topic, send: `/new my-session`
4. Start chatting — all messages are relayed to your Copilot session

**With a specific model:**

```
/new my-session --model claude-opus-4.5
```

Available models: `claude-sonnet-4`, `claude-opus-4.5`, `claude-haiku-4`, etc. (any model supported by Copilot CLI). If `--model` is not specified, uses the `REACH_MODEL` environment variable (default: `claude-sonnet-4`).

### List sessions

```
/list
```

Shows all active sessions with their topic IDs and models.

### Remove a session

In the topic you want to unlink:

```
/remove
```

This unlinks the session from the topic. The Copilot session history persists (you can resume it later with `/new <same-name>`).

### Help

```
/help
```

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather | — |
| `TELEGRAM_CHAT_ID` | Yes | Supergroup chat ID (numeric, e.g. `-1001234567890`) | — |
| `REACH_MODEL` | No | Default Copilot model for new sessions | `claude-sonnet-4` |
| `IDLE_TIMEOUT_MS` | No | In-memory session eviction timeout (ms) | `300000` (5 min) |
| `REACH_PERMISSION_POLICY` | No | Tool approval policy: `approveAll` (default) or `denyAll` | `approveAll` |

## Windows Service

The service installer uses `node-windows` to register Reach as a native Windows Service.

- **Service name:** Reach
- **Logon account:** NetworkService (low-privilege system account)
- **Auto-restart:** Enabled (restarts automatically on crash)
- **Event logging:** Logs to Windows Event Viewer

**Install:**

```powershell
npm run service:install
```

**Uninstall:**

```powershell
npm run service:uninstall
```

Both commands require administrator privileges (run PowerShell as admin).

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
