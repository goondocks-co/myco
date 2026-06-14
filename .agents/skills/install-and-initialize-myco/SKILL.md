---
name: myco:install-and-initialize-myco
description: "Use this skill when installing Myco for the first time, initializing Myco in a new project, or troubleshooting a broken installation. Activate even if the user just asks \"how do I get started with Myco\" or \"how do I add Myco to my project\" without explicitly saying \"install.\" Covers the full lifecycle: bootstrapping the CLI via the install script, verifying health with `myco doctor`, and managing updates and removal."
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

**CLI Help Behavior:** All Myco commands return usage information via `--help` before processing configuration. This means `myco init --help` or `myco update --help` will display command usage immediately without reading `.myco/myco.yaml` or validating the project state first.

### 2. Initialize Myco in a Project

Navigate to the project root directory:

```bash
cd /path/to/your/project
```

Start the Myco daemon. The daemon runs as a background process and manages session capture, intelligence processing, and team sync. The daemon UI provides configuration and monitoring:

```bash
myco daemon start
```

The daemon starts automatically on first session capture if not already running. You can also trigger startup explicitly before your first agent session:

```bash
myco stats  # Starts daemon if not running, shows current status
```

**Project Root Safety**: The daemon includes safety guards to prevent initialization in dangerous locations like `$HOME`. Choose a proper project directory for session capture.

**What initialization accomplishes:**

1. Creates `.myco/` directory (vault database, config, secrets)
2. Writes `.myco/myco.yaml` with project configuration  
3. Registers MCP server entries for each enabled symbiont
4. Installs hook files for each enabled symbiont — hooks use harness env vars (`${CLAUDE_PROJECT_DIR:-.}`, `${CURSOR_PROJECT_DIR:-.}`, etc.) for root-anchoring so they resolve correctly regardless of working directory
5. Creates skill symlinks under `.agents/skills/`
6. Creates thin `AGENTS.md` reference stubs for agents that require their own instruction file
7. Starts the daemon in the background automatically

**Symbiont Activation (UI-Driven):** After the daemon starts, activate symbionts (agents) through the daemon UI:

1. Open the daemon UI in your browser (usually `http://localhost:3000`)
2. Navigate to **Settings** → **Symbionts**
3. Toggle agents on/off to activate or deactivate them for this project
4. The daemon detects installed agents (Claude Code, Cursor, Windsurf, etc.) automatically

The per-project symbiont list in `.myco/myco.yaml` is managed by the UI — do not edit it manually.

**The Myco Agent pipeline is off-by-default.** No Myco Agent pipeline features (agent pipeline, digest, skill lifecycle) are active until you enable them through the daemon UI after startup:

1. Open daemon UI → **Myco Agent** section
2. Configure LLM and embedding providers
3. Toggle **Enable Pipeline** to activate agent processing

### 3. Verify the Installation

Run the health check:

```bash
myco doctor
```

`myco doctor` checks:
- Daemon is running and reachable
- **Binary version** — Validates that the daemon and CLI binary versions match to prevent version-skew issues
- MCP entries are registered correctly for each active symbiont
- Hook files are present and executable
- Vault database is accessible
- No configuration drift between `.myco/myco.yaml` and the active symbiont set
- **Global detection status** — Validates that the manifest-driven symbiont detection system is functioning properly and can identify installed agents
- **Capture flow** — `checkCaptureFlow()` validates that the hook-to-daemon event pipeline is delivering events correctly, detecting silent capture failures before they affect session history
- **Migration status** — `checkMigrationStatus()` verifies pending config migrations have been applied; flags unapplied project → Grove tier migrations
- **Symbiont edge cases** — `checkSymbiontEdgeCases()` detects known edge-case configurations that cause missed activations or duplicate registrations
- **Global symbiont registration** — `isSymbiontRegisteredGlobally()` distinguishes per-project from global symbiont registrations for accurate status reporting

Doctor flags agents whose config directory (`.claude/`, `.cursor/`, etc.) exists in the project but whose MCP entry is missing or stale. It does NOT flag agents that are installed globally but have no config directory here — binary presence without a project config directory is not a problem.

For runtime launch failures that don't appear in doctor output (e.g., a hook that silently exits without firing), also check `~/.myco/logs/launcher.log` — the global launcher appends a diagnostic line on every failed hook invocation, including signal kills and spawn errors.

**Note:** Doctor warns (rather than errors) when LLM or embedding providers are unconfigured. Data-collection mode is a valid post-init state — unconfigured providers mean the agent pipeline won't run, but session capture continues normally. These warnings are expected immediately after daemon startup.

### 4. Configure Myco Agent (Optional)

After the daemon is running, open the **Myco Agent** section in the daemon UI to enable Myco Agent pipeline features:
- LLM and embedding provider configuration
- Agent pipeline scheduling (skill survey, digest, etc.)
- Team sync settings

The Myco Agent pipeline is intentionally off-by-default so new installations capture data before any processing runs. Enable features as needed through the UI.

### 5. Managing Updates

```bash
myco update
```

Updates the CLI binary and refreshes hook files, MCP entries, and skill symlinks for all active symbionts. `myco update` respects the existing symbiont list in `.myco/myco.yaml` — it does not overwrite or reset per-project activation choices.

`myco update` also auto-migrates hook files from the old relative-path format (`node .agents/myco-hook.cjs`) to the current harness env-var format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

**Global Detection Updates:** Updates now include refreshing the manifest-driven detection registry, ensuring that newly installed symbionts with `detectionDir` configurations are properly discovered by the daemon's background detection processes.

**Automatic Configuration Migration:** `myco update` now automatically migrates legacy project configuration fields to the Grove tier instead of silently stripping them. Specifically:
- `embedding.run_in_deep_sleep` moves from Project to Grove config
- `agent.scheduled_tasks_active_window_days` moves from Project to Grove config

This migration preserves configuration values that previously would have been lost during updates. The migrated settings become available to all projects within the Grove while maintaining their configured behavior.

### 6. Removing Myco

```bash
myco remove
```

Bare `myco remove` is the **machine-wide uninstall**: it unregisters the OS service, strips Myco's blocks from every detected agent's global config, deletes the global launchers, and cleans project-local artifacts in registered projects. Captured data under `~/.myco/` is preserved unless you pass `--purge`. The command prompts for confirmation; pass `--yes` in non-interactive shells.

To remove Myco from a single project instead, pass `--project` (and optionally a path):

```bash
myco remove --project /path/to/project
```

Stops the project daemon and removes hooks, MCP entries, and skill symlinks for that project. The project vault (`.myco/` with all session history and spores) is **preserved by default**. To also delete the vault:

```bash
myco remove --project /path/to/project --remove-vault
```

## Development Environment Setup

When developing Myco itself, you need the project's hooks and daemon to invoke your locally-built binary rather than the globally-installed `myco`. This is essential for dogfooding unreleased changes.

### Prerequisites for Dev Setup

- Node.js installed (Myco requires Node.js ≥ 18)
- You are in the repository root (`/Users/chris/Repos/myco` or equivalent)
- The globally-installed `myco` is already working (used as the fallback when `~/.myco/runtime.command` is absent)

### Verify Build Status

Before configuring dev binary, ensure the project is built:

```bash
# Check if CLI build exists
if [ ! -f "packages/myco/bin/myco.cjs" ]; then
  echo "CLI not built. Running build..."
  make build
else
  echo "CLI build found."
fi
```

The CLI build at `packages/myco/bin/myco.cjs` is required for dev configuration to work.

### Configure Dev Binary

```bash
make dev-link
```

This creates four symlinks in `~/.local/bin/` and writes `~/.myco/runtime.command`:

- **`myco-dev`** — symlink to `packages/myco/bin/myco.cjs`. Used for dogfooding agent and core daemon changes.
- **`myco-team-dev`** — symlink to `packages/myco-team/dist/main.js`. Used for manual testing of team sync operator flows.
- **`myco-collective-dev`** — symlink to `packages/myco-collective/dist/main.js`. Used for manual testing of Collective operator flows.
- **`myco-run`** — symlink to `packages/myco/bin/myco-run`. Stable operator entrypoint for MCP server mode; never delete this even if it appears unused.

`~/.myco/runtime.command` is set to `myco-dev`. The hook guard only uses this file to choose the main Myco binary; it does not switch team or collective operator CLIs.

`.agents/myco-hook.cjs` reads `~/.myco/runtime.command` at every hook invocation and substitutes that path for the default `myco` command. Because the read happens at hook-fire time (not at shell startup), no shell restart is required.

### Verify Dev Configuration

```bash
myco-dev doctor
```

The output should report the dev binary path. If it falls back to the global binary path, check that `~/.myco/runtime.command` exists and contains the correct path.

Confirm `~/.myco/runtime.command` is gitignored:

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

This removes `~/.myco/runtime.command` and deletes the `~/.local/bin/myco-*` symlinks. Hooks fall back to the globally-installed `myco` automatically because `.agents/myco-hook.cjs` treats a missing `~/.myco/runtime.command` as "use the default."

### Why This Approach Works

**`~/.myco/runtime.command` file (current design)**
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

**Global Detection Integration:** The active symbionts query now integrates with the manifest-driven detection system, cross-referencing the explicit `symbionts` list with detected agents to provide comprehensive symbiont status information.

## CLI Surface Architecture Decisions

Myco applies a **UI-first philosophy**: CLI handles installation, teardown, and one-time diagnostics; UI handles all ongoing configuration and management. Every future CLI change should pass through this gate:

> **"Can this be done without the daemon running?"**
> - Yes → CLI is appropriate (install, remove, diagnose, tool calls).
> - No → belongs in UI (requires daemon state, per-project config, or discovery).

| Task | Destination |
|------|-------------|
| Install global binary + register service | CLI (`myco install`) |
| Tear down global install | CLI (`myco remove`, `packages/myco/src/cli/remove.ts`) |
| Check vault health | CLI (`myco doctor`, `packages/myco/src/cli/doctor.ts`) |
| Invoke MCP tools from scripts | CLI (`myco tool call`, `packages/myco/src/cli/tool.ts`) |
| Re-detect newly installed agents | UI ("Re-detect now" button) |
| Override symbiont config per project | UI (Symbionts page) |

### `myco doctor` Scope Invariants

Doctor scope is a maintained invariant. **Permitted:** global install state, daemon status, hook files, MCP registration, migration status, brownfield-cleanup state, `--fix` for one-time repairs. **Prohibited:** re-detect agents, manage per-project overrides, any operation requiring a healthy daemon. Every `--fix` path must work when the daemon is not running.

### Command Removal Pattern

Canonical five-step model (from `myco init` removal):
1. Audit all callers and tests referencing the command entry point.
2. Verify the replacement (UI button or daemon auto-path) is live.
3. Delete the source file and remove CLI registration.
4. Scan `packages/myco/src/cli/doctor.ts` for stale references; apply canonical replacements.
5. Smoke-test the user journey that the old command previously served.

> **Gotcha (BUG-4):** `myco init` triggered `ensureSelfInstalledAsService` (exported from `packages/myco/src/service/self-install.ts`). That function read process-wide path constants instead of `MYCO_HOME`, causing a sandbox LaunchAgent hijack. Its sole remaining caller is `packages/myco/src/daemon/main.ts`. Do not introduce new CLI callers.

### Beta Channel Strategy

Beta switching is **system-wide** — no per-project toggle exists. Activation: daemon API sets `localRuntimeSpec` to the beta package spec, `spawnUpdateScript` installs to `~/.myco/runtime/` and writes `~/.myco/runtime.command`. Rollback: set channel to `stable`; daemon removes `~/.myco/runtime/` and clears the pin file; service restarts against PATH-resolved stable binary. The update channel and binary pin are tracked separately in `packages/myco/src/daemon/update-checker.ts` (`resolveRuntimeCommand`). A mismatch between the channel and the binary pin causes unexpected update-checker behavior — always update both when manually intervening.

### `myco tool call` — CLI MCP Tool Interface

`packages/myco/src/cli/tool.ts` exposes all registered MCP tools as CLI subcommands:

```
myco tool call <tool-name> --json --input '<json-or-@file>'
```

This is the canonical way to invoke Cortex or any Myco MCP tool from a script or Bash context — e.g., `myco tool call myco_cortex --json --input '{"query": "..."}'`. Captured Bash activities are identified as Myco tool calls by `parseCliMycoToolCalls` in `packages/myco/src/db/queries/myco-tool-identity.ts`.

## Common Pitfalls

**Machine-level install ≠ project-level activation.** An agent can be installed on the machine but inactive for a project. Activate agents through the daemon UI **Settings** → **Symbionts** page. The symbiont is simply not active for that project until toggled on in the UI. The daemon's global detection system can identify such agents and show them in the settings.

**`myco doctor` mis-reports agents as "unregistered."** This was a historical bug where doctor used binary-on-PATH presence to detect agents. Current behavior: doctor only flags agents whose config directory (`.claude/`, `.cursor/`, etc.) exists in the current project but MCP isn't registered. If you see a false positive, check whether the config directory actually exists. The Global Symbiont Install architecture adds manifest-driven validation to reduce these false positives.

**`myco doctor` warnings for unconfigured providers are expected, not broken.** Immediately after daemon startup, doctor will warn that LLM/embedding providers are unconfigured. This is data-collection mode — valid and intentional. Configure providers via the daemon UI when ready.

**`myco update` after adding a new symbiont to the UI.** After toggling a symbiont on in the daemon UI, run `myco update` to ensure its hooks and MCP entries are up to date. The daemon UI is the primary interface — CLI is only for bootstrap operations. The global detection system will also validate that the added symbiont can be properly detected.

**Old hook format (relative path) after upgrading.** Hooks installed before the harness env-var migration used bare relative paths (`node .agents/myco-hook.cjs`) and fail when the agent invokes them from a different working directory. Run `myco update` to auto-migrate to the current format that uses `${CLAUDE_PROJECT_DIR:-.}` (and cursor/windsurf equivalents) for correct root resolution.

**Don't edit `.myco/` contents directly.** The vault database and daemon state in `.myco/` are managed exclusively by the daemon. Direct edits can corrupt session history or break sync.

**Myco Agent pipeline won't run after daemon startup without configuration.** The daemon starts with `scheduled_tasks_enabled: false` and `event_tasks_enabled: false` explicitly in `.myco/myco.yaml`. If the agent pipeline isn't running after setup, check the **Myco Agent** section in the daemon UI — LLM provider, embedding provider, and per-task scheduling all require explicit opt-in.

**CLI help shows before config processing.** Commands like `myco update --help` display usage information immediately without reading or validating configuration files. This means help is available even in projects with broken or missing `.myco/myco.yaml` files.

**Attempting to init in unsafe locations.** Daemon operations include safety guards that prevent vault creation in dangerous project roots like `$HOME` or other system directories. Always navigate to a proper project directory before initializing Myco.

**Global detection lag.** The manifest-driven detection system runs periodically rather than continuously. If a newly installed symbiont isn't immediately detected, wait for the next detection cycle or restart the daemon to force detection. The detection interval is configurable in the daemon settings.

**Hook errors trace to `~/.myco/logs/launcher.log`, not `myco doctor`.** When a `PreToolUse` hook silently fails — the agent reports no error but the hook didn't fire — the global launcher at `~/.myco/launcher.cjs` writes a one-line diagnostic to `~/.myco/logs/launcher.log` on every launch failure, including signal kills (`signal=SIGKILL`), binary-not-found (`code=ENOENT`), and spawn-class errors. Check this log **before** anything else when hooks appear to silently no-op. `myco doctor` detects configuration issues but does not surface runtime launch failures; `~/.myco/logs/launcher.log` is the only trace for those.

**Third-party CLIs masquerading as hook failures.** If hooks appear to be signal-killed or exit abnormally, the cause may not be Myco at all. Third-party CLI tools installed on the machine (e.g., GitKraken's `gk` binary) can intercept a `PreToolUse` hook environment and exit abnormally when launched in an unexpected subprocess context, producing symptoms that look identical to a Myco launcher failure. To rule out Myco: check `~/.myco/logs/launcher.log` — if the log has no entries for the affected session, the launcher completed normally and the kill came from a downstream process. Run `myco doctor` to confirm hook files point to the expected Myco binary path.

### Development Environment Gotchas

**Never delete `packages/myco/bin/myco-run`** even if it looks unused. It is the stable entrypoint for MCP server mode. Deleting it breaks MCP-based integrations.

**Use `make dev-link`, not `npm link`.** `npm link` rewires global resolution and will interfere with production-install testing in the same shell session.

**`~/.myco/runtime.command` is machine-specific.** If you copy your repo to another machine, re-run `make dev-link` there — the path baked into the file will be wrong otherwise.

**Rebuild before testing.** `myco-dev doctor` (or any hook) reads the binary on disk. Stale `packages/myco/bin/myco.cjs` means stale behavior, even if your source edits look right.

**Symlinks go stale after package relocation.** When the Myco project restructures (e.g., moving into a monorepo), `~/.local/bin/myco-*` symlinks still point to the old locations. If the target dist file doesn't exist at the old path, hooks will fail silently. Fix this by re-running `make dev-link` after any significant directory reorganization.

**Team and Collective dev binaries are separate tools.** `myco-team-dev` and `myco-collective-dev` are for manual CLI use. `~/.myco/runtime.command` still points to `myco-dev`, because hooks and the daemon only need the main Myco binary.

**Global detection in development mode.** When running `myco-dev`, the manifest-driven detection system uses the development binary's manifest registry. This may differ from the production registry, potentially affecting symbiont detection behavior during development. Use `myco-dev doctor` to validate detection status with the development binary.
