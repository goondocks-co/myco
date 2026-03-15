# Contributing to Myco

Myco is a Claude Code plugin for collective agent intelligence. This guide covers both the development setup (dogfooding) and how end users install from the public repo.

## Installing Myco (End Users)

### From GitHub Packages

```bash
claude plugins marketplace add goondocks-co/myco
claude plugins install myco
```

Then in any project:

```
/myco-init
```

This sets up the vault, configures your LLM backend, and starts capturing session knowledge.

### Requirements

- Node.js 22+
- Claude Code CLI
- An LLM backend: [Ollama](https://ollama.com) (recommended) or an Anthropic API key

For Ollama, pull the recommended models:

```bash
ollama pull gpt-oss
ollama pull nomic-embed-text
```

## Distribution

Myco is published as `@goondocks-co/myco` on [GitHub Packages](https://github.com/goondocks-co/myco/packages). The `marketplace.json` uses the `npm` source type, so Claude Code runs `npm install` when installing the plugin — this triggers the `prepare` script which builds from source. No pre-built `dist/` in git.

**Publishing flow:**

1. Push to `main` — CI runs lint + tests
2. Create a GitHub release — triggers the publish workflow
3. `npm publish` builds and pushes to GitHub Packages
4. Users get the new version on next `claude plugins install`

## Development Setup

### 1. Clone and install

```bash
git clone https://github.com/goondocks-co/myco.git
cd myco
npm install
```

`npm install` triggers `prepare` which runs the full build automatically.

### 2. Install the plugin locally

For **active development** (per-session, no install needed):

```bash
claude --plugin-dir /path/to/myco
```

For **persistent local dev** (survives across sessions):

```bash
claude plugins marketplace add /path/to/myco/.claude-plugin
claude plugins install myco
```

### 3. Initialize the vault

Start a Claude Code session in the myco project directory, then run:

```
/myco-init
```

This detects the `MYCO_VAULT_DIR` env var from `.claude/settings.json` (set to `~/.myco/vaults/myco`), creates the vault structure, and configures the LLM backend.

The vault lives outside the repo to keep the git history clean. Other projects using Myco can keep their vault in-repo (the default `.myco/` location).

### 4. Verify

```
/myco-status
```

## Development Workflow

### Build

```bash
make build             # lint + test + tsc + copy templates
make check             # lint + test only
make clean             # remove dist/
make watch             # tsc watch mode
```

Or directly:

```bash
npm run build          # tsc + copy prompt templates to dist/
npm run lint           # tsc --noEmit
npm test               # vitest run
```

After building, the next Claude Code hook invocation picks up the new code automatically. There is no daemon to restart — each hook runs as a fresh `node` process against `dist/`.

## Project Structure

```
myco/
├── .claude-plugin/        # Plugin metadata (plugin.json, marketplace.json)
├── .claude/settings.json  # Project-level env (sets MYCO_VAULT_DIR)
├── .github/workflows/     # CI + publish to GitHub Packages
├── .mcp.json              # MCP server registration
├── hooks/hooks.json       # Hook event registrations
├── commands/              # Slash commands (/myco-init, /myco-status, /myco-setup-llm)
├── skills/                # Agent skills (myco.md)
├── src/
│   ├── capture/           # Event buffer, processor, prompt templates
│   │   └── prompts/       # Markdown templates + schema.yaml
│   ├── config/            # Config schema and loader
│   ├── hooks/             # Hook entry points (session-start, stop, etc.)
│   ├── index/             # SQLite full-text index
│   ├── intelligence/      # LLM backends (Ollama, LM Studio, Haiku)
│   ├── mcp/               # MCP server (tools for querying the vault)
│   └── vault/             # Vault reader/writer, path resolution
├── dist/                  # Compiled output (gitignored, built by npm prepare)
└── Makefile               # Dev shortcuts
```

## Architecture

### Hook Pipeline

Hooks fire at key points in a Claude Code session:

| Hook | File | Purpose |
|------|------|---------|
| `SessionStart` | `session-start.ts` | Initialize session buffer |
| `UserPromptSubmit` | `user-prompt-submit.ts` | Inject vault context into prompts |
| `PostToolUse` | `post-tool-use.ts` | Capture tool events to buffer |
| `Stop` | `stop.ts` | Process buffer → extract observations → write to vault |
| `SessionEnd` | `session-end.ts` | Cleanup |

### Two-Phase Processing (Stop Hook)

When a session ends, the buffer is processed in two phases:

1. **Extract observations** — selects a prompt template based on activity pattern (debugging if errors, implementation if >30% edits, exploration if >50% reads, general otherwise), sends to LLM, validates against schema
2. **Generate summary + title** — sends session data through `session-summary.md` and `session-title.md` templates

Only high and medium importance observations are promoted to vault memory notes.

### Prompt Template System

Templates live in `src/capture/prompts/` as markdown files with YAML frontmatter:

```markdown
---
name: debugging
description: For debugging sessions with errors
activity_filter: Read,Edit,Bash
min_activities: 2
---

Your prompt content with {{placeholders}}...
```

`schema.yaml` is the single source of truth for observation types (`gotcha`, `bug_fix`, `decision`, `discovery`, `trade_off`) and activity classifications.

### Vault Location

Resolved by `src/vault/resolve.ts`:

1. `MYCO_VAULT_DIR` env var (with `~/` expansion) — highest priority
2. `.myco/` in the project root — default

For this project, `.claude/settings.json` sets `MYCO_VAULT_DIR=~/.myco/vaults/myco` to keep the vault out of the repo.

### LLM Backends

Configured in `myco.yaml` under `intelligence`:

- **Ollama** — `gpt-oss` for summaries, `nomic-embed-text` for embeddings
- **LM Studio** — user picks models from running instance
- **Cloud** — Claude Haiku via Anthropic API

## Conventions

- TypeScript with strict mode
- ES modules (`"type": "module"` in package.json)
- Plain `tsc` for build (not bundled — native deps like `better-sqlite3` can't be bundled)
- Prompt templates are markdown with `{{placeholder}}` syntax, not Handlebars/Mustache
- Config is YAML (`myco.yaml`), vault notes are markdown with YAML frontmatter
