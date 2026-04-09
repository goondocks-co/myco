---
name: myco:add-symbiont
description: "Use this skill when adding a new symbiont (agent integration) to Myco's SymbiontInstaller — the component that manages agent lifecycle operations (init, update, remove, doctor) for all registered agents. Activates whenever you need to onboard a new AI agent (Claude Code, Cursor, opencode, a custom agent, etc.) so that `myco init`, `myco update`, and `myco doctor` manage its installation. Apply this skill even if the user doesn't explicitly mention SymbiontInstaller — any time you're adding a new agent type, creating a symbiont manifest, wiring new hook templates, or extending the supported agents list, this skill applies. Also relevant when a new symbiont needs the cross-platform hook guard or environment variable injection."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Adding a New Symbiont to Myco's SymbiontInstaller

## Prerequisites

- Understand the new agent's hook format: JSON config file entries, TOML sections, or a TypeScript/JavaScript plugin module.
- Know the agent's config directory (e.g., `.claude/`, `.cursor/`, `.opencode/`) and its primary config file.
- Determine whether the agent reads `AGENTS.md` natively or needs a thin instruction stub.
- Know whether the agent's MCP config lives under the standard `mcpServers` key or a different one (opencode uses `mcp`).

## How manifests are discovered

Manifests in `src/symbionts/manifests/*.yaml` are **auto-discovered** by `loadManifests()` in `src/symbionts/detect.ts`. Drop a new YAML file in that directory and it is picked up at runtime — **no imports, no registry edit, no code change** is needed to make a new manifest visible. The previous `SYMBIONT_MANIFESTS` array no longer exists.

## Hook delivery modes

The installer supports two ways of delivering hooks to an agent:

| Mode | When | Template file | How installed |
|------|------|---------------|---------------|
| **`json` (default)** | Agent reads hooks from a JSON (or TOML) settings file — the common case. | `templates/<agent>/hooks.json` | Merged into `registration.hooksTarget`, preserving non-Myco hook groups. |
| **`plugin-file`** | Agent reads hooks via a plugin module auto-loaded at startup (e.g., opencode). | `templates/<agent>/plugin.ts` | Copied verbatim to `registration.hooksTarget` (a `.ts` file path). |

Set `registration.hooksFormat: plugin-file` when adding the second class. See the "Plugin-file hook variant" section near the bottom.

## Steps

### 1. Create the Symbiont Manifest

Manifests live in `src/symbionts/manifests/`. Create `<agent-name>.yaml`:

```yaml
name: my-agent
displayName: My Agent
binary: my-agent                    # used by myco detect (is the CLI on PATH?)
configDir: .myagent                 # project-local config directory this agent uses
pluginRootEnvVar: MYAGENT_PLUGIN_ROOT  # env var Myco checks to detect the active agent at hook time
resumeCommand: "my-agent resume {sessionId}"  # optional, {sessionId} placeholder
hookFields:                         # canonical name → agent-specific payload field name
  sessionId: session_id             # most agents; Windsurf uses trajectory_id, VS Code uses sessionId
  transcriptPath: transcript_path
  lastResponse: last_assistant_message
  # sessionIdEnv: MYAGENT_SESSION_ID  # optional fallback when session_id is not in stdin
capture:
  planDirs:
    - .myagent/plans/               # directories Myco watches for plan files (Write/Edit events captured as plan records)
registration:
  hooksTarget: .myagent/settings.json   # file where hooks are written (JSON) OR the plugin file path (plugin-file)
  # hooksFormat: plugin-file            # set when hooks target is a verbatim file, not a JSON merge
  mcpTarget: .myagent/settings.json     # where MCP server entries are written
  # mcpServersKey: mcp                  # default 'mcpServers'; set to 'mcp' for opencode-style agents
  # mcpFormat: toml                     # default 'json'; set to 'toml' for Codex-style agents
  skillsTarget: .agents/skills          # canonical shared skills directory (see SymbiontInstaller.installSkills())
  settingsTarget: .myagent/settings.json   # where permission/auto-approval settings are merged
  # settingsFormat: toml                # default 'json'; set to 'toml' for Codex
  # pluginPackageTarget: .myagent/package.json   # only for plugin-file agents — declares SDK deps
  # instructionsFile: MY-AGENT.md       # only for agents that do NOT read AGENTS.md natively
```

**Which targets to set:** only the ones that apply. Omit any target the agent doesn't support — the installer silently skips missing targets.

**`hookFields`** is mandatory and maps Myco's canonical field names to the names the agent uses in hook stdin payloads. At runtime, `normalizeHookInput()` in `src/hooks/normalize.ts` detects the active agent via `pluginRootEnvVar` (or `sessionIdEnv` as a fallback) and applies the mapping before any hook logic runs.

**TOML agents:** Codex uses `config.toml`, so its manifest declares `mcpFormat: toml` and `settingsFormat: toml`. TOML read/write operations go through `src/symbionts/toml-helpers.ts` (`upsertTomlSection` / `removeTomlSectionKeys`). Codex also requires a `[features] codex_hooks = true` block in its settings template — without it, Codex silently ignores all hook registrations.

### 2. Create Template Files

Templates for each agent live under `src/symbionts/templates/<agent-name>/`.

**For JSON-hook agents** (Claude Code, Cursor, Codex, Gemini, VS Code Copilot, Windsurf):

```
src/symbionts/templates/my-agent/
  hooks.json       # merged under the "hooks" key in hooksTarget
  mcp.json         # merged under mcpServersKey (default "mcpServers") in mcpTarget
  settings.json    # deep-merged into settingsTarget
```

Every hook command MUST use the shared cross-platform guard:

```json
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node .agents/myco-hook.cjs hook session-start",
          "timeout": 10
        }
      ]
    }
  ]
}
```

The hook guard script at `.agents/myco-hook.cjs` is installed automatically by `installHookGuard()` — you do NOT wire it by hand. It exits cleanly if `myco-run` is missing on the contributor's machine.

**For plugin-file agents** (opencode):

```
src/symbionts/templates/opencode/
  plugin.ts        # verbatim TypeScript plugin source — copied to .opencode/plugins/myco.ts
  package.json     # declares the plugin SDK dep for Bun to install — copied to .opencode/package.json
  mcp.json         # same as JSON-hook agents (written to opencode.json under the "mcp" key)
  settings.json    # written to opencode.json under the "permission" key
```

The plugin file must include two markers near the top:
```ts
// Managed by Myco. Regenerated on `myco update`. Edit src/symbionts/templates/opencode/plugin.ts in the Myco repo instead.
// myco:plugin-marker:opencode
```
The second line is the uninstall safety marker — `uninstallPluginHookFile()` only deletes files whose content contains `myco:plugin-marker`, so hand-edited files are preserved.

### 3. The Hook Guard (automatic)

`.agents/myco-hook.cjs` is the shared cross-platform guard. It's installed by `SymbiontInstaller.installHookGuard()` whenever any agent with `hooksTarget` is installed. You reference it from hook commands (`node .agents/myco-hook.cjs hook <event>`) but you never edit it from agent templates — the canonical source is `src/symbionts/templates/hook-guard.cjs`.

### 4. Hook Payload Normalization

If the agent's hook payloads use different field names than Claude Code's defaults, declare the mapping in `hookFields`:

```yaml
hookFields:
  sessionId: trajectory_id          # Windsurf uses trajectory_id
  transcriptPath: transcript_path
  lastResponse: last_assistant_message
  toolName: tool_info.command_line  # dot-path for nested fields is supported
  sessionIdEnv: MYAGENT_SESSION_ID  # fallback env var when session_id not in stdin
```

`normalizeHookInput()` applies this mapping at the start of every hook invocation.

### 5. Instruction File (only if needed)

If the agent does **not** read `AGENTS.md` natively, declare `instructionsFile: MY-AGENT.md` in the manifest. `installInstructions()` writes a thin stub deferring to `AGENTS.md`, or prepends a reference block if the file already exists (idempotent).

Agents that read `AGENTS.md` natively — **Cursor, Codex, Windsurf, opencode** — must NOT declare `instructionsFile`, or they'll get an unnecessary stub written at init time.

### 6. Transcript Adapter — OPTIONAL

Myco's intelligence pipeline can reconstruct conversation turns either from an on-disk transcript file (when the agent provides one) or from the buffered hook events (fallback). Implementing a transcript adapter lets session notes include accurate conversation text.

**Skip this step** if the agent does not expose its transcript as a file on disk — opencode is the reference example: its messages are served programmatically via the SDK, and Myco reconstructs turns from the buffer instead.

**If you do implement one:** create `src/symbionts/<name>.ts` (NOT `src/symbionts/adapters/<name>.ts` — that subdirectory does not exist). Export a `SymbiontAdapter` with `findTranscript(sessionId)` and `parseTurns(content)`. Reuse `parseJsonlTurns` from `src/symbionts/adapter.ts` if the agent uses a JSONL format similar to Claude Code or Cursor. Register the adapter in `src/symbionts/registry.ts` `ALL_ADAPTERS`.

**Common format pitfalls:**
- JSONL (one JSON object per line) — parse line by line.
- Single JSON file with a `messages` array — parse the whole file as JSON.
- Delta JSONL (state-replay format) — must replay deltas in sequence.

### 7. Test the Integration

```sh
make check               # lint + vitest run — MUST be clean before proceeding
make build               # compiles and copies templates to dist/

# Manual lifecycle test in a throwaway directory
mkdir -p /tmp/myagent-test/.myagent && cd /tmp/myagent-test
myco-dev init --non-interactive
myco-dev doctor          # should list the new symbiont as registered
myco-dev update          # should report "Everything is up to date" on a no-op run
myco-dev remove --symbiont my-agent   # should clean up all registered files
```

Verify `myco.yaml` in the test project lists the new symbiont under `symbionts:` after init, and that the hook guard `.agents/myco-hook.cjs` exists.

## Plugin-file hook variant (opencode)

Agents with plugin-based hook systems (no JSON hook entries) use a different install path. All of the following fields are additive — JSON-hook agents ignore them.

```yaml
registration:
  hooksTarget: .opencode/plugins/myco.ts     # verbatim file path, NOT a JSON file
  hooksFormat: plugin-file                    # selects installPluginHookFile() over the JSON merge path
  pluginPackageTarget: .opencode/package.json # writes the plugin SDK deps manifest
  mcpTarget: opencode.json
  mcpServersKey: mcp                          # opencode puts MCP servers under "mcp", not "mcpServers"
  settingsTarget: opencode.json
  skillsTarget: .agents/skills
```

**The plugin template file** (`templates/opencode/plugin.ts`) is copied verbatim — no substitutions, no templating. It must:
1. Start with the two marker comments (`// Managed by Myco...` and `// myco:plugin-marker:<agent>`).
2. Set `process.env.OPENCODE_PLUGIN_ROOT = directory` at plugin init so Myco's hook CLI detects the active agent via the standard `pluginRootEnvVar` mechanism (no new detection code needed).
3. Spawn hooks with `node .agents/myco-hook.cjs hook <name>` piped JSON payload. The `2>/dev/null || true` guard makes missing-Myco a no-op.
4. Forward `input.args` (not `output.metadata`) as `tool_input` for `tool.execute.after` events — `args` is where file paths live for write/edit/patch tools, which plan-capture needs.

**The plugin package.json** declares the plugin SDK as a dep so the agent's package manager (opencode uses Bun) installs it at startup. It is **preserved on uninstall** — contributors may have added their own deps.

**The `mcpServersKey` field** tells the installer which top-level JSON key holds MCP server entries. Downstream code that inspects MCP state (e.g., `src/cli/doctor.ts`) must also resolve this key via the manifest, not hardcode `mcpServers`.

## Common Pitfalls

**Missing `hookFields` for camelCase or nested fields.** Many agents use non-snake-case names (VS Code uses `sessionId` not `session_id`; Windsurf uses `trajectory_id`). Declare the mapping in `hookFields` — do NOT special-case this in hook scripts or `normalizeHookInput`.

**Missing or wrong `settingsFormat` / `mcpFormat` for TOML agents.** Codex uses `config.toml`. Without `settingsFormat: toml` + `mcpFormat: toml`, the installer writes JSON syntax into a TOML file and silently corrupts the agent's config. Codex hooks additionally require `[features] codex_hooks = true` in the settings template — without it, Codex ignores hook registrations silently.

**Wrong `mcpServersKey`.** opencode stores MCP entries under `mcp`, not `mcpServers`. If you add a new agent with a non-standard key and forget to set `mcpServersKey`, the installer writes the entries under the wrong key and the agent never sees them.

**Hardcoded `mcpServers` in downstream consumers.** When adding code that inspects MCP state (doctor checks, config validators), always resolve the key via `reg.mcpServersKey ?? 'mcpServers'` — never hardcode the string. `src/cli/doctor.ts` is the canonical example of how to do this right.

**Forgetting the `myco:plugin-marker` header in plugin-file templates.** Without the marker, `uninstallPluginHookFile()` refuses to delete the file on the assumption that it was hand-edited. The template MUST include the marker or uninstall becomes a no-op.

**`instructionsFile` for AGENTS.md-native agents.** Cursor, Codex, Windsurf, and opencode all read `AGENTS.md` natively. Declaring `instructionsFile` for them writes an unnecessary stub on every init.

**Forgetting to add plan directories to `capture.planDirs`.** Plans written by the agent to a project-local directory (e.g., `.opencode/plans/`, `.claude/plans/`) are captured by Myco only if that directory is listed in the manifest's `capture.planDirs`. Without it, plan-mode workflows produce no plan records.

**opencode tool naming: `plan-capture.ts` is case-sensitive.** opencode uses lowercase tool names (`write`, `edit`, `patch`) and camelCase argument fields (`filePath`), unlike Claude Code's PascalCase (`Write`) and snake_case (`file_path`). `src/daemon/plan-capture.ts` handles both sets — if you add another agent with a different naming convention, extend `FILE_WRITE_TOOLS` and the `filePath` field fallback in `isPlanWriteEvent()`.
