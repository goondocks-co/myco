# Contributing to Myco

Myco is a plugin for collective agent intelligence, supporting Claude Code and Cursor. This guide covers development setup and project conventions. For architecture details, see [Lifecycle docs](docs/lifecycle.md).

## Installing Myco (End Users)

```bash
claude plugin marketplace add goondocks-co/myco
claude plugin install myco@myco-plugins
```

Then in any project:

```
/myco-init
```

This sets up the vault, configures your LLM backend, and starts capturing session knowledge.

### Requirements

- Node.js 22+
- Claude Code or Cursor
- An LLM backend: [Ollama](https://ollama.com) (recommended) or an Anthropic API key

For Ollama, pull the recommended models:

```bash
ollama pull gpt-oss
ollama pull nomic-embed-text
```

## Development Setup

### 1. Clone and install

```bash
git clone https://github.com/goondocks-co/myco.git
cd myco
npm install
```

### 2. Run locally

For **active development** (per-session, no install needed):

```bash
claude --plugin-dir /path/to/myco
```

For **persistent local dev** (survives across sessions):

```bash
claude plugin marketplace add /path/to/myco/.claude-plugin
claude plugin install myco
```

### 3. Initialize the vault

```
/myco-init
```

For dogfooding, the vault lives at `~/.myco/vaults/myco/` (configured via `MYCO_VAULT_DIR` in `.claude/settings.json`).

### 4. Verify

```
/myco-status
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
make build && node dist/src/cli.js restart
```

## Project Structure

```
myco/
├── .claude-plugin/        # Claude Code + VS Code plugin manifest + marketplace
├── .cursor-plugin/        # Cursor plugin manifest + marketplace
├── hooks/                 # Hook registration shell scripts
├── commands/              # Slash commands (/myco-init, /myco-status, /myco-setup-llm)
├── skills/                # Agent skills
├── src/
│   ├── agents/            # Agent adapters (Claude Code, Cursor) — transcript parsing + image capture
│   ├── capture/           # Event buffering + buffer-based turn fallback
│   ├── config/            # Config schema and loader
│   ├── context/           # Context injection for UserPromptSubmit hook
│   ├── daemon/            # Long-lived HTTP daemon: session lifecycle, batch processing, plan watching
│   ├── hooks/             # Hook entry points (thin — delegate to daemon)
│   ├── index/             # SQLite FTS5 + sqlite-vec vector search
│   ├── intelligence/      # LLM backends (Ollama, LM Studio, Anthropic)
│   ├── mcp/               # MCP server + tool handlers
│   ├── prompts/           # LLM prompt templates
│   └── vault/             # Reader, writer, Zod schemas for vault notes
├── tests/                 # Mirrors src/ structure
├── docs/                  # Lifecycle, quickstart, doc site
└── Makefile               # Dev shortcuts
```

## Architecture

See [docs/lifecycle.md](docs/lifecycle.md) for the full lifecycle with diagrams. Key points:

- **Hooks are thin** — they delegate to the daemon via HTTP. No business logic in hooks.
- **The daemon is the authority** — all event processing, session note writing, and observation extraction happen there.
- **Transcripts are the source of truth** — session conversation turns are read from the agent's native transcript file (Claude Code `.jsonl`, Cursor `.txt`/`.jsonl`), not from Myco's event buffer. The buffer is the fallback when no transcript is available.
- **Session notes are rebuilt** — on each stop event, the full conversation is re-parsed from the transcript and the session note is regenerated. Data preservation is guaranteed by the transcript being append-only.

## Distribution

Published as `@goondocks/myco` on [npmjs.org](https://www.npmjs.com/package/@goondocks/myco).

1. Push to `main` — CI runs lint + tests
2. Tag a release (`v0.x.y`) — triggers the publish workflow
3. `npm publish` builds and pushes to npmjs.org
4. Users get the new version via `claude plugin update myco`

## Conventions

- TypeScript strict mode, ES modules
- `tsup` for bundled builds (native deps `better-sqlite3`/`sqlite-vec` are external, installed at runtime)
- `make check` must pass before committing
- Prompt templates are markdown with `{{placeholder}}` syntax
- Config is YAML (`myco.yaml`), vault notes are markdown with YAML frontmatter
- No magic literals — extract named constants
- Idempotent operations by default
