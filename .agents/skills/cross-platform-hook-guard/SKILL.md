---
name: myco:cross-platform-hook-guard
description: >
  Use this skill when adding, updating, or debugging the cross-platform hook guard
  (`.agents/myco-hook.cjs`) in this project. Activates whenever you need to ensure
  Myco's agent hooks work safely across all contributor environments — including
  Windows (PowerShell, cmd.exe, Git Bash), macOS, and Linux — without breaking
  contributors who don't have Myco installed. Apply this skill even if the user
  doesn't explicitly mention cross-platform concerns; any time you're touching
  symbiont hook templates, `SymbiontInstaller`, or the `.agents/myco-hook.cjs`
  file itself, this skill applies. Also relevant when onboarding a new symbiont
  agent that needs hook integration.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Implementing the Cross-Platform Hook Guard for OSS Safety

## Prerequisites

- Node.js available in the project (guaranteed by all AI agent symbionts)
- Access to `.agents/myco-hook.cjs` and symbiont manifest files
- Familiarity with the `.agents/` directory conventions

---

## Background: Why This Architecture

### The shell matrix problem

Each symbiont uses a different shell on Windows:
- **Claude Code** — always uses Git Bash (POSIX works)
- **Gemini CLI** — uses PowerShell (`command -v` fails; needs `Get-Command`)
- **Codex CLI** — disables hooks on Windows entirely

A single POSIX guard in committed hook config silently fails for Gemini users on Windows.

### Why install-time detection fails for OSS

Detecting `process.platform` during `myco init` generates a guard correct for the
*installer's* machine, but hook config files (`.claude/settings.json`, etc.) are
committed to the repo. A Mac developer installs and commits a POSIX guard; a Windows
contributor clones and runs Gemini CLI — the committed guard fails in their PowerShell
environment. Install-time conflates the installer's machine with every contributor's machine.

### The solution: `.agents/myco-hook.cjs`

A Node.js script committed to the repo, invoked as:
```
node .agents/myco-hook.cjs hook session-start
```

It wraps `myco-run`, silently exits (code 0) on ENOENT or exit 127 (not installed),
and surfaces real errors. Works in bash, PowerShell, cmd.exe, and Git Bash — anywhere
Node.js runs. Node is guaranteed available because all AI agent symbionts already
require it.

The `.cjs` extension is **required**: Myco's `package.json` uses `"type": "module"`
(ESM default), so `.js` files default to ESM. The hook guard uses `require()` and
synchronous `fs` calls (CommonJS). Using `.js` causes Node to throw
`require is not defined in ES module scope`. The `.cjs` extension explicitly overrides
the ESM default.

The file is managed by `myco update` to stay current and mirrors the existing
`.agents/skills/` convention.

---

## Steps

### 1. Create `.agents/myco-hook.cjs`

The guard has four implementation decisions:

**Error taxonomy — what to surface vs. silence:**
- `ENOENT` / exit 127 ("not on PATH") → silent `exit 0`
- Any other error → surface to user

Do NOT use `2>/dev/null || true` — that silently swallows five categories of real
errors: stale `myco-run` wrapper after uninstall, permission errors, Node.js version
mismatch (requires Node 22+), vault not initialized, and daemon connection failures.
All five occur when Myco is *partially installed* and need to reach the user.

**Distribution — committed `.cjs` file, not a symlink:**
A symlink into Myco's install directory produces a broken-link error in the exact
scenario the guard protects against (Myco not installed). The file must run standalone
with zero Myco dependency for the not-installed path.

**Scope — hooks only, not MCP:**
MCP errors surface once at session start. Hook errors fire on every prompt and every
tool call — a broken hook floods the user with errors throughout the entire session.
MCP also requires Myco to be installed; the not-installed silent-skip logic is
irrelevant for MCP.

**Deployment:**
Single `.agents/myco-hook.cjs` installed once; all hook configurations reference it
via relative paths — no duplication across hook entries. Validate end-to-end by running
`myco update` against the project itself rather than manually editing hooks.

### 2. Update `SymbiontInstaller` detection

`isMycoHookGroup` detection must match **both** prefixes:
- New: `node .agents/myco-hook.cjs`
- Legacy: `myco-run` (for `myco update` transitions from older installs)

Both must be recognized so that `myco update` correctly identifies existing hook groups
during reinstall.

### 3. Wire Cursor symbiont hooks (format reference)

Cursor hooks live at `.cursor/hooks.json` (standalone file, not embedded in settings)
with 9 lifecycle events in flat camelCase format — **identical structure to Windsurf**:

```json
{
  "version": 1,
  "sessionStart": [...],
  "beforeSubmitPrompt": [...],
  "postToolUse": [...],
  "postToolUseFailure": [...],
  "stop": [...],
  "sessionEnd": [...],
  "subagentStart": [...],
  "subagentStop": [...],
  "preCompact": [...]
}
```

Top-level `version: 1` field is required. Because the format matches Windsurf, the
existing flat-hook installer path handles Cursor without modification — only a new
template and `hooksTarget: .cursor/hooks.json` in the manifest are needed.

### 4. Protect internal SDK calls from re-entrancy

Claude Code changed `bypassPermissions` mode so that hooks and marketplace plugins now
fire for **all** SDK sessions — including agent-executor sessions that previously
bypassed them entirely. This triggers re-entrant behavior: internal runs are captured
as user sessions and unwanted browser launches occur.

**Two SDK controls are required on every internal `query()` call:**

```typescript
await query({
  prompt,
  model,
  // Re-entrancy isolation — BOTH required:
  env: { MYCO_AGENT_SESSION: '1' },  // enables hook-guard filtering
  strictMcpConfig: true,             // disables plugin loading
  // ...other options
});
```

`bypassPermissions` is **no longer a reliable escape hatch** for suppressing
hook/plugin execution — it controls permission scope only.

**Call-site completeness is critical.** There are four call sites in the executor
pipeline that require both options:
1. Task runner `query()` call
2. Phase executor `query()` call
3. Sub-agent `query()` call
4. **`executor.ts` orchestrator `query()` call** — this was the final gap; its
   omission caused intermittent session leaks even after the first three were patched

Missing even one call site causes intermittent re-entrancy that is hard to diagnose
because it only fires when that specific code path executes.

**Forward-looking rule:** Every new internal `query()` call added to the executor
pipeline must include both `env: { MYCO_AGENT_SESSION: '1' }` and
`strictMcpConfig: true` from the start, without exception.

**Audit pattern when adding a new `query()` call:**
```bash
grep -r "await query(" src/agent/ --include="*.ts"
# Verify every result has both MYCO_AGENT_SESSION and strictMcpConfig
```

### 5. Verify before deploying hook-system changes

For any change to the hook mechanism — guard script content, SDK re-entrancy isolation,
hook registration — **pre-release smoke testing is non-negotiable**.

An incorrect fix to the hook system breaks all subsequent session captures, not just the
session under test. The failure mode is silent: sessions stop being recorded, and the
root cause (broken hook) is invisible to the developer.

Verification protocol before releasing a hook-related hotfix:
1. Start a fresh Claude Code session in the project
2. Confirm the session appears in `myco sessions` (capture working)
3. Confirm no duplicate/re-entrant sessions are created (isolation working)
4. Only then publish and run `myco update`

---

## Common Pitfalls

**`.js` vs `.cjs` extension**
Myco uses `"type": "module"` in `package.json`. Using `.js` causes
`require is not defined in ES module scope`. Always use `.cjs` for the hook guard.

**`execFile` vs `exec` for Windows shell builtins**
`execFile('start', [url])` silently fails on Windows because `start` is a cmd.exe
shell builtin, not a standalone executable. Use `exec('start ' + url)` or
`exec('cmd /c start ' + url)` to go through the shell and resolve builtins. Applies
to the `myco open` CLI Windows branch; the macOS (`open`) and Linux (`xdg-open`)
branches use standalone executables and work with `execFile`.

**Incomplete `isMycoHookGroup` detection**
If you add a new hook prefix or rename the guard script, update `isMycoHookGroup` in
`SymbiontInstaller` immediately. Missing a prefix means `myco update` fails to
recognize existing hook groups during reinstall and creates duplicates.

**Incomplete call-site audit for MYCO_AGENT_SESSION**
When patching re-entrancy isolation, grep for ALL `await query(` calls in
`src/agent/` before declaring the fix complete. The executor.ts orchestrator query was
missed in the first round, causing persistent intermittent leaks. Three patches is not
the same as four.

**Assuming `bypassPermissions` suppresses hooks**
It does not, as of the Claude Code update that changed this behavior.
`bypassPermissions` controls permission scope only. Re-entrancy isolation requires
explicit `MYCO_AGENT_SESSION` + `strictMcpConfig` on every internal SDK call.
