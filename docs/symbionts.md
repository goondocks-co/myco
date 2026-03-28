# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont has a YAML manifest that declares its capabilities and a set of JSON templates that define what gets installed into projects.

## Quick Start

```bash
curl -fsSL https://myco.sh/install.sh | sh
cd your-project
myco init
```

The wizard shows all available agents and lets you choose which to configure. Detected agents are pre-checked.

## How Registration Works

When you run `myco init`, the **SymbiontInstaller** writes configuration directly to each agent's project files:

- **Hooks** — lifecycle event handlers that capture session activity
- **MCP server** — Model Context Protocol server providing search, recall, and memory tools
- **Skills** — agent instructions for using Myco (symlinked through `.agents/skills/`)
- **Settings** — auto-approve rules so the agent can run Myco commands without prompting

All operations are idempotent. Running `myco init` or `myco update` again safely updates existing configuration.

## Agents

### Claude Code

The primary supported agent with full capture capabilities.

| Component | Location |
|-----------|----------|
| Hooks | `.claude/settings.json` (12 events) |
| MCP | `.mcp.json` |
| Skills | `.claude/skills/` → `.agents/skills/` |
| Auto-approve | `permissions.allow` in `.claude/settings.json` |
| Plans | `.claude/plans/` |
| Transcripts | JSONL in `~/.claude/projects/` |

### Cursor

Full MCP and skills support. Hooks support is pending Cursor's hook system maturation.

| Component | Location |
|-----------|----------|
| Hooks | — (not yet supported) |
| MCP | `.cursor/mcp.json` |
| Skills | `.cursor/skills/` → `.agents/skills/` |
| Auto-approve | `chat.tools.terminal.autoApprove` in `.cursor/settings.json` |
| Plans | `.cursor/plans/` |
| Transcripts | JSONL/TXT in `~/.cursor/projects/` |

### Codex (OpenAI)

Hooks and MCP via TOML configuration. Skills via the `.agents/skills/` standard.

| Component | Location |
|-----------|----------|
| Hooks | `.codex/hooks.json` (4 events) |
| MCP | `.codex/config.toml` (TOML format) |
| Skills | `.agents/skills/` (native) |
| Auto-approve | — (approval system TBD) |
| Plans | — (feature requested: [openai/codex#12878](https://github.com/openai/codex/issues/12878)) |
| Transcripts | TBD (adapter pending) |

### VS Code Copilot

Hooks in `.github/hooks/`, MCP in `.vscode/mcp.json`. VS Code natively reads skills from `.agents/skills/`.

| Component | Location |
|-----------|----------|
| Hooks | `.github/hooks/myco-hooks.json` (7 events) |
| MCP | `.vscode/mcp.json` |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `chat.tools.terminal.autoApprove` in `.vscode/settings.json` |
| Plans | — |
| Transcripts | TBD (adapter pending) |

### Gemini CLI

All configuration shares a single file (`.gemini/settings.json`). Uses different hook event names (e.g., `BeforeAgent`, `AfterAgent`) with millisecond timeouts.

| Component | Location |
|-----------|----------|
| Hooks | `.gemini/settings.json` (6 events) |
| MCP | `.gemini/settings.json` |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `coreTools` in `.gemini/settings.json` |
| Plans | `.gemini/plans/` |
| Transcripts | TBD (adapter pending) |

### Windsurf

Hooks use a flat format with snake_case event names. MCP is user-level only (not project-local). Skills via `.agents/skills/`.

| Component | Location |
|-----------|----------|
| Hooks | `.windsurf/hooks.json` (4 events, flat format) |
| MCP | — (user-level only: `~/.codeium/windsurf/mcp_config.json`) |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `windsurf.cascadeCommandsAllowList` in `.windsurf/settings.json` |
| Plans | `~/.windsurf/plans/` (global) |
| Transcripts | JSONL via `post_cascade_response_with_transcript` hook |

## Skills Architecture

Skills are installed once to `.agents/skills/` — the canonical cross-agent location — and symlinked to each agent's native skills directory:

```
.agents/skills/
  myco          → /path/to/node_modules/@goondocks/myco/skills/myco
  myco-curate   → /path/to/node_modules/@goondocks/myco/skills/myco-curate
  rules         → /path/to/node_modules/@goondocks/myco/skills/rules

.claude/skills/
  myco          → ../../.agents/skills/myco          (symlink to canonical)
```

Agents that read `.agents/skills/` natively (Codex, VS Code, Gemini, Windsurf) don't need agent-specific symlinks.

## Adding a New Agent

1. Create a manifest at `src/symbionts/manifests/<name>.yaml` declaring capabilities
2. Create templates at `src/symbionts/templates/<name>/` (hooks.json, mcp.json, settings.json)
3. Optionally implement a transcript adapter in `src/symbionts/<name>.ts`

The installer is generic — it reads the manifest and templates without agent-specific code paths.

## Removing Myco

```bash
myco remove              # Removes hooks, MCP, skills, settings (preserves vault)
myco remove --remove-vault  # Also deletes the vault and all session data
```

The uninstaller is template-driven: it loads the same templates used for installation and removes matching entries, preserving any non-Myco configuration.
