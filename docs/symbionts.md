# Supported Agents

Myco integrates with coding agents through **symbionts** — a term inspired by [mycorrhizal symbiosis](https://en.wikipedia.org/wiki/Mycorrhizal_network), the relationship between fungi and their host trees. Each symbiont has a YAML manifest that declares its capabilities and a set of JSON templates that define what gets installed into projects.

## Quick Start

```bash
curl -fsSL https://myco.sh/install.sh | sh
cd your-project
myco init
```

`myco init` shows all available agents and lets you choose which to configure. Detected agents are pre-checked.

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

### OpenCode

The first plugin-based symbiont. OpenCode has no JSON hook file — hooks are delivered as a verbatim TypeScript plugin (`.opencode/plugins/myco.ts`) that opencode's Bun runtime loads at startup. The plugin communicates directly with the Myco daemon over HTTP; no subprocess spawns and no hook CLI.

| Component | Location |
|-----------|----------|
| Hooks | `.opencode/plugins/myco.ts` (plugin file, 6 event hooks) |
| Plugin deps | `.opencode/package.json` (declares `@opencode-ai/plugin`) |
| MCP | `opencode.json` under the non-standard `mcp` key (not `mcpServers`) |
| Skills | `.agents/skills/` (native) |
| Auto-approve | `permission.bash` in `opencode.json` |
| Plans | `.opencode/plans/` |
| Transcripts | — (fetched via SDK at stop time; no on-disk transcript adapter) |

**Handler coverage:**
- `event: session.created` → session register + digest injection via `client.session.prompt({ noReply: true, parts: [{ synthetic: true }] })`
- `event: session.deleted` → session unregister
- `event: session.idle` → stop event with response summary
- `chat.message` → user prompt capture
- `tool.execute.after` → tool use capture (forwards `input.args` so `filePath` reaches plan-capture)
- `experimental.session.compacting` → pushes digest into `output.context` so project knowledge survives compaction

**Two new manifest fields** were introduced to fit OpenCode cleanly alongside the JSON-hook symbionts without special-casing:
- `hooksFormat: plugin-file` — selects verbatim template copy instead of JSON merge
- `pluginPackageTarget: .opencode/package.json` — writes a Bun-installable deps manifest
- `mcpServersKey: mcp` — opencode's non-standard MCP top-level key

**Plan mode UX note:** OpenCode's Plan mode disables the `write` tool entirely and only allows `edit` on existing files under `.opencode/plans/*.md`. To author a new plan in Plan mode, the plan file must already exist on disk — create it first in Build mode (`touch .opencode/plans/my-plan.md`) before switching to Plan mode.

**Context injection** is session-start only (digest at `session.created`). Per-turn spore injection via `chat.message` is intentionally deferred pending more research on OpenCode's re-entrancy semantics; in the meantime, agents can fetch targeted context on demand via the `myco_context` and `myco_search` MCP tools.

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

Agents that read `.agents/skills/` natively (Codex, VS Code, Gemini, Windsurf, OpenCode) don't need agent-specific symlinks.

## Adding a New Agent

1. Create a manifest at `src/symbionts/manifests/<name>.yaml` declaring capabilities — `loadManifests()` auto-discovers it.
2. Create templates at `src/symbionts/templates/<name>/`:
   - **JSON-hook agents** (Claude Code, Cursor, Codex, Gemini, VS Code, Windsurf): `hooks.json`, `mcp.json`, `settings.json`.
   - **Plugin-based agents** (OpenCode): `plugin.ts`, `package.json`, `mcp.json`, `settings.json`. Declare `hooksFormat: plugin-file` and `pluginPackageTarget` in the manifest.
3. For agents with non-standard MCP config keys (e.g., OpenCode uses `"mcp"` instead of `"mcpServers"`), set `mcpServersKey` in the manifest.
4. Optionally implement a transcript adapter in `src/symbionts/<name>.ts` — skip for agents that don't expose on-disk transcripts (OpenCode relies on SDK-fetched messages and buffer reconstruction).

The installer is generic — it reads the manifest and templates without agent-specific code paths. See the [`add-symbiont` skill](../.agents/skills/add-symbiont/SKILL.md) for a step-by-step walkthrough.

## Removing Myco

```bash
myco remove              # Removes hooks, MCP, skills, settings (preserves vault)
myco remove --remove-vault  # Also deletes the vault and all session data
```

The uninstaller is template-driven: it loads the same templates used for installation and removes matching entries, preserving any non-Myco configuration.
