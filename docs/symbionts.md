# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont wires hooks, an MCP server, skills, and permission settings into its agent's native configuration files. Symbiont wiring is idempotent — Myco re-applies it safely on every detection tick.

## Install once, every project works

Symbionts install at each agent's **global** configuration location, not per-project. A single global install means:

- Open any project on disk — Myco's hooks fire and the project auto-registers to your default Grove on the first invocation. No per-project setup.
- Two global launchers — `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs` — bridge every agent's hook and MCP systems to the daemon.
- Project-local launchers can override the global ones when a project needs a custom binary path.
- The capture buffer lives under `~/.myco/buffer/` (per-Grove subdirectories).

See [Quickstart](quickstart.md) for the install command and [Upgrade](upgrade.md) for migration from per-project installs.

After install, the daemon detects every coding agent on your machine and wires Myco into each one's user-global config automatically. The **Symbionts page** in the dashboard shows current state, lets you override Myco on a per-project basis, and lets you trigger an immediate re-detection.

## What gets installed

For every detected agent, Myco writes the same four things — into the agent's global config rather than into your project:

- **Hooks** — lifecycle event handlers that capture session activity and stream injection context.
- **MCP server** — the [Model Context Protocol tools](agent-tools.md) for search, recall, and memory.
- **Skills** — symlinks from the agent's native skills directory to Myco's canonical skill store, so [auto-generated skills](skills.md) reach every agent.
- **Auto-approve rules** — so the agent can run Myco's MCP tools without prompting.

Myco's edits to shared config files (Codex's `config.toml`, OpenCode's `opencode.json`, Copilot's VS Code `settings.json`) preserve any pre-existing user keys. `myco remove` reverses Myco's contributions and leaves your other settings intact.

## Agents

Eight symbionts ship today. Each entry below lists the **global** install targets — the per-project workspace targets are still honored when present, but global is the default.

### Claude Code

The reference symbiont with full capture and injection capabilities.

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.claude/settings.json` |
| MCP | `~/.claude/settings.json` |
| Skills | `~/.claude/skills/` → Myco's skill store |
| Plans | `~/.claude/plans/` (also project-local `.claude/plans/`) |

Hook templates include `matcher: ""` on every hook group (enforced by an invariant test). Cortex preamble injection fires on `SessionStart`; Canopy injection fires on `PreToolUse` for `Read`.

### Cursor

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.cursor/hooks.json` |
| MCP | `~/.cursor/mcp.json` |
| Skills | `~/.cursor/skills/` → Myco's skill store |
| Plans | `~/.cursor/plans/` (also project-local) |

Cursor hook commands include a `cd ${CURSOR_PROJECT_DIR:-.}` prefix (invariant-tested across all global hook templates for the symbiont's project-dir env var).

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

Copilot's `PreToolUse` carries Canopy file-anatomy injections for `read_file` and known read-style `run_in_terminal` invocations.

### Google Antigravity

The successor to Gemini IDE. Full CLI + IDE + app coverage shipped as a plugin bundle.

| Component | Global location |
|-----------|-----------------|
| Plugin manifest | `~/.gemini/config/plugins/myco/plugin.json` |
| Hooks | `~/.gemini/config/plugins/myco/hooks.json` |
| MCP | `~/.gemini/config/plugins/myco/mcp_config.json` |
| Skills | `~/.gemini/antigravity/skills/` |

Hook surface mirrors the others: `PreInvocation` transcript-read for user-prompt capture; `PostInvocation` spore injection with per-prompt dedup; `Stop` for processor reconciliation. Cortex injection fires on the first `PreInvocation` per `conversationId` (gated by `invocationNum === 0`).

Antigravity reuses the `~/.gemini/` user-home directory it inherited from Gemini IDE. On first detection, Myco performs a **one-time data remap** that migrates any legacy `~/.gemini/` Myco artifacts and cleans stale `trusted_hooks.json` entries.

### Windsurf

| Component | Global location |
|-----------|-----------------|
| Hooks | `~/.codeium/windsurf/hooks.json` |
| MCP | `~/.codeium/windsurf/mcp_config.json` |
| Skills | `~/.codeium/windsurf/skills/` → Myco's skill store |
| Plans | `~/.windsurf/plans/` |

Manifest `hookFields` are aligned with Cascade's current payload schema (`trajectory_id` for session, `tool_info.*` for event-specific data).

### OpenCode

The first plugin-based symbiont. OpenCode has no JSON hook file — hooks ship as a TypeScript plugin loaded by opencode's Bun runtime at startup.

| Component | Global location |
|-----------|-----------------|
| Plugin | `~/.config/opencode/plugins/myco.ts` |
| MCP | `~/.config/opencode/opencode.json` (key: `mcp`, remote/URL transport) |
| Skills | `~/.config/opencode/skills/` → Myco's skill store |

**Plan mode note:** OpenCode's Plan mode only allows `edit` on existing files under `.opencode/plans/*.md`. To author a new plan in Plan mode, create the file first in Build mode (`touch .opencode/plans/my-plan.md`) before switching to Plan mode.

### Pi

A plugin-based symbiont like OpenCode. Pi has no JSON hook file and no native MCP — hooks and Myco tools ship as a TypeScript extension loaded by Pi's runtime at startup. Tools register via `pi.registerTool()`.

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

## Adding a new agent

Myco's symbiont system is manifest-driven. Most JSON-hook agents are a YAML manifest plus a set of JSON templates, no code changes required. See the [`add-symbiont` skill](../.agents/skills/add-symbiont/SKILL.md) for a step-by-step walkthrough; the manifest schema fields you'll touch include `detectionDir`, `globalHooksTarget`, `globalMcpTarget` (string or string[]), `globalSkillsTarget`, and `globalSettingsTarget`.
