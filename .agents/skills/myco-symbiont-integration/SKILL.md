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
  and source==exec capture filter for sub-agent phantom defense.
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
- Familiarity with `src/capture/` directory layout: `manifest-schema.ts`, `parsers/`, `rules/`, `installer/`

---

## Procedure 1: Author the Capture Manifest

The manifest is the authoritative description of a symbiont. It lives in `src/capture/manifests/<symbiont-id>.ts` and is validated against `CaptureManifestSchema` at load time.

### 1.4 registration.mcpCwd Field for Portable MCP Launch

**Problem:** MCP servers spawned from hooks run with `cwd` from the hook's execution context. If the agent changes directories between hook invocation and MCP spawn, the MCP process uses a different working directory, breaking file resolution for relative paths in MCP payloads.

**Solution:** Add `registration.mcpCwd` to the manifest:

```ts
registration: {
  mcpCwd: process.env.PROJECT_ROOT || '/absolute/path',  // absolute path
}
```

This path is stored in the generated hook script at install time. When the MCP server spawns, the hook explicitly sets `cwd` to `mcpCwd` **before** spawning the child process:

```bash
cd "$MYCO_MCP_CWD" && node bin/myco-run ...  # spawn with fixed cwd
```

This ensures portable MCP behavior regardless of where the agent changes directory. Always set this field in the manifest and always expand it to an absolute path at install time.

---

## Procedure 4.4: source==exec Filter — 4th Phantom Defense Layer

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