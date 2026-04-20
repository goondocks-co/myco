---
name: myco:myco-symbiont-integration
description: >-
  Use this skill when adding or maintaining a Myco symbiont integration,
  or debugging capture-pipeline and installer issues for a supported agent.
  It covers manifests, hook templates, transcript parsing, image and
  attachment format differences, declarative capture rules, the cross-platform
  hook guard, SymbiontInstaller wiring, installer fixtures, session identity,
  phantom-session defenses, environment-variable injection, transcript
  path parsing failures, registration.mcpCwd field for portable MCP launch,
  SDK-specific MCP configuration requirements (Claude SDK auto-loading,
  OpenAI strict function-calling, strictMcpConfig, settingSources control),
  Runtime.command redirect mechanisms, substituteRuntimeCommand flag for
  PATH collision handling, OpenCode SIGTERM layered fixes, scratchProbe()
  session validation, installer skill discovery, and source==exec capture 
  filter for sub-agent phantom defense.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Building and Maintaining a Myco Symbiont Integration

A **symbiont** is an agent or IDE integration (Claude Code, Codex, Cursor, Zed, VS Code extension, etc.) that Myco captures session data from. Adding one requires coordinated changes across five layers: the manifest, hook templates, transcript parser, capture rules, and installer. Each layer has its own file locations and failure modes. This skill walks through all of them in the order you'd encounter them when shipping a new symbiont from scratch, or when modifying an existing one.

## Prerequisites

- Myco source is checked out and building (`pnpm build` passes)
- You know the target agent's hook lifecycle events (session start, prompt, stop) and where it writes transcript/log files
- You have at least one real session transcript from the target agent to test against
- Familiarity with `src/symbionts/` directory layout: `manifest-schema.ts`, `manifests/`, and `src/capture/` for parsers, rules, installer

---

## Procedure 1: Author the Capture Manifest

The manifest is the authoritative description of a symbiont. It lives in `src/symbionts/manifests/<symbiont-id>.yaml` and is validated against `CaptureManifestSchema` at load time.

### 1.4 registration.mcpCwd Field for Portable MCP Launch

**Problem:** MCP servers spawned from hooks run with `cwd` from the hook's execution context. If the agent changes directories between hook invocation and MCP spawn, the MCP process uses a different working directory, breaking file resolution for relative paths in MCP payloads.

**Solution:** Add `registration.mcpCwd` to the manifest:

```yaml
registration:
  mcpCwd: /absolute/path  # absolute path, often PROJECT_ROOT
```

This path is stored in the generated hook script at install time. When the MCP server spawns, the hook explicitly sets `cwd` to `mcpCwd` **before** spawning the child process:

```bash
cd "$MYCO_MCP_CWD" && node bin/myco-run ...  # spawn with fixed cwd
```

This ensures portable MCP behavior regardless of where the agent changes directory. Always set this field in the manifest and always expand it to an absolute path at install time.

---

## Procedure 2: SDK-Specific MCP Configuration

Different agent SDKs have distinct MCP integration patterns and requirements that affect symbiont design:

### 2.1 Claude SDK Auto-Loading Behavior

**Issue:** The Claude SDK automatically loads all user-configured plugins and MCP servers, including Myco's MCP server. This can create initialization conflicts or duplicate tool registrations if not handled properly.

**Solution:** Ensure Myco's MCP server gracefully handles multiple initialization attempts and doesn't conflict with other user MCP configurations.

### 2.2 OpenAI Strict Function-Calling Incompatibilities

**Issue:** OpenAI agents using strict function-calling mode reject Zod schemas with refinements (`.refine()` calls), causing MCP tool registration failures.

**Solution:** For OpenAI-compatible symbionts, ensure MCP tool schemas use only basic Zod types without refinements:

```ts
// AVOID for OpenAI strict function-calling
const schema = z.string().refine(s => s.length > 0);

// USE instead
const schema = z.string().min(1);
```

### 2.3 Claude SDK strictMcpConfig and settingSources Control

**Issue:** The Claude SDK requires `strictMcpConfig: true` in its configuration to properly validate MCP server registration and tool schemas. Additionally, the Claude SDK's `settingSources: []` controls which configuration sources are loaded.

**Solution:** Ensure Claude SDK-based symbionts pass the correct flags:

```ts
// Required for Claude SDK
const config = {
  strictMcpConfig: true,
  settingSources: [], // empty array prevents unwanted config loading
  // ... other config
};
```

The `settingSources: []` setting prevents the SDK from loading configuration that might conflict with Myco's MCP setup.

---

## Procedure 3: Runtime Command Redirection and PATH Collision Handling

### 3.1 Runtime.command Redirect Mechanism

**Issue:** Some agents (particularly OpenCode) need to redirect runtime commands through Myco's execution wrapper to ensure proper session context and capture pipeline integration.

**Solution:** Use the Runtime.command redirect mechanism in `bin/myco-run`:

```ts
// In the agent's runtime configuration
Runtime.command = 'myco-run';  // redirect through myco wrapper
```

This ensures that command execution goes through Myco's capture pipeline, maintaining session context and proper logging.

### 3.2 substituteRuntimeCommand Flag for PATH Collision Issues

**Issue:** GUI applications (like OpenCode) can have PATH collisions where the system `node` binary differs from the development `node` binary, causing runtime command failures.

**Solution:** Use the `substituteRuntimeCommand` flag in the manifest:

```yaml
manifest:
  substituteRuntimeCommand: true  # enable PATH collision handling
  # ... other config
```

When this flag is enabled, Myco will substitute the runtime command with an absolute path to avoid PATH-based resolution issues.

### 3.3 PATH Collision Gotchas with GUI Apps

**Common Issue:** GUI applications don't inherit shell PATH modifications (nvm, volta, etc.), causing `node` command resolution to fail or use the wrong binary.

**Symptoms:**
- `env: node: No such file or directory`
- Runtime using system Node instead of development Node
- MCP server startup failures in GUI context

**Fix:** Always use absolute paths for Node binary resolution in GUI-launched contexts:

```ts
const nodeBin = process.execPath;  // absolute path to current node
spawn(nodeBin, ['script.js'], { ... });
```

---

## Procedure 4: OpenCode SIGTERM Handling — Three-Layer Fix

OpenCode has complex SIGTERM handling requirements due to registry rehydration, scope semantics, and buffer fallback behaviors.

### 4.1 Layer 1 — Registry Rehydration

**Issue:** OpenCode's symbiont registry can become stale across SIGTERM boundaries, causing hook lookup failures on restart.

**Solution:** Implement registry rehydration in the hook startup sequence:

```ts
// Force registry refresh on SIGTERM recovery
await rehydrateSymbiontRegistry();
```

### 4.2 Layer 2 — Scope Semantics

**Issue:** SIGTERM can interrupt OpenCode mid-scope, leaving the capture pipeline in an inconsistent state with partially-written session data.

**Solution:** Implement scope boundary detection and cleanup:

```ts
process.on('SIGTERM', async () => {
  await flushPartialScope();  // complete any in-progress scope
  await gracefulShutdown();
});
```

### 4.3 Layer 3 — Buffer Fallback

**Issue:** If SIGTERM occurs during buffer write operations, transcript data can be lost or corrupted.

**Solution:** Implement buffer fallback with persistence:

```ts
// Persist buffer state across SIGTERM boundaries
await persistBufferState();

// On restart, recover from persisted state
await recoverBufferState();
```

All three layers must be present for reliable OpenCode SIGTERM handling.

---

## Procedure 5: Session Validation with scratchProbe() and MYCO_AGENT_SESSION

### 5.1 MYCO_AGENT_SESSION Environment Variable

**Purpose:** The `MYCO_AGENT_SESSION` environment variable provides session context to sub-processes and helps validate session boundaries.

**Usage:** Set during hook initialization:

```bash
export MYCO_AGENT_SESSION="<session-id>"
# ... launch agent with session context
```

This ensures that all child processes inherit the session context, enabling proper session validation and preventing phantom session creation.

### 5.2 scratchProbe() Helper for Session Validation

**Purpose:** The `scratchProbe()` helper function validates session integrity and prevents corrupt session creation.

**Usage:** Call during session startup to validate session state:

```ts
// Validate session before proceeding with capture
const isValidSession = await scratchProbe(sessionId);
if (!isValidSession) {
  // Skip capture for invalid session
  return;
}
```

This helper checks for:
- Session ID validity
- Transcript path accessibility  
- Hook registration status
- Environment variable consistency

---

## Procedure 6: source==exec Filter — 4th Phantom Defense Layer

**Problem:** Codex spawns sub-agent processes (e.g., to run `node` or `python` commands). These sub-agents also have hooks installed and fire their own `session_start` events. Without filtering, each sub-agent invocation creates phantom sessions.

**Solution:** Add a rule in the manifest (or capture rules config) to filter `source==exec` calls:

```yaml
capture:
  rules:
    - source: exec
      event: session_start
      action: skip
      reason: Filter Codex sub-agent spawns (source==exec prevents phantom session creation)
```

When an agent is invoked as a sub-process (source=exec in the environment), this rule drops its events before daemon wake, preventing nested sessions. This is the **4th layer** of phantom session defense:

1. **Layer 1 — Zod schema nullable:** `transcript_path: z.string().nullable()`
2. **Layer 2 — Filter before daemon wake:** `evaluateSessionStartRules()` before `ensureRunning()`
3. **Layer 3 — Complete drop filter:** Project path matching, symbiont identity validation
4. **Layer 4 — source==exec filter:** Block sub-agent invocations by source context

All four layers must be present.

---

## Procedure 7: Installer Integration and Skill Discovery

### 7.1 SymbiontInstaller Registration

Register the new symbiont in the `SymbiontInstaller` class with install, update, remove, and doctor methods:

```ts
// In src/capture/installer/index.ts
symbiont: {
  install: async () => { /* implementation */ },
  update: async () => { /* implementation */ }, 
  remove: async () => { /* implementation */ },
  doctor: async () => { /* implementation */ },
}
```

### 7.2 Installer Skill Discovery Filtering

**Issue:** The installer needs to discover available skills but should filter to only SKILL.md files to avoid false positives from other markdown files.

**Solution:** Implement skill discovery filtering in the installer:

```ts
// Filter skill discovery to SKILL.md files only
const skillFiles = await glob('**\/SKILL.md', { cwd: skillsDir });
const skills = skillFiles.map(file => parseSkillFromPath(file));
```

This ensures that only properly-formatted skill files are discovered and registered, preventing the installer from picking up unrelated markdown files as skills.

---

## Vault Location Resolution

The vault is always `<git-repo-root>/.myco/`. There are no env var overrides — `resolveVaultDir()` walks up to the git common dir and appends `.myco`. If a symbiont's MCP child or hook would otherwise launch with a cwd that breaks discovery, fix it at the launch surface (e.g. set `registration.mcpCwd` in the manifest), not by injecting `MYCO_VAULT_DIR` or `MYCO_PROJECT_ROOT` — those env vars are no longer honored.

---

## Phantom Session Defense — 4-Layer Pattern (Updated)

A phantom session is a vault row created for an interaction that should have been filtered out. All four layers must be present:

**Layer 1 — Zod schema must accept null:**
```typescript
transcript_path: z.string().nullable()  // CORRECT
```

**Layer 2 — Filter BEFORE daemon wake:**
```typescript
// CORRECT — filter fires first; daemon only wakes if session passes
const shouldDrop = await evaluateSessionStartRules(payload);
if (shouldDrop) return;
await ensureRunning();
```

**Layer 3 — Complete drop filter covering:** project path matching, symbiont identity, hook phase suppression, duplicate detection.

**Layer 4 — source==exec filter for sub-agent invocations:**
```yaml
capture:
  rules:
    - source: exec
      action: skip
      reason: Drop Codex sub-agent spawns
```

Verify: stop the daemon, trigger a drop condition (e.g., null transcript_path, or source=exec), confirm `myco daemon status` still reports stopped.

---

## Additional Gotchas (Updated)

**registration.mcpCwd is mandatory for portable MCP** — Without this field, MCP servers spawned from hooks run with agent-context `cwd`, breaking file resolution. Always set this in the manifest and expand to absolute path at install time.

**source==exec filter must be in capture rules config** — `source` is an environment-variable-based filter evaluated by the rules engine. Ensure the filter is present in the YAML manifest, not hardcoded in the hook.

**SDK-specific MCP considerations are critical** — Claude SDK auto-loading, OpenAI strict function-calling limitations, Claude SDK strictMcpConfig requirements, and settingSources control all affect symbiont integration success. Test against target SDK behavior patterns, not just generic MCP specifications.

**Runtime command redirection prevents PATH collisions** — Use Runtime.command redirect and substituteRuntimeCommand flag for GUI applications to avoid NODE binary resolution issues.

**OpenCode SIGTERM requires three-layer handling** — Registry rehydration, scope semantics, and buffer fallback must all be implemented for reliable OpenCode integration.

**Session validation prevents phantom sessions** — Use MYCO_AGENT_SESSION env var and scratchProbe() helper to validate session integrity before capture.

**Installer skill discovery must filter to SKILL.md** — Only discover properly-formatted skill files to prevent false positives from other markdown files.