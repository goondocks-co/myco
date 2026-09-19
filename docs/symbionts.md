# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont connects Myco to an agent's native context, tools, skills, and permissions while preserving that agent's own memory, reasoning, and workflow.

## Two ways in

Myco installs in two independent halves, and either works on its own.

**The plugin** carries the skills and the Myco tools. Install it from your agent's own plugin marketplace, paste in your deployment's URL and an access key, and the tools answer. Nothing is captured, and that is a complete configuration for reading — an agent can search what your team already knows and record what it learns.

**The installer** adds the rest: session capture, plan capture, import, and the worker. It places the `myco` binary and writes each agent's hooks with the binary's absolute path, which is the reason a plugin cannot do it — a downloadable bundle has neither the binary nor the path it will live at.

The access key the plugin uses reaches one project, is minted by a deployment administrator, and expires after ninety days by default. The `/myco-setup` skill walks through installing the second half, and ships with the plugin so it is there before the binary is.

## Connecting a project to your deployment

Join a project once per machine, and name the agent you use there:

```sh
myco member join https://your-deployment.example.com --project <project-id> --token-stdin --provision codex
```

To connect another agent to a project you have already joined, or to repair one, run `myco member provision` from the project. It uses the membership you already have, so no token needs to be supplied or changed:

```sh
myco member provision claude-code
```

Both commands write the agent's capture hooks and its Myco MCP entry into the project's own agent config. For Codex (`.codex/config.toml`) and Claude Code (`.mcp.json`) the entry points the agent straight at your deployment's MCP address. When the agent connects, it asks `myco` for the sign-in details, so no token is written to the file, and a renewed token is picked up without restarting the agent. That sign-in only works on the deployment the entry names: after you rejoin the project to a different deployment, run `myco member provision` again.

Both agents ask before they trust a project's config. Codex loads a project's `.codex/config.toml` only for a project it trusts. Claude Code asks you to trust the folder and approve the project's MCP server the first time you open it.

Codex combines a `myco` server in your user-level `~/.codex/config.toml` with the project's, and a mismatched pair stops Codex from loading its configuration at all. If your user-level file has a `myco` server that starts a local command or signs in some other way, or the file cannot be read, provisioning stops before changing anything and names the file. Fix the file, or remove that entry if no other project needs it, then run `myco member provision codex` again.

For OpenCode and Pi, `myco member provision opencode` or `myco member provision pi` writes Myco's plugin into the project itself (`.opencode/plugins/myco.ts`, `.pi/extensions/myco/index.ts`). The Myco plugin installed for all your projects steps aside in a project that has one, so each session is captured once, and your other projects keep the plugin they have. If the installed Myco plugin is from a version that does not step aside, provisioning stops before changing anything and asks you to update that Myco install first. Pi loads a project's extension only after you trust the project in Pi (`/trust`); until then the Myco extension installed for all projects keeps capturing. `myco member leave` removes the project's plugin again. OpenCode's Myco tools still come from the Myco entry in your user-level OpenCode config, not from your deployment.

Cursor connects to Myco through a local `myco` process, not directly to your deployment. Cursor's remote MCP entries accept fixed headers or OAuth sign-in, and Myco does not offer OAuth sign-in for MCP, so there is no way for a remote Cursor entry to pick up a renewed member token.

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

Myco's edits to shared config files (Codex's `config.toml`, Cline's `cline_mcp_settings.json`, OpenCode's `opencode.json`, Copilot's VS Code `settings.json`) preserve any pre-existing user keys. `myco remove` reverses Myco's contributions and leaves your other settings intact.

## Agents

Nine symbionts ship today. Each entry below lists the **global** install targets — Myco wires into each agent's user-level config, so a single install covers every project on your machine.

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
| Skills | `~/.agents/skills/` → Myco's skill store |
| Plans | `~/.cursor/plans/` (also project-local) |

Cursor supports session capture and context routing from the project directory Cursor reports for the current workspace.

### Codex (OpenAI)

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.codex/hooks.json` |
| MCP | `~/.codex/config.toml` |
| Skills | `~/.agents/skills/` → Myco's skill store |
| Settings | `~/.codex/config.toml` |

Codex's `config.toml` is shared with the user — Myco upserts only its own keys. The `[features].hooks` key (and any other pre-existing user keys) is preserved across `myco remove` cycles.

### Cline

A plugin-based symbiont. Cline loads a TypeScript plugin from `.cline/plugins/`, and Myco uses it for capture, tools and context.

Cline keeps its conversation in two JSON documents it rewrites as the session grows, which cannot be shipped incrementally. Myco's plugin therefore records the session as it happens and hands that record to Myco, so your Cline work is searchable alongside every other agent's.

| Component | Global location |
|-----------|-----------------|
| Plugin | `~/.cline/plugins/myco.ts` |
| MCP | `~/.cline/data/settings/cline_mcp_settings.json` (also mirrored to `~/.cline/mcp.json`) |
| Skills | `~/.cline/skills/` → Myco's skill store |

### GitHub Copilot

One symbiont, two MCP targets. The `copilot` binary is the terminal CLI; the same agent runtime drives the VS Code Copilot extension. They share hooks and skills, but the two surfaces read MCP from different files.

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.copilot/hooks/myco-hooks.json` |
| MCP (CLI) | `~/.copilot/mcp-config.json` (key: `mcpServers`) |
| MCP (VS Code) | `~/Library/Application Support/Code/User/mcp.json` (key: `servers`) |
| Skills | `~/.agents/skills/` → Myco's skill store |
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
| Skills | `~/.agents/skills/` |

Antigravity supports prompt capture, context routing, and session reconciliation across CLI, IDE, and app surfaces.

Antigravity reuses the `~/.gemini/` user-home directory it inherited from Gemini IDE. On first detection, Myco performs a **one-time data remap** that migrates any legacy `~/.gemini/` Myco artifacts and cleans stale `trusted_hooks.json` entries.

### Devin Desktop

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.codeium/windsurf/hooks.json` |
| MCP | `~/.codeium/windsurf/mcp_config.json` |
| Skills | `~/.agents/skills/` → Myco's skill store |
| Plans | `~/.windsurf/plans/` |

Devin Desktop — the editor formerly known as Windsurf — supports hook capture and skill discovery through Cascade's current agent surfaces. Its config still lives under the legacy `~/.codeium/windsurf/` and `~/.windsurf/` paths shown above.

### OpenCode

The first plugin-based symbiont. OpenCode has no JSON hook file — Myco ships a TypeScript plugin loaded by opencode's Bun runtime at startup.

OpenCode stores each message and each part of a session as its own file, which cannot be shipped incrementally. Myco's plugin records the session as it happens and hands that record to Myco, so your OpenCode work is searchable alongside every other agent's.

| Component | Global location |
|-----------|-----------------|
| Plugin | `~/.config/opencode/plugins/myco.ts` |
| MCP | `~/.config/opencode/opencode.json` (key: `mcp`, local stdio launcher) |
| Skills | `~/.agents/skills/` → Myco's skill store |

**Plan mode note:** OpenCode's Plan mode only allows `edit` on existing files under `.opencode/plans/*.md`. To author a new plan in Plan mode, create the file first in Build mode (`touch .opencode/plans/my-plan.md`) before switching to Plan mode.

### Pi

A plugin-based symbiont like OpenCode. Pi has no JSON hook file and no MCP, so Myco connects through a TypeScript extension loaded by Pi's runtime at startup, and registers Myco's tools directly with Pi.

Pi keeps its own session record, so Myco reads it and never alters or removes it.

| Component | Global location |
|-----------|-----------------|
| Extension | `~/.pi/agent/extensions/myco/index.ts` |
| Skills | `~/.agents/skills/` → Myco's skill store |

## Per-project overrides

Disable or override a symbiont in a specific project from the dashboard's **Symbionts page**. Overrides are UI-driven; there is no equivalent CLI flag.

## Removing Myco

```bash
myco remove           # Remove Myco's contributions to every agent's global config
myco remove --purge   # Also delete ~/.myco/ (vault, buffer, launchers)
```

The uninstaller only removes entries Myco installed — pre-existing user keys in shared config files are preserved.

## Platform support

macOS is the primary supported platform. Linux and Windows are in beta. On Windows, only x64 is supported — Windows on ARM (which runs the x64 build under emulation) is not supported.
