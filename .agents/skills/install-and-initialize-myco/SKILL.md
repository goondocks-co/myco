---
name: myco:install-and-initialize-myco
description: "Use this skill when installing Myco for the first time, initializing Myco in a new project, or troubleshooting a broken installation. Activate even if the user just asks \"how do I get started with Myco\" or \"how do I add Myco to my project\" without explicitly saying \"install.\" Covers the full lifecycle: bootstrapping the CLI via the install script, running `myco init`, verifying health with `myco doctor`, and managing updates and removal."
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Install and Initialize Myco

## Prerequisites

- Node.js installed (Myco requires Node.js ≥ 18)
- Git repository initialized for the target project
- At least one supported agent installed (Claude Code, Cursor, Windsurf, Codex, Gemini CLI, or VS Code Copilot)

## Steps

### 1. Bootstrap the CLI

Install the Myco CLI globally via the install script:

```bash
curl -fsSL https://myco.sh/install.sh | bash
```

Or via npm:

```bash
npm install -g myco
```

Verify the installation:

```bash
myco --version
```

### 2. Initialize Myco in a Project

Navigate to the project root and run:

```bash
myco init
```

**What `myco init` does:**

1. Creates `.myco/` directory (vault database, config, secrets)
2. Writes `myco.yaml` with project configuration
3. **Seeds the `symbionts` list in `myco.yaml`** — reads each installed symbiont's manifest `defaultEnabled` field via `SymbiontInstaller` and populates the per-project activation list with sensible defaults
4. Registers MCP server entries for each enabled symbiont
5. Installs hook files for each enabled symbiont — hooks use harness env vars (`${CLAUDE_PROJECT_DIR:-.}`, `${CURSOR_PROJECT_DIR:-.}`, etc.) for root-anchoring so they resolve correctly regardless of working directory
6. Creates skill symlinks under `.agents/skills/`
7. Creates thin `AGENTS.md` reference stubs for agents that require their own instruction file
8. Starts the daemon in the background automatically
9. Opens the Myco UI to the **Settings** page (`/settings`) in your browser

**The Myco Agent pipeline is off-by-default after init.** `myco init` writes these keys explicitly to `myco.yaml`:

```yaml
agent:
  scheduled_tasks_enabled: false
  event_tasks_enabled: false
```

No Myco Agent pipeline features (agent pipeline, digest, skill lifecycle) are active until you enable them through the daemon UI after startup.

**The `symbionts` list in `myco.yaml`:**

```yaml
symbionts:
  - claude-code
  - cursor
  # windsurf is installed on this machine but defaultEnabled: false in manifest
  # so it is NOT added to this project's list
```

This list is the **per-project activation gate**. An agent installed on the machine but absent from this list is not active for this project. This decouples machine-level installation from project-level activation.

After `myco init`, review the `symbionts` list and add/remove agents for this project specifically.

### 3. Verify the Installation

Run the health check:

```bash
myco doctor
```

`myco doctor` checks:
- Daemon is running and reachable
- MCP entries are registered correctly for each active symbiont
- Hook files are present and executable
- Vault database is accessible
- No configuration drift between `myco.yaml` and the active symbiont set

Doctor flags agents whose config directory (`.claude/`, `.cursor/`, etc.) exists in the project but whose MCP entry is missing or stale. It does NOT flag agents that are installed globally but have no config directory here — binary presence without a project config directory is not a problem.

**Note:** Doctor warns (rather than errors) when LLM or embedding providers are unconfigured. Data-collection mode is a valid post-init state — unconfigured providers mean the agent pipeline won't run, but session capture continues normally. These warnings are expected immediately after `myco init`.

### 4. Verify the Daemon

`myco init` starts the daemon automatically. It also spawns on each session start. For manual restarts:

```bash
myco restart
```

The daemon runs in the background and handles session capture, agent task scheduling, and team sync. Verify it's running:

```bash
myco stats
```

### 5. Configure Myco Agent (Optional)

After the daemon is running, open the **Myco Agent** section in the daemon UI to enable Myco Agent pipeline features:
- LLM and embedding provider configuration
- Agent pipeline scheduling (skill survey, digest, etc.)
- Team sync settings

The Myco Agent pipeline is intentionally off-by-default so new installations capture data before any processing runs. The `scheduled_tasks_enabled` and `event_tasks_enabled` flags in `myco.yaml` must both be set to `true` (or toggled via the UI) to activate pipeline tasks.

### 6. Managing Updates

```bash
myco update
```

Updates the CLI binary and refreshes hook files, MCP entries, and skill symlinks for all active symbionts. `myco update` respects the existing `symbionts` list in `myco.yaml` — it does not overwrite or reset per-project activation choices.

`myco update` also auto-migrates hook files from the old relative-path format (`node .agents/myco-hook.cjs`) to the current harness env-var format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

### 7. Removing Myco from a Project

```bash
myco remove
```

Stops the daemon, removes hooks, removes MCP entries, removes skill symlinks, and cleans gitignore blocks. The vault (`.myco/` with all session history and spores) is **preserved by default**. To also delete the vault:

```bash
myco remove --remove-vault
```

## Querying Active Symbionts Programmatically

The canonical function for reading which symbionts are active in a project:

```typescript
import { getEnabledSymbiontNames } from './src/config/loader.ts';

const enabled = getEnabledSymbiontNames(config);
// Returns string[] of symbiont names from myco.yaml symbionts list
```

This function is the single source of truth. Do not read `myco.yaml.symbionts` directly or filter inline — previously copy-pasted in 3 places (`update.ts`, `doctor.ts`, daemon API), now canonicalized in `src/config/loader.ts`.

## Common Pitfalls

**`symbionts` list absent from `myco.yaml` after init.** If a symbiont's manifest is missing the `defaultEnabled` field, `SymbiontInstaller` cannot determine the default and the symbiont may be excluded from the initial list. Add it manually after init, or add `defaultEnabled: true/false` to the manifest before running init.

**Machine-level install ≠ project-level activation.** An agent can be installed on the machine but absent from a project's `symbionts` list. `myco doctor` will not flag this. The symbiont is simply not active for that project. Use `myco init` or manually edit `myco.yaml` to add it.

**`myco doctor` mis-reports agents as "unregistered."** This was a historical bug where doctor used binary-on-PATH presence to detect agents. Current behavior: doctor only flags agents whose config directory (`.claude/`, `.cursor/`, etc.) exists in the current project but MCP isn't registered. If you see a false positive, check whether the config directory actually exists.

**`myco doctor` warnings for unconfigured providers are expected, not broken.** Immediately after `myco init`, doctor will warn that LLM/embedding providers are unconfigured. This is data-collection mode — valid and intentional. Configure providers via the daemon UI when ready.

**`myco update` after adding a new symbiont to `symbionts`.** After manually adding a symbiont to the `symbionts` list in `myco.yaml`, run `myco update` to register its MCP entry and install its hooks. The daemon UI is the primary interface — CLI is only for bootstrap operations.

**Old hook format (relative path) after upgrading.** Hooks installed before the harness env-var migration used bare relative paths (`node .agents/myco-hook.cjs`) and fail when the agent invokes them from a different working directory. Run `myco update` to auto-migrate to the current format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

**Don't edit `.myco/` contents directly.** The vault database and daemon state in `.myco/` are managed exclusively by the daemon. Direct edits can corrupt session history or break sync.

**Myco Agent pipeline won't run after init without configuration.** `myco init` writes `scheduled_tasks_enabled: false` and `event_tasks_enabled: false` explicitly to `myco.yaml`. If the agent pipeline isn't running after setup, check the **Myco Agent** section in the daemon UI — LLM provider, embedding provider, and per-task scheduling all require explicit opt-in.

**CLI flags are ignored on re-init of an existing vault.** Provider flags like `--embedding-provider` and `--agent-provider` are scoped exclusively to new vault creation. Running `myco init --agent-provider anthropic` on a project that already has a `.myco/` vault has no effect on provider settings — the existing configuration is preserved. To change providers on an existing vault, use the Settings UI in the daemon.