# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont connects Myco to an agent's native context, tools, skills, and permissions while preserving that agent's own memory, reasoning, and workflow.

## Install once, every project works

Symbionts connect once per user, not once per project. A single install means:

- Open any git project on disk and Myco registers it to your default Grove when a supported agent starts working there.
- Myco connects every detected agent to the local service from that agent's normal user settings.
- Project-local identity can be committed from the dashboard when you want teammates to share it.

See [Quickstart](quickstart.md) for the install command and [Upgrade](upgrade.md) for migration from per-project installs.

After install, Myco detects coding agents on your machine and connects them automatically. The **Symbionts page** in the dashboard shows current state, lets you override Myco on a per-project basis, and lets you trigger an immediate re-detection.

## What gets installed

For every detected agent, Myco contributes the same four things:

- **Session capture** — lifecycle events that capture session activity and route context.
- **MCP server** — the [Model Context Protocol tools](agent-tools.md) for search, recall, and project knowledge.
- **Skills** — symlinks from the agent's native skills directory to Myco's canonical skill store, so [auto-generated skills](skills.md) reach every agent.
- **Auto-approve rules** — so the agent can run Myco's MCP tools without prompting.

Myco's edits to shared config files (Codex's `config.toml`, OpenCode's `opencode.json`, Copilot's VS Code `settings.json`) preserve any pre-existing user keys. `myco remove` reverses Myco's contributions and leaves your other settings intact.

## Agents

Eight symbionts ship today. Each entry below lists the **global** install targets. Per-project workspace targets are still honored when present, but global is the default.

### Claude Code

The reference symbiont with full capture and injection capabilities.

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.claude/settings.json` |
| MCP | `~/.claude/settings.json` |
| Skills | `~/.claude/skills/` → Myco's skill store |
| Plans | `~/.claude/plans/` (also project-local `.claude/plans/`) |

Cortex project briefings run at session start; Canopy context appears before supported file reads.

### Cursor

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.cursor/hooks.json` |
| MCP | `~/.cursor/mcp.json` |
| Skills | `~/.cursor/skills/` → Myco's skill store |
| Plans | `~/.cursor/plans/` (also project-local) |

Cursor supports session capture and context routing from the project directory Cursor reports for the current workspace.

### Codex (OpenAI)

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.codex/hooks.json` |
| MCP | `~/.codex/config.toml` |
| Skills | `~/.codex/skills/` → Myco's skill store |
| Settings | `~/.codex/config.toml` |

Codex's `config.toml` is shared with the user — Myco upserts only its own keys. The `[features].hooks` key (and any other pre-existing user keys) is preserved across `myco remove` cycles.

### GitHub Copilot

One symbiont, two MCP targets. The `copilot` binary is the terminal CLI; the same agent runtime drives the VS Code Copilot extension. They share hooks and skills, but the two surfaces read MCP from different files.

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.copilot/hooks/myco-hooks.json` |
| MCP (CLI) | `~/.copilot/mcp-config.json` (key: `mcpServers`) |
| MCP (VS Code) | `~/Library/Application Support/Code/User/mcp.json` (key: `servers`) |
| Skills | `~/.copilot/skills/` → Myco's skill store |
| Settings | `.vscode/settings.json` |
| Instructions | `.github/copilot-instructions.md` |

Copilot receives Canopy file-anatomy context for supported read-style tool use.

### Google Antigravity

The successor to Gemini IDE. Full CLI + IDE + app coverage shipped as a plugin bundle.

| Component | Global location |
|-----------|-----------------|
| Plugin manifest | `~/.gemini/config/plugins/myco/plugin.json` |
| Hooks | `~/.gemini/config/plugins/myco/hooks.json` |
| MCP | `~/.gemini/config/plugins/myco/mcp_config.json` |
| Skills | `~/.gemini/antigravity/skills/` |

Antigravity supports prompt capture, context routing, and session reconciliation across CLI, IDE, and app surfaces.

Antigravity reuses the `~/.gemini/` user-home directory it inherited from Gemini IDE. On first detection, Myco performs a **one-time data remap** that migrates any legacy `~/.gemini/` Myco artifacts and cleans stale `trusted_hooks.json` entries.

### Windsurf

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.codeium/windsurf/hooks.json` |
| MCP | `~/.codeium/windsurf/mcp_config.json` |
| Skills | `~/.codeium/windsurf/skills/` → Myco's skill store |
| Plans | `~/.windsurf/plans/` |

Windsurf supports hook capture and skill discovery through Cascade's current agent surfaces.

### OpenCode

The first plugin-based symbiont. OpenCode has no JSON hook file — hooks ship as a TypeScript plugin loaded by opencode's Bun runtime at startup.

| Component | Global location |
|-----------|-----------------|
| Plugin | `~/.config/opencode/plugins/myco.ts` |
| MCP | `~/.config/opencode/opencode.json` (key: `mcp`, remote/URL transport) |
| Skills | `~/.config/opencode/skills/` → Myco's skill store |

**Plan mode note:** OpenCode's Plan mode only allows `edit` on existing files under `.opencode/plans/*.md`. To author a new plan in Plan mode, create the file first in Build mode (`touch .opencode/plans/my-plan.md`) before switching to Plan mode.

### Pi

A plugin-based symbiont like OpenCode. Pi has no JSON hook file and no native MCP, so Myco connects through a TypeScript extension loaded by Pi's runtime at startup.

| Component | Global location |
|-----------|-----------------|
| Extension | `~/.pi/agent/extensions/myco/index.ts` |
| Skills | `~/.pi/agent/skills/` → Myco's skill store |

## Per-project overrides

Disable or override a symbiont in a specific project from the dashboard's **Symbionts page**. Overrides are UI-driven; there is no equivalent CLI flag.

## Removing Myco

```bash
myco remove           # Remove Myco's contributions to every agent's global config
myco remove --purge   # Also delete ~/.myco/ (vault, buffer, launchers)
```

The uninstaller only removes entries Myco installed — pre-existing user keys in shared config files are preserved.

## Platform support

macOS is the primary supported platform for Myco 1.0. Linux and Windows packages are published for early testing, but their service and launcher behavior is experimental.
