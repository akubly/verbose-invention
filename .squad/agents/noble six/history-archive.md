# Noble Six — History Archive

## Archived Entries (Before 2026-05-01)

This file contains historical architecture and SDK binding work from earlier phases of Reach. The active history is maintained in `history.md`.

### 2026-04-12 — Architecture & SDK Binding (Day 1)

**Established:**
- Project scope and requirements (4 key requirements, mobile bridge via Telegram forum topics)
- Sister project coordination (Cairn — session intelligence daemon)
- TypeScript domain model (`src/types.ts`): SessionEntry, CopilotChunk, CopilotSession interfaces
- Named session registry design (durable, JSON-backed, topicId-keyed)

**SDK Integration:**
- `src/copilot/impl.ts`: CopilotClientImpl (singleton), CopilotSessionAdapter (event→AsyncIterable bridge)
- `src/main.ts`: DI root with platform detection, env config, graceful shutdown
- Two-phase session existence check (avoid masking connection errors)

### 2026-04-12 — Code Review Fixes (Race Conditions, Stream Timeout, Shutdown Safety)

**Applied 6 fixes:**
1. Race condition in ensureStarted() — startup promise pattern
2. Stream timeout protection — 5-minute Promise.race with cleanup
3. Idempotent shutdown — guard flag for double Ctrl+C
4. Relay disposal on shutdown — destroy idle monitors
5. TELEGRAM_CHAT_ID NaN validation
6. resume() error discrimination — only "not found" returns null

### 2026-04-14 — Phase 2: Service Installer & Env Configuration

**Delivered:**
- Service installer implementation with Windows Service registration
- `.env.example` with all environment variables documented
- Security guidance (masked chat ID, secure env var handling)
- Chat guard middleware for Telegram bot

### 2026-04-25 — Phase 4 Wave 1: Permission System Architecture

**Designed:**
- Permission policy options (None, InlineWarning, InteractiveDestructive)
- Destructive tool classifier (coarse-grained set: edit, create, shell, git, gh commands)
- Factory integration point for permission callbacks
- Per-session permission context (chatId + topicId)

---

## Summary

Pre-Phase 5 work established the full architecture: SDK binding, DI root, service registration, and permission system design. Phase 5 focused on scoping and prioritizing UX improvements (MarkdownV2, message splitting, /resume).
