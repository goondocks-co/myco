---
name: myco:install-and-initialize-myco
description: |
  Use this skill when installing Myco for the first time, initializing Myco in a new project, or troubleshooting a broken installation. Activate even if the user just asks "how do I get started with Myco" or "how do I add Myco to my project" without explicitly saying "install." Covers the full lifecycle: bootstrapping the CLI via the install script, running `myco init`, verifying health with `myco doctor`, and managing updates and removal.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Install and Initialize Myco

Myco is a project-local intelligence layer that captures developer sessions and builds institutional knowledge. This skill walks through bootstrapping the `myco` CLI, initializing a project vault, and verifying the installation is healthy.

## Prerequisites

- Node.js 22+ installed
- At least one supported coding agent present in the project (Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code Copilot, or Windsurf)
- An Anthropic API key (or compatible key) for the intelligence pipeline
- You are standing at your project root — Myco installs into `.myco/` relative to your working directory

## Step 1 — Bootstrap the CLI

```bash
curl -fsSL https://myco.sh/install | sh
```

The script installs `@goondocks/myco` globally via npm. Verify it worked:

```bash
myco --version
```

**npm link trap (dev machines):** If you previously ran `npm link` from the repo root, a global symlink at `/opt/homebrew/bin/myco` already exists. A plain `npm install -g` will throw EEXIST and silently fail. The install script handles this automatically — it removes conflicting packages (`@goondocks-co/myco`, `@goondocks/myco-ui`) and retries. If you're running the install manually, clear those packages first:

```bash
npm rm -g @goondocks-co/myco @goondocks/myco-ui
curl -fsSL https://myco.sh/install | sh
```

**`better-sqlite3` deprecation warning:** You'll see a `prebuild-install` deprecation notice during install. This comes from a transitive dependency and is harmless — ignore it.

## Step 2 — Initialize the Project

```bash
cd /path/to/your/project
myco init
```

The interactive wizard does five things:

1. **Detects agents** by checking for config-directory presence — NOT binary-on-PATH:
   - `.claude/` → Claude Code
   - `.cursor/` → Cursor
   - `.codex/` → Codex CLI
   - `.gemini/` → Gemini CLI
   - `.vscode/` → VS Code Copilot
   - `.codeium/windsurf/` → Windsurf

   Agents whose config dir exists are pre-checked as defaults. Detection is informational — you can select or deselect any agent freely.

2. **Prompts you to pick agents** — choose which to configure.

3. **Prompts for your API key** — stored in `.myco/secrets.env`, never in `myco.yaml`. This separation is enforced by convention; always keep keys in `secrets.env`.

4. **Creates the vault** at `.myco/`:
   - `myco.yaml` — project config (symbiont list, plan dirs, daemon settings)
   - `secrets.env` — API keys (gitignored automatically)
   - `.gitignore` — covers `vault.db`, `daemon.json`, `backups/`, `.team-worker/`, and `secrets.env`

5. **Runs `SymbiontInstaller`** — installs hook files and settings for each selected agent. Each agent gets its own hook that fires on session events (start, stop, prompt).

After `init` completes, `.myco/` is the project's vault root. All subsequent Myco operations (daemon, agent runs, team sync) read from here.

## Step 3 — Verify with Doctor

```bash
myco doctor
```

`myco doctor` checks:
- CLI version and update availability
- Vault database integrity (schema version, table presence)
- Daemon connectivity
- Agent hook installations
- API key presence in `secrets.env`

Fix any warnings before proceeding. A red item means something won't work; yellow is advisory.

## Step 4 — Start the Daemon

```bash
myco open
```

The daemon runs in the background and listens for hook events from your coding agents. It writes raw session data (prompt batches, activities) to the vault. The intelligence agent (`myco-agent`) processes this data on a schedule.

To check daemon status:

```bash
myco status
```

## Lifecycle Commands

| Command | Purpose |
|---|---|
| `myco init` | First-time project setup |
| `myco open` | Start the daemon |
| `myco status` | Check daemon and vault health |
| `myco doctor` | Full health check |
| `myco update` | Update CLI and symbiont hooks |
| `myco remove` | Uninstall hooks from agents (vault preserved) |

**`myco update` during an active hook session:** If a hook fires while `npm update -g` is mid-run, you may see a `node:internal/modules/cjs/loader:1478` CJS loader error. This is npm's non-atomic file replacement in action — not a code regression. It self-resolves once npm finishes. Restart the daemon if it goes quiet afterward.

## Adding or Removing Agents Later

To add a new agent symbiont after initial setup, use the daemon UI (Settings → Symbionts) — this is the primary interface for managing agents. The CLI `myco init` is only for first-time bootstrap; subsequent agent changes go through the UI to avoid config divergence. There is one write path for `myco.yaml` — the UI owns it after init.

## What NOT to Do

- **Don't edit `myco.yaml` by hand** to add agents. Use the UI.
- **Don't put API keys in `myco.yaml`**. They belong in `.myco/secrets.env`.
- **Don't run `myco init` in a subdirectory** unless you explicitly want a nested vault. Myco installs relative to your working directory.
- **Don't commit `.myco/`** to git. The `.gitignore` created by `init` covers the sensitive and ephemeral files, but the directory itself should not be in version control.
