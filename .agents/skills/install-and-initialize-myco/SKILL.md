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
2. Writes `.myco/myco.yaml` with project configuration
3. **Seeds the `symbionts` list in `.myco/myco.yaml`** — reads each installed symbiont's manifest `defaultEnabled` field via `SymbiontInstaller` and populates the per-project activation list with sensible defaults
4. Registers MCP server entries for each enabled symbiont
5. Installs hook files for each enabled symbiont — hooks use harness env vars (`${CLAUDE_PROJECT_DIR:-.}`, `${CURSOR_PROJECT_DIR:-.}`, etc.) for root-anchoring so they resolve correctly regardless of working directory
6. Creates skill symlinks under `.agents/skills/`
7. Creates thin `AGENTS.md` reference stubs for agents that require their own instruction file
8. Starts the daemon in the background automatically
9. Opens the Myco UI to the **Settings** page (`/settings`) in your browser

**The Myco Agent pipeline is off-by-default after init.** `myco init` writes these keys explicitly to `.myco/myco.yaml`:

```yaml
agent:
  scheduled_tasks_enabled: false
  event_tasks_enabled: false
```

No Myco Agent pipeline features (agent pipeline, digest, skill lifecycle) are active until you enable them through the daemon UI after startup.

**The `symbionts` list in `.myco/myco.yaml`:**

```yaml
symbionts:
  - claude-code
  - cursor
  # windsurf is installed on this machine but defaultEnabled: false in manifest
  # so it is NOT added to this project's list
```

This list is the **per-project activation gate**. An agent installed on the machine but absent from this list is not active for this project. This decouples machine-level installation from project-level activation.

After `myco init`, review the `symbionts` list in `.myco/myco.yaml` and add/remove agents for this project specifically.

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
- No configuration drift between `.myco/myco.yaml` and the active symbiont set

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

The Myco Agent pipeline is intentionally off-by-default so new installations capture data before any processing runs. The `scheduled_tasks_enabled` and `event_tasks_enabled` flags in `.myco/myco.yaml` must both be set to `true` (or toggled via the UI) to activate pipeline tasks.

### 6. Managing Updates

```bash
myco update
```

Updates the CLI binary and refreshes hook files, MCP entries, and skill symlinks for all active symbionts. `myco update` respects the existing `symbionts` list in `.myco/myco.yaml` — it does not overwrite or reset per-project activation choices.

`myco update` also auto-migrates hook files from the old relative-path format (`node .agents/myco-hook.cjs`) to the current harness env-var format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

### 7. Removing Myco from a Project

```bash
myco remove
```

Stops the daemon, removes hooks, removes MCP entries, removes skill symlinks, and cleans gitignore blocks. The vault (`.myco/` with all session history and spores) is **preserved by default**. To also delete the vault:

```bash
myco remove --remove-vault
```

## Development Environment Setup

When developing Myco itself, you need the project's hooks and daemon to invoke your locally-built binary rather than the globally-installed `myco`. This is essential for dogfooding unreleased changes.

### Prerequisites for Dev Setup

- The project is built: `packages/myco/dist/src/cli.js` must exist. Run `make build` first if it doesn't.
- You are in the repository root (`/Users/chris/Repos/myco` or equivalent).
- The globally-installed `myco` is already working (used as the fallback when `.myco/runtime.command` is absent).

### Configure Dev Binary

```bash
make dev-link
```

This creates four symlinks in `~/.local/bin/` and writes `.myco/runtime.command`:

- **`myco-dev`** — symlink to `packages/myco/dist/src/cli.js`. Used for dogfooding agent and core daemon changes.
- **`myco-team-dev`** — symlink to `packages/myco-team/dist/main.js`. Used for manual testing of team sync operator flows.
- **`myco-collective-dev`** — symlink to `packages/myco-collective/dist/main.js`. Used for manual testing of Collective operator flows.
- **`myco-run`** — symlink to `packages/myco/bin/myco-run`. Stable operator entrypoint for MCP server mode; never delete this even if it appears unused.

`.myco/runtime.command` is set to `myco-dev`. The hook guard only uses this file to choose the main Myco binary; it does not switch team or collective operator CLIs.

`.agents/myco-hook.cjs` reads `.myco/runtime.command` at every hook invocation and substitutes that path for the default `myco` command. Because the read happens at hook-fire time (not at shell startup), no shell restart is required.

### Verify Dev Configuration

```bash
myco-dev doctor
```

The output should report the dev binary path. If it falls back to the global binary path, check that `.myco/runtime.command` exists and contains the correct path.

Confirm `.myco/runtime.command` is gitignored:

```bash
grep 'runtime.command' packages/myco/src/cli/shared.ts
```

You should see it listed in `VAULT_GITIGNORE`. The file holds your machine's absolute path, so it must never be committed.

### Build After Code Changes

After editing source files, rebuild:

```bash
make build
```

Because the symlinks point to your repo's built files, the rebuilt artifact is immediately available without re-running `make dev-link`.

### Revert to Production Binary

```bash
make dev-unlink
```

This removes `.myco/runtime.command` and deletes the `~/.local/bin/myco-*` symlinks. Hooks fall back to the globally-installed `myco` automatically because `.agents/myco-hook.cjs` treats a missing `.myco/runtime.command` as "use the default."

### Why This Approach Works

**`.myco/runtime.command` file (current design)**
The hook reads an explicit file path — there is no PATH lookup and no env var inheritance. The selection is deterministic regardless of shell, subprocess depth, or IDE.

**Previous approaches that failed:**

- **`MYCO_CMD` environment variable** — Hooks run inside Claude Code's subprocess environment. Codex and other nested subprocess contexts silently strip custom env vars, so `MYCO_CMD` would be set in the terminal but invisible to the hook.
- **`~/.local/bin/myco-dev` symlink alone** — Shell PATH ordering is fragile. In some contexts the global `myco` resolved first; in others the symlink resolved first.
- **Shell alias approach** — Shell aliases like `alias myco=./dist/src/cli.js` work for interactive CLI use but fail when Node.js spawns child processes. When `myco` spawns itself via `child_process.spawn()`, Node.js bypasses shell aliases and resolves directly to the global PATH.

## Querying Active Symbionts Programmatically

The canonical function for reading which symbionts are active in a project:

```typescript
import { getEnabledSymbiontNames } from 'packages/myco/src/config/loader.ts';

const enabled = getEnabledSymbiontNames(config);
// Returns string[] of symbiont names from .myco/myco.yaml symbionts list
```

This function is the single source of truth. Do not read `.myco/myco.yaml.symbionts` directly or filter inline — previously copy-pasted in 3 places (`packages/myco/src/cli/update.ts`, `packages/myco/src/cli/doctor.ts`, daemon API), now canonicalized in `packages/myco/src/config/loader.ts`.

## Common Pitfalls

**`symbionts` list absent from `.myco/myco.yaml` after init.** If a symbiont's manifest is missing the `defaultEnabled` field, `SymbiontInstaller` cannot determine the default and the symbiont may be excluded from the initial list. Add it manually after init, or add `defaultEnabled: true/false` to the manifest before running init.

**Machine-level install ≠ project-level activation.** An agent can be installed on the machine but absent from a project's `symbionts` list. `myco doctor` will not flag this. The symbiont is simply not active for that project. Use `myco init` or manually edit `.myco/myco.yaml` to add it.

**`myco doctor` mis-reports agents as "unregistered."** This was a historical bug where doctor used binary-on-PATH presence to detect agents. Current behavior: doctor only flags agents whose config directory (`.claude/`, `.cursor/`, etc.) exists in the current project but MCP isn't registered. If you see a false positive, check whether the config directory actually exists.

**`myco doctor` warnings for unconfigured providers are expected, not broken.** Immediately after `myco init`, doctor will warn that LLM/embedding providers are unconfigured. This is data-collection mode — valid and intentional. Configure providers via the daemon UI when ready.

**`myco update` after adding a new symbiont to `symbionts`.** After manually adding a symbiont to the `symbionts` list in `.myco/myco.yaml`, run `myco update` to register its MCP entry and install its hooks. The daemon UI is the primary interface — CLI is only for bootstrap operations.

**Old hook format (relative path) after upgrading.** Hooks installed before the harness env-var migration used bare relative paths (`node .agents/myco-hook.cjs`) and fail when the agent invokes them from a different working directory. Run `myco update` to auto-migrate to the current format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

**Don't edit `.myco/` contents directly.** The vault database and daemon state in `.myco/` are managed exclusively by the daemon. Direct edits can corrupt session history or break sync.

**Myco Agent pipeline won't run after init without configuration.** `myco init` writes `scheduled_tasks_enabled: false` and `event_tasks_enabled: false` explicitly to `.myco/myco.yaml`. If the agent pipeline isn't running after setup, check the **Myco Agent** section in the daemon UI — LLM provider, embedding provider, and per-task scheduling all require explicit opt-in.

**CLI flags are ignored on re-init of an existing vault.** Provider flags like `--embedding-provider` and `--agent-provider` are scoped exclusively to new vault creation. Running `myco init --agent-provider anthropic` on a project that already has a `.myco/` vault has no effect on provider settings — the existing configuration is preserved. To change providers on an existing vault, use the Settings UI in the daemon.

### Development Environment Gotchas

**Never delete `packages/myco/bin/myco-run`** even if it looks unused. It is the stable entrypoint for MCP server mode. Deleting it breaks MCP-based integrations.

**Use `make dev-link`, not `npm link`.** `npm link` rewires global resolution and will interfere with production-install testing in the same shell session.

**`.myco/runtime.command` is machine-specific.** If you copy your repo to another machine, re-run `make dev-link` there — the path baked into the file will be wrong otherwise.

**Rebuild before testing.** `myco-dev doctor` (or any hook) reads the binary on disk. Stale `packages/myco/dist/src/cli.js` means stale behavior, even if your source edits look right.

**Symlinks go stale after package relocation.** When the Myco project restructures (e.g., moving into a monorepo), `~/.local/bin/myco-*` symlinks still point to the old locations. If the target dist file doesn't exist at the old path, hooks will fail silently. Fix this by re-running `make dev-link` after any significant directory reorganization.

**Team and Collective dev binaries are separate tools.** `myco-team-dev` and `myco-collective-dev` are for manual CLI use. `.myco/runtime.command` still points to `myco-dev`, because hooks and the daemon only need the main Myco binary.