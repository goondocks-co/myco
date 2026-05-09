---
name: myco:add-symbiont
description: "Use this skill when adding a new symbiont (agent integration) to Myco's SymbiontInstaller — the component that manages agent lifecycle operations (init, update, remove, doctor) for all registered agents. Activates whenever you need to onboard a new AI agent (Claude Code, Cursor, Windsurf, a custom agent, etc.) so that `myco init`, `myco update`, and `myco doctor` manage its installation. Apply this skill even if the user doesn't explicitly mention SymbiontInstaller — any time you're adding a new agent type, creating a symbiont manifest, wiring new hook templates, or extending the supported agents list, this skill applies. Also relevant when a new symbiont needs the cross-platform hook guard or environment variable injection."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Adding a New Symbiont to Myco's SymbiontInstaller

## Prerequisites

- Understand the new agent's hook format and config file locations
- Know the agent's config directory name (e.g., `.claude/`, `.cursor/`, `.gemini/`)
- Determined whether the agent reads `AGENTS.md` natively or needs a thin instruction stub

## Integration Classes

Not all agents can be wired via the same procedure. Before starting, identify which class applies:

| Class | Description | Example agents |
|-------|-------------|----------------|
| **Class 1 — Config-File** | Agent is configured via JSON or TOML files in a project directory. Hooks, MCP entries, and instructions are written by `SymbiontInstaller` as file I/O. | Claude Code, Cursor, Windsurf, Codex, Gemini CLI, VS Code Copilot |
| **Class 2 — Plugin-API** | Agent exposes a plugin registration API; it cannot be configured by writing files into a config directory. Requires a dedicated, agent-specific installation path in `SymbiontInstaller` — the standard Steps 1–8 below do NOT apply. | opencode (v0.15.0+, 7th symbiont, implemented) |

**If you are adding a Class 2 agent:** the steps below describe the Class 1 path only. Class 2 integration requires a separate SymbiontInstaller code path for plugin registration — consult the opencode implementation as the reference. Do not attempt to adapt the file-based manifest/hook steps for a plugin-API agent.

## Steps

### 1. Create the Symbiont Manifest

Manifests live in `src/symbionts/manifests/`. Create `<agent-name>.yaml`:

```yaml
name: my-agent
displayName: My Agent
configDir: .myagent          # project-local config directory this agent uses

# Required: controls per-project activation default at myco init
defaultEnabled: true         # or false — SymbiontInstaller reads this at init time

# Optional: declare 'toml' if the agent uses TOML config files (e.g., Codex)
# settingsFormat: json       # default; omit for JSON-based config agents
# settingsFormat: toml       # required for agents like Codex that use config.toml

registration:
  hooksTarget: .myagent/hooks.json   # where to write hook registrations
  mcpTarget: .myagent/mcp.json       # where to write MCP server config
  skillsTarget: .myagent/skills/     # where to symlink skills
  hookFields:                         # payload field normalization (if needed)
    session_id: sessionId             # agent-specific field name → canonical name
  resumeCommand: my-agent resume      # optional: how to resume a session

# Optional: for agents needing their own instruction file
# instructionsFile: MY-AGENT.md       # omit if agent reads AGENTS.md natively
```

**`defaultEnabled` is required.** `SymbiontInstaller` reads this field during `myco init` to populate the project's `symbionts` list in `myco.yaml`. A manifest without `defaultEnabled` means the symbiont won't be included in the init-time activation list, even if installed on the machine. The field must be explicit — there is no fallback default.

**`settingsFormat`** controls how the installer reads and writes the agent's config file. Default is `'json'`. Set `settingsFormat: toml` for agents whose settings file is TOML-based (e.g., Codex uses `config.toml`). The installer dispatches on this field when writing MCP entries and hook registrations — an incorrect or missing value will write JSON syntax into a TOML file and break the agent's config. TOML read/write operations use `src/symbionts/toml-helpers.ts` (`upsertTomlSection` / `removeTomlSectionKeys`) — reference that module rather than hand-rolling TOML string manipulation.

### 2. Register in SymbiontInstaller

Open `src/symbionts/installer.ts` and add the new symbiont to the registry:

```typescript
import myAgentManifest from './manifests/my-agent.yaml';

export const SYMBIONT_MANIFESTS = [
  claudeCodeManifest,
  cursorManifest,
  // ... existing ...
  myAgentManifest,  // add here
];
```

The order in `SYMBIONT_MANIFESTS` determines display order in `myco init` interactive prompts and `myco doctor` output.

### 3. Create Hook Templates

Hook templates define the hook scripts written to the agent's config directory during `myco init`.

Create template files in `src/symbionts/templates/<agent-name>/`:

```
src/symbionts/templates/my-agent/
  session-start.sh
  user-prompt-submit.sh
  post-tool-use.sh
  stop.sh
```

Each hook script must:
1. Include the cross-platform hook guard at the top (see below)
2. Call `myco-run hook <event>` with the correct payload
3. Forward `MYCO_AGENT_SESSION` to prevent re-entrancy

**Template example:**
```bash
#!/bin/bash
# Cross-platform hook guard — prevents execution if myco is not installed
source "$(dirname "$0")/../myco-hook.cjs" 2>/dev/null || exit 0

export MYCO_AGENT_SESSION=1
myco-run hook session-start \
  --session-id "$SESSION_ID" \
  --agent my-agent
```

### 4. Wire the Cross-Platform Hook Guard

The hook guard `.agents/myco-hook.cjs` prevents hooks from failing for OSS contributors who don't have Myco installed. It is a CJS module that:
- Checks if `myco-run` is available on PATH
- Exits cleanly if Myco is not installed (no error, no noise)
- Is sourced at the top of every hook script before any Myco commands

New symbiont hooks must source this guard. Do not inline the guard logic — reference the shared file to keep updates centralized.

### 5. Handle Hook Payload Normalization

If the new agent's hook payloads use different field names than the canonical format, declare the mapping in the manifest's `hookFields` section:

```yaml
hookFields:
  session_id: trajectory_id          # agent uses trajectory_id, Myco expects session_id
  tool_name: tool_info.command_line  # dot-path for nested fields
  # session_id: $env:AGENT_SESSION   # env-var source (prefix with $env:)
```

`normalizeHookInput()` reads the active manifest at hook runtime and applies the mapping before any processing logic runs. Each hook invocation is a fresh process, so per-invocation manifest detection is correct.

### 6. Wire Instruction File (If Needed)

If the new agent does **not** read `AGENTS.md` natively, declare `instructionsFile` in the manifest:

```yaml
registration:
  instructionsFile: MY-AGENT.md
```

`SymbiontInstaller.installInstructions()` will write a thin stub that defers to `AGENTS.md`. If the file already exists, a reference block is prepended (idempotently) rather than overwriting user content.

Agents that read `AGENTS.md` natively (Cursor, Codex, Windsurf) should omit `instructionsFile` entirely — the installer skips instruction file management for them.

### 7. Implement the Transcript Adapter

The intelligence pipeline needs a transcript parser for each agent's session format:

Create `src/symbionts/adapters/<agent-name>.ts`:

```typescript
export function parseMyAgentTranscript(content: string): Turn[] {
  // Parse the agent's transcript format into canonical Turn objects
  // Each Turn has: role ('user' | 'assistant'), content, and optional toolCalls
}
```

Register the adapter in `src/symbionts/adapters/index.ts`.

**Common format pitfalls:**
- Some agents use JSONL (one JSON object per line) — parse line by line
- Some use a single JSON file with a `messages` array — do NOT parse line by line
- Some use delta JSONL (state-replay format) — must replay deltas in sequence

### 8. Test the Integration

After wiring everything:

```bash
myco init     # should include new symbiont in symbionts list if defaultEnabled: true
myco doctor   # should check new symbiont's registration state
myco update   # should refresh hooks and MCP for new symbiont
make build    # must pass all 1,600+ tests with 0 TypeScript errors
```

Verify `myco init` includes the new symbiont in the generated `myco.yaml`:
```yaml
symbionts:
  - claude-code
  - my-agent      # should appear if defaultEnabled: true
```

## Common Pitfalls

**Missing `defaultEnabled` in manifest.** This is the most impactful omission: `SymbiontInstaller` reads this field at `myco init` to seed the project's `symbionts` list. Without it, the symbiont will never be in the default activation list for new projects. Developers must add it manually after init. The field must be a boolean (`true` or `false`) — there is no implicit default.

**Missing or wrong `settingsFormat` for TOML-based agents.** Codex uses `config.toml`, not `settings.json`. Its manifest must declare `settingsFormat: toml`. Without this, the installer writes JSON syntax into a TOML file and silently corrupts the agent's config. Additionally, Codex hooks are experimental and require an explicit feature flag in `config.toml`:

```toml
[features]
hooks = true
```

Without this block, hooks defined in the symbiont manifest are silently ignored by Codex regardless of how they are registered. (Codex previously named the flag `codex_hooks`; that spelling is now deprecated and emits a warning. Updating the template drops the stale key automatically because `installSettingsToml` reconciles each Myco-managed section against the template — the section body is rewritten on every install, not just patched key-by-key.)

**Class 2 agents cannot use this procedure.** Plugin-API agents (e.g., opencode) do not expose a config directory for file-based hook/MCP injection. Attempting to wire them via manifest + template steps will produce a silently incomplete integration. These agents require a dedicated installation code path in `SymbiontInstaller`. Do not adapt the Class 1 steps for a plugin-API agent.

**Class 2 (opencode): `client.app.log` is silently swallowed.** Output via `client.app.log()` is swallowed by the TUI and does not appear anywhere observable. Use `console.error()` for debug output during Class 2 plugin development — it appears in opencode's stderr stream.

**Class 2 (opencode): `chat.message({ synthetic: true })` causes infinite crash loops.** Injecting synthetic messages via `chat.message()` triggers the model to respond, which re-enters the plugin callback, which injects another message — a hard crash loop with no escape. Use `session.prompt({ noReply: true })` with `TextPartInput.synthetic: true` to inject content without triggering a model response.

**Class 2 (opencode): OSS safety pattern differs from hook guard.** Unlike Class 1 symbiont hooks (which source `.agents/myco-hook.cjs`), Class 2 plugins check for `.myco/daemon.json` at startup using a filesystem check. If the file is absent (Myco not installed), the plugin exits silently as a no-op. Do not use shell guard sourcing — the plugin runs in the opencode process context.

**Class 2 (opencode): Use `server.instance.disposed` for cleanup.** This event fires reliably on TUI exit (Ctrl+C or `q`). It is the correct hook for cleanup operations (closing connections, flushing state). Do not rely on process exit signals directly.

**Using `getEnabledSymbiontNames()` is the canonical read path.** Don't filter `myco.yaml.symbionts` inline in new code. Always call `getEnabledSymbiontNames(config)` from `src/config/loader.ts`. This was previously copy-pasted in 3 places before being canonicalized.

**Forgetting the hook guard.** Hooks without the cross-platform guard will fail loudly for contributors without Myco installed. Always source `.agents/myco-hook.cjs` at the top of every hook script.

**hookFields for camelCase or nested fields.** Many agents use non-snake-case field names (e.g., VS Code uses `sessionId` not `session_id`). Declare the mapping in `hookFields` rather than special-casing it in hook scripts or normalizeHookInput logic.

**Hardcoding agent detection.** The installer uses config directory presence (`.myagent/` exists) as the signal for "agent is used in this project" — NOT binary-on-PATH presence. Binary detection was removed from the init flow. Don't add it back.

**`instructionsFile` for AGENTS.md-native agents.** Cursor, Codex, and Windsurf read `AGENTS.md` natively — their manifests must NOT declare `instructionsFile`, or they'll get an unnecessary stub written at init time.
