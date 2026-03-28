# Contributing to Myco

Myco is a collective intelligence plugin for coding projects, supporting Claude Code and Cursor. This guide covers development setup and project conventions. For architecture details, see [Lifecycle docs](docs/lifecycle.md).

## Installing Myco (End Users)

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Then in any project:

```bash
cd your-project
myco init
```

This sets up the vault, configures your LLM backend, and starts capturing session knowledge.

### Requirements

- Node.js 22+
- Claude Code or Cursor
- **Embedding provider** (one of): [Ollama](https://ollama.com) with `bge-m3` (local, free), [OpenRouter](https://openrouter.ai), or [OpenAI](https://platform.openai.com)
- **Intelligence provider** (one of): Cloud (Claude), [Ollama](https://ollama.com), or [LM Studio](https://lmstudio.ai)

For Ollama embeddings, pull the recommended model:

```bash
ollama pull bge-m3
```

## Development Setup

### 1. Clone and install

```bash
git clone https://github.com/goondocks-co/myco.git
cd myco
npm install
```

### 2. Initialize the vault

```bash
myco init
```

For dogfooding, the vault lives at `~/.myco/vaults/myco/` (configured in `.claude/settings.json`).

### 4. Verify

```bash
myco doctor    # Health check
myco stats     # Daemon status
```

## Development Workflow

### Build and test

```bash
make build             # lint + test + tsc + copy templates
make check             # lint + test only (pre-commit gate)
make watch             # tsc watch mode
make clean             # remove dist/
```

### After code changes

Hooks pick up new code on the next invocation. The daemon must be restarted separately:

```bash
make build && myco restart
```

## Project Structure

```
myco/
├── .github/               # CI workflows + VS Code Copilot agent manifest
├── hooks/                 # Hook registration shell scripts
├── skills/                # Skill markdown files (subdirectory per skill)
├── src/
│   ├── agent/             # Intelligence pipeline: wave-based executor, task definitions, orchestrator
│   ├── capture/           # Event buffering (EventBuffer) and buffer-based turn fallback
│   ├── cli/               # CLI commands (init wizard, doctor, config)
│   ├── config/            # Vault config loading and Zod schema
│   ├── context/           # Context injection for UserPromptSubmit hook
│   ├── daemon/            # Long-lived HTTP daemon: batch processing, session lifecycle, digest
│   ├── db/                # SQLite database schema and migrations
│   ├── entries/           # Hook entry wrappers
│   ├── hooks/             # Hook entry points (thin — delegate to daemon)
│   ├── index/             # SQLite FTS5 + sqlite-vec vector search
│   ├── intelligence/      # LLM backend abstraction (Ollama, LM Studio, Anthropic)
│   ├── mcp/               # MCP server + tool handlers
│   ├── prompts/           # LLM prompt templates (extraction, summary, title, classification)
│   ├── services/          # Shared service logic (used by both CLI and API)
│   ├── symbionts/         # Symbiont adapters (Claude Code, Cursor, Codex) — transcript discovery, parsing, and project-local registration
│   └── vault/             # Reader, writer, Zod schemas for database records
├── tests/                 # Mirrors src/ structure
├── ui/                    # React + Tailwind dashboard (Vite build → dist/ui/)
├── docs/                  # Lifecycle, quickstart, agent tools
└── Makefile               # Dev shortcuts
```

## Architecture

See [docs/lifecycle.md](docs/lifecycle.md) for the full lifecycle with diagrams. Key points:

- **Hooks are thin** — they delegate to the daemon via HTTP. No business logic in hooks.
- **The daemon is the authority** — all event processing, session recording, spore extraction, and embedding happen there.
- **Transcripts are the source of truth** — session conversation turns are read from the agent's native transcript file (Claude Code `.jsonl`, Cursor `.txt`/`.jsonl`), not from Myco's event buffer. The buffer is the fallback when no transcript is available.
- **Sessions are rebuilt from transcripts** — on each stop event, the full conversation is re-parsed from the transcript and the session record is regenerated. Data preservation is guaranteed by the transcript being append-only.

## Distribution

Published as `@goondocks/myco` on [npmjs.org](https://www.npmjs.com/package/@goondocks/myco).

1. Push to `main` — CI runs lint + tests
2. Tag a release (`v0.x.y`) — triggers the publish workflow
3. `npm publish` builds and pushes to npmjs.org
4. Users update via `npm update -g @goondocks/myco` or re-run the install script

## Conventions

- TypeScript strict mode, ES modules
- `tsup` for bundled builds (native deps `better-sqlite3`/`sqlite-vec` are external, installed at runtime)
- `make check` must pass before committing
- Prompt templates are markdown with `{{placeholder}}` syntax
- Config is YAML (`myco.yaml`), records are stored in SQLite (FTS5 + sqlite-vec)
- No magic literals — extract named constants
- Idempotent operations by default
