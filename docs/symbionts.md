# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont installs hooks, an MCP server, skills, and permission settings into its agent's native config files. Symbiont wiring is idempotent — Myco re-applies it safely on every detection tick.

## Quick start

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

After install, the daemon detects every coding agent on your machine and wires Myco into each one's user-global config automatically. The Symbionts page in the dashboard shows current state and lets you review per-agent installation, override per-project, or trigger an immediate re-detection.

## What gets installed

For every selected agent, Myco writes four things into your project:

- **Hooks** — lifecycle event handlers that capture session activity
- **MCP server** — the [Model Context Protocol tools](agent-tools.md) for search, recall, and memory
- **Skills** — symlinks from the agent's native skills directory to `.agents/skills/`
- **Auto-approve rules** — so the agent can run Myco commands without prompting

## Agents

### Claude Code

The primary supported agent with full capture capabilities.

| Component | Location |
|-----------|----------|
| Hooks | `.claude/settings.json` |
| MCP | `.mcp.json` |
| Skills | `.claude/skills/` → `.agents/skills/` |
| Auto-approve | `permissions.allow` in `.claude/settings.json` |
| Plans | `.claude/plans/` |

**Canopy:** receives file-anatomy hints — exports, imports, and a short summary — just before reading source files, so the agent can orient on what's in a file without paying for the full read.

### Cursor

Full MCP and skills support. Hooks are pending Cursor's hook system maturation.

| Component | Location |
|-----------|----------|
| MCP | `.cursor/mcp.json` |
| Skills | `.cursor/skills/` → `.agents/skills/` |
| Auto-approve | `chat.tools.terminal.autoApprove` in `.cursor/settings.json` |
| Plans | `.cursor/plans/` |

### Codex (OpenAI)

Hooks and MCP via JSON and TOML configuration. Skills via the `.agents/skills/` standard.

| Component | Location |
|-----------|----------|
| Hooks | `.codex/hooks.json` |
| MCP | `.codex/config.toml` |
| Skills | `.agents/skills/` (native) |

**Canopy:** receives file-anatomy hints — exports, imports, and a short summary — just before reading source files, so the agent can orient on what's in a file without paying for the full read.

### VS Code Copilot

| Component | Location |
|-----------|----------|
| Hooks | `.github/hooks/myco-hooks.json` |
| MCP | `.vscode/mcp.json` |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `chat.tools.terminal.autoApprove` in `.vscode/settings.json` |

### Google Antigravity

Antigravity replaced the retired Gemini CLI. Configuration ships as a plugin bundle under `~/.gemini/config/plugins/myco/` (Antigravity reuses the `~/.gemini/` user-home directory). Existing Gemini sessions are remapped to `antigravity` automatically on schema v47.

| Component | Location |
|-----------|----------|
| Hooks (workspace) | `.agents/plugins/myco/hooks.json` |
| Hooks (global) | `~/.gemini/config/plugins/myco/hooks.json` |
| MCP (workspace) | `.agents/plugins/myco/mcp_config.json` |
| MCP (global) | `~/.gemini/config/plugins/myco/mcp_config.json` |
| Skills (plugin) | `~/.gemini/config/plugins/myco/skills/` |
| Plans | `.agents/plugins/myco/plans/` |

### Windsurf

| Component | Location |
|-----------|----------|
| Hooks | `.windsurf/hooks.json` |
| MCP | `~/.codeium/windsurf/mcp_config.json` (user-level only) |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `windsurf.cascadeCommandsAllowList` in `.windsurf/settings.json` |
| Plans | `~/.windsurf/plans/` (global) |

### OpenCode

The first plugin-based symbiont. OpenCode has no JSON hook file — hooks are delivered as a TypeScript plugin that opencode's Bun runtime loads at startup.

| Component | Location |
|-----------|----------|
| Plugin | `.opencode/plugins/myco.ts` |
| MCP | `opencode.json` |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `permission.bash` in `opencode.json` |
| Plans | `.opencode/plans/` |

**Plan mode note:** OpenCode's Plan mode only allows `edit` on existing files under `.opencode/plans/*.md`. To author a new plan in Plan mode, create the file first in Build mode (`touch .opencode/plans/my-plan.md`) before switching to Plan mode.

### Pi

A plugin-based symbiont like OpenCode. Pi has no JSON hook file or native MCP — hooks and Myco tools are delivered as a TypeScript extension that pi's runtime loads at startup.

| Component | Location |
|-----------|----------|
| Extension | `.pi/extensions/myco/index.ts` |
| MCP tools | Registered via `pi.registerTool()` (no separate MCP config) |
| Skills | `.agents/skills/` (native) |
| Plans | `.pi/plans/` |

## Removing Myco

```bash
myco remove                 # Removes hooks, MCP, skills, settings (preserves vault)
myco remove --remove-vault  # Also deletes the vault and all session data
```

The uninstaller only removes entries Myco installed, preserving any non-Myco configuration in those files.

## Adding a new agent

Myco's symbiont system is manifest-driven — adding support for a new agent is typically a YAML manifest and a set of JSON templates, no code changes required for JSON-hook agents. See the [`add-symbiont` skill](../.agents/skills/add-symbiont/SKILL.md) for a step-by-step walkthrough.
