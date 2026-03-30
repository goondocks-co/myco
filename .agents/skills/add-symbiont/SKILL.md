---
name: myco:add-symbiont
description: |
  Use this skill when adding a new symbiont (agent integration) to Myco's SymbiontInstaller — the component that manages agent lifecycle operations (init, update, remove, doctor) for all registered agents. Activates whenever you need to onboard a new AI agent (Claude Code, Cursor, Windsurf, a custom agent, etc.) so that `myco init`, `myco update`, and `myco doctor` manage its installation. Apply this skill even if the user doesn't explicitly mention SymbiontInstaller — any time you're adding a new agent type, creating a symbiont manifest, wiring new hook templates, or extending the supported agents list, this skill applies. Also relevant when a new symbiont needs the cross-platform hook guard or environment variable injection.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Adding a New Symbiont to Myco's SymbiontInstaller

Myco manages AI agent integrations through a registry of **symbionts** — declarative manifests that describe how to install, configure, update, and remove a specific agent. The `SymbiontInstaller` class reads these manifests and drives the `myco init`, `myco update`, `myco remove`, and `myco doctor` CLI commands. Adding a new agent means registering a manifest, not writing imperative install code — this is the sustainable pattern.

Currently there are 6 registered symbionts. Each is fully described by its manifest; the CLI itself has no agent-specific knowledge.

## Prerequisites

- The target agent's config file format and hook/extension mechanism are understood
- The cross-platform hook guard (`.agents/myco-hook.cjs`) is in place — see the `myco:cross-platform-hook-guard` skill if it isn't
- You know which environment variables the new agent needs injected (e.g., `MYCO_MCP_URL`, `MYCO_SESSION_ID`)

## Steps

### 1. Locate the symbiont registry

Find where existing symbiont manifests are defined — either as a registry file or as individual manifest objects imported into `SymbiontInstaller`. Grep for the class:

```bash
grep -r "SymbiontInstaller" src/ --include="*.ts" -l
grep -r "symbiont" src/ --include="*.ts" -l | head -20
```

Look for an array or map of symbiont definitions — something like `SYMBIONTS`, `SYMBIONT_REGISTRY`, or individual `Symbiont` / `SymbiontDef` objects. This is where you'll add the new entry.

### 2. Understand an existing manifest

Before writing your own, read a manifest for a similar agent (one that uses hooks, not just config file edits). A manifest typically declares:

```typescript
{
  id: "claude-code",           // stable identifier, never changes
  displayName: "Claude Code",
  configPath: (projectRoot) => path.join(projectRoot, ".claude", "settings.json"),
  // or a directory-based install
  detect: (projectRoot) => fs.existsSync(...),   // is this agent installed?
  install: { ... },
  update: { ... },
  remove: { ... },
  doctor: { ... },
}
```

The exact shape varies — read an existing one to understand the current interface before inventing fields.

### 3. Create the new symbiont manifest

Add a new entry to the registry following the same shape. Key decisions:

**Config file vs. directory install** — Does the agent use a JSON/YAML config file (like `settings.json`) or a directory of files (like `.cursor/`)? Use the same pattern as the closest existing symbiont.

**Hook injection** — If the new agent supports hooks/extensions, the manifest's `install` step should:
1. Write the hook entry pointing at `.agents/myco-hook.cjs`
2. Inject required env vars through the agent's supported mechanism

> **Gotcha — settings.json vs. settings.user.json (Claude Code):** For Claude Code specifically, environment variables injected into hooks must go in `settings.json`, NOT `settings.user.json`. Only `settings.json` values are available inside hook processes. This is agent-specific; check the target agent's documentation for its equivalent.

**Never hardcode agent-specific values** in `SymbiontInstaller`'s shared logic. If the new symbiont needs a unique path, env var name, or behavior, encode it in the manifest object, not as a conditional branch in the installer core.

### 4. Wire the `detect` function

The `detect` function tells `myco doctor` and the UI whether the agent is present in the project. It should return `true` if the agent's config directory or marker file exists:

```typescript
detect: (projectRoot) =>
  fs.existsSync(path.join(projectRoot, ".newagent", "config.json")),
```

A missing or incorrect `detect` will cause `myco doctor` to report false positives or negatives.

### 5. Add hook template files (if needed)

If the new symbiont requires template files (hook scripts, config snippets) that get copied during install, add them under the appropriate templates directory — look for where existing hook templates live:

```bash
find src/ -name "*.template*" -o -name "templates" -type d 2>/dev/null
```

Template files should reference `.agents/myco-hook.cjs` for the hook entrypoint rather than embedding inline shell logic — the hook guard handles cross-platform execution.

### 6. Handle env var injection

Most symbionts need Myco to inject `MYCO_MCP_URL` (and possibly `MYCO_SESSION_ID` or similar) into the agent's environment. How this works depends on the agent:

- **Claude Code**: Written as `env` entries in `settings.json` hook definitions
- **Cursor / Windsurf**: May use a different config key — consult the agent's docs
- The values themselves come from Myco's runtime (daemon URL, etc.) and must not be hardcoded — read them from config at install time

> **Gotcha:** Never write API keys or secrets into the agent config. Only runtime-safe values like daemon URL belong there. Secrets live in `.myco/secrets.env`. See the `myco:safe-config-updates` skill.

### 7. Export / register the manifest

Make sure your new manifest object is included in the registry collection that `SymbiontInstaller` iterates over. If there's an explicit array:

```typescript
export const SYMBIONTS: SymbiontDef[] = [
  claudeCodeSymbiont,
  cursorSymbiont,
  // ...
  yourNewSymbiont,   // ← add here
];
```

If registration is implicit (auto-discovered from a directory), drop your file in the right place.

### 8. Test the full lifecycle

Run each CLI command against a test project to verify the manifest is correct:

```bash
# Install
myco init --agent your-new-agent-id

# Verify detection
myco doctor

# Update (should be idempotent — running twice should produce no changes)
myco update --agent your-new-agent-id
myco update --agent your-new-agent-id

# Remove
myco remove --agent your-new-agent-id

# Doctor should now show agent as not installed
myco doctor
```

> **Idempotency is required.** `myco update` is run repeatedly on a schedule. If your install step isn't idempotent (e.g., it appends to a file instead of upserting), it will corrupt the target config over time. Prefer merge/upsert patterns over append.

### 9. Update the UI if needed

If the daemon UI has an agents list or a "supported symbionts" display, add the new agent there too — typically the UI reads from the same registry, but check whether any display strings or icons need updating.

## Common Pitfalls

- **Hardcoding in shared logic** — Any `if (agentId === "new-agent")` branch in `SymbiontInstaller`'s core methods is a red flag. Encode it in the manifest.
- **Non-idempotent installs** — `update` must be safe to run multiple times. Test this explicitly.
- **Wrong env injection target** — Verify the agent actually reads env vars from the config location you're writing to, not a different file.
- **Forgetting `detect`** — Without a working `detect`, `myco doctor` gives misleading health reports.
- **Hook not executable** — On macOS/Linux, `.agents/myco-hook.cjs` must have execute permission or be invoked as `node .agents/myco-hook.cjs`. The cross-platform hook guard handles this, but make sure your hook template invokes it correctly.
