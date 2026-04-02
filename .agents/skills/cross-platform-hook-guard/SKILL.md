---
name: myco:cross-platform-hook-guard
description: Use this skill when adding, updating, or debugging the cross-platform hook guard (`.agents/myco-hook.cjs`) in this project. Activates whenever you need to ensure Myco's agent hooks work safely across all contributor environments — including Windows (PowerShell, cmd.exe, Git Bash), macOS, and Linux — without breaking contributors who don't have Myco installed. Apply this skill even if the user doesn't explicitly mention cross-platform concerns; any time you're touching symbiont hook templates, `SymbiontInstaller`, or the `.agents/myco-hook.cjs` file itself, this skill applies. Also relevant when onboarding a new symbiont agent that needs hook integration.
managed_by: myco
user-invocable: false
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---

# Implementing the Cross-Platform Hook Guard for OSS Safety

## Why This Exists

Each AI agent symbiont uses a different shell on Windows:
- **Claude Code** always uses Git Bash (POSIX works)
- **Gemini CLI** uses PowerShell (`command -v` fails, needs `Get-Command`)
- **Codex CLI** disables hooks on Windows entirely

A single POSIX guard (`command -v myco-run ...`) in committed hook config silently fails for Gemini users on Windows.

Install-time platform detection doesn't solve this either. Detecting `process.platform` during `myco init` generates a guard correct for the *installer's* machine, but hook configs (`.claude/settings.json`, `.cursor/hooks.json`, etc.) are committed to the repo. A Mac developer commits a POSIX guard; a Windows contributor clones and runs Gemini — the guard fails silently on their machine.

## Prerequisites

- `.agents/myco-hook.cjs` exists in the project root `.agents/` directory
- All symbiont hook configs invoke it as: `node .agents/myco-hook.cjs hook <event-name>`
- `MYCO_AGENT_SESSION` is set in the environment for all executor `query()` calls (see Step 2)

## Steps

### 1. The Guard Script Structure

`.agents/myco-hook.cjs` must be:
- **CommonJS (`.cjs` extension)** — The project `package.json` uses `"type": "module"`, making `.js` files default to ESM. The hook guard uses `require()` and synchronous `fs` calls (no top-level `await`). Using `.js` causes Node to throw `require is not defined in ES module scope`. The `.cjs` extension explicitly overrides the ESM default.
- **A committed file, not a symlink** — A symlink into Myco's install directory breaks in the exact scenario the guard protects against (Myco not installed). The file must run standalone with zero Myco dependency for the not-installed path.
- **Managed by `myco update`** — Never edit it directly in consumer repos; `myco update` keeps it current.

### 2. Agent Session Filtering (Re-Entrancy Guard)

**Critical — platform behavioral change:** Claude Code changed behavior so hooks and marketplace plugins now fire for *all* SDK sessions, including those using `permissionMode: 'bypassPermissions'`. Previously, bypassPermissions sessions bypassed hook and plugin execution entirely.

Myco's agent executor sessions always use `bypassPermissions`. Without an explicit guard, hooks fire re-entrantly during every agent pipeline `query()` call, loading plugins and calling back into the hook guard in a loop.

The guard script must check for `MYCO_AGENT_SESSION` at the very top, before invoking `myco-run`:

```javascript
// Re-entrancy guard: skip hooks inside agent executor sessions
if (process.env.MYCO_AGENT_SESSION) {
  process.exit(0);
}
```

`executor.ts` sets `MYCO_AGENT_SESSION=1` in the environment for every `query()` call. Any hook invocation that sees this variable is an agent pipeline run — exit silently with code 0.

### 3. Error Taxonomy: What to Surface vs Silence

**Silent exit (code 0):**
- `ENOENT` — `myco-run` not found on PATH (Myco not installed)
- Exit code 127 — command not found (shell form of ENOENT)

**Surface to user (non-zero exit):**
1. Stale `myco-run` wrapper after uninstall — binary on PATH but Myco removed
2. Permission errors — `myco-run` exists but not executable (corrupted install, missing `chmod +x`)
3. Node.js version mismatch — Myco requires Node 22+; older versions crash on optional chaining/top-level await
4. Vault not initialized — `myco init` never ran; binary and daemon present but vault missing
5. Daemon connection failures — socket stale or daemon crashed

The pattern: `ENOENT`/exit 127 means "not installed" → silent. Anything else means "installed but broken" → surface to the user.

### 4. Scope: Hooks Only, Not MCP

The guard applies to hook commands only. MCP errors surface once at session start (or are silently retried by the client). Hook errors fire on *every prompt and every tool call* — a broken hook floods the user throughout the entire session. MCP also requires Myco to be installed to function, making the not-installed silent-skip logic irrelevant for MCP commands.

### 5. SymbiontInstaller Detection

`isMycoHookGroup()` in `SymbiontInstaller` must recognize both the current and legacy hook command prefixes for backward compatibility during `myco update` transitions:
- Current: `node .agents/myco-hook.cjs`
- Legacy: `myco-run` (pre-hook-guard era)

### 6. Cursor Hooks Format

Cursor's hooks system lives at `.cursor/hooks.json` (standalone file, not embedded in settings), with 9 lifecycle events in flat camelCase format — identical structure to Windsurf:

```
sessionStart, beforeSubmitPrompt, postToolUse, postToolUseFailure,
stop, sessionEnd, subagentStart, subagentStop, preCompact
```

Top-level `version: 1` field is required. The manifest needs `hooksTarget: .cursor/hooks.json`.

### 7. Testing

Run `myco update` against the project itself rather than manually editing hook configs. This exercises the real install code path and validates the guard end-to-end. A single `.agents/myco-hook.cjs` is installed once; all hook configurations reference it via relative paths — no duplication across hook entries.

## Common Pitfalls

### `bypassPermissions` no longer suppresses hook execution

**Platform change (2026-04):** Claude Code hooks and marketplace plugins now fire for *all* SDK sessions, including those using `permissionMode: 'bypassPermissions'`. Previously, bypassPermissions bypassed hook execution entirely.

Without the `MYCO_AGENT_SESSION` guard (Step 2), Myco's agent executor sessions re-entrantly trigger hooks on every `query()` call, loading marketplace plugins and calling back into the guard. Always check this env var at the very top of the guard script — before any other logic.

**SDK escape hatches** for consumers who need additional control over hook/plugin execution:
- `--strict-mcp-config` CLI flag — suppresses hook and plugin loading for the process
- `plugins` option on `query()` — per-call override to control plugin execution

### Using `.js` instead of `.cjs`

The project's `"type": "module"` in `package.json` makes all `.js` files ESM by default. The hook guard's CommonJS `require()` calls throw `require is not defined in ES module scope`. Always use the `.cjs` extension.

### Installing as a symlink

Symlinking into Myco's install directory breaks when Myco is uninstalled — the exact scenario the guard is designed to handle. The file must be committed directly to the repo.

### `execFile('start', [url])` silently fails on Windows

`start` is a cmd.exe shell builtin, not a standalone executable. `execFile` expects a real binary. Use `exec('start ' + url)` or `exec('cmd /c start ' + url)` instead to route through the shell.

### Install-time platform detection for committed hook configs

Generating a platform-specific guard during `myco init` produces a guard correct for the installer's machine only. Hook configs are committed to the repo — every contributor runs them on their own machine. A POSIX guard committed by a Mac developer silently fails for Gemini CLI users on Windows.
