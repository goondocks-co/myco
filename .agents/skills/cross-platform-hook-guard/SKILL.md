---
name: myco:cross-platform-hook-guard
description: |
  Use this skill when adding, updating, or debugging the cross-platform hook guard (`.agents/myco-hook.cjs`) in this project. Activates whenever you need to ensure Myco's agent hooks work safely across all contributor environments — including Windows (PowerShell, cmd.exe, Git Bash), macOS, and Linux — without breaking contributors who don't have Myco installed. Apply this skill even if the user doesn't explicitly mention cross-platform concerns; any time you're touching symbiont hook templates, `SymbiontInstaller`, or the `.agents/myco-hook.cjs` file itself, this skill applies. Also relevant when onboarding a new symbiont agent that needs hook integration.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cross-Platform Hook Guard for OSS Safety

Myco's hook configurations (`.claude/settings.json`, `.cursor/hooks.json`, etc.) are committed to the repo so all contributors get them automatically. This creates a problem: if those hooks call `myco-run` directly, they silently fail or produce errors on machines where Myco isn't installed — especially on Windows, where POSIX shell guards (`command -v myco-run`) don't exist. The solution is `.agents/myco-hook.cjs`, a single committed Node.js file that acts as the universal hook entrypoint, gracefully handling the "Myco not installed" case on every platform.

## Prerequisites

- Node.js available on the contributor's PATH (safe to assume for this project)
- Understanding of which symbiont agents use hooks (Claude Code, Gemini CLI, Windsurf, Cursor, Codex/VS Code)
- `SymbiontInstaller` class located at `src/installer/symbiont-installer.ts` (or equivalent)
- Hook template files for each symbiont agent in `src/installer/templates/` (or equivalent)

## The Shell Matrix Problem

Before writing any code, understand why install-time detection fails:

| Agent | Shell | `command -v` works? |
|---|---|---|
| Claude Code | Git Bash (Windows) | ✅ Yes |
| Gemini CLI | PowerShell | ❌ No |
| Codex / VS Code | Hooks disabled on Windows | N/A |

A Mac developer running `myco init` generates a POSIX-style guard for *their* machine. That guard gets committed. A Windows contributor using Gemini CLI hits PowerShell — and POSIX guards silently fail or throw errors.

The fix: commit a Node.js `.cjs` file that every shell can invoke the same way: `node .agents/myco-hook.cjs hook <event>`.

## Steps

### 1. Create `.agents/myco-hook.cjs`

Create the file at `.agents/myco-hook.cjs` in the project root. It must be CommonJS, not ESM.

**Why `.cjs` and not `.js`?** This project's `package.json` sets `"type": "module"`, which makes `.js` files ESM. ESM files can't use `require()` or synchronous `fs` calls easily, and top-level `await` causes problems in some CI environments. The `.cjs` extension explicitly signals CommonJS regardless of `package.json`.

```js
#!/usr/bin/env node
// .agents/myco-hook.cjs
// Cross-platform hook guard — committed to repo so all contributors get it.
// Wraps `myco-run`; silently exits if Myco is not installed.
'use strict';

const { execFile } = require('child_process');
const args = process.argv.slice(2); // e.g. ['hook', 'session-start']

const child = execFile('myco-run', args, (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (!err) {
    process.exit(0);
  }

  // ENOENT or exit code 127 = "myco-run not on PATH" → this contributor
  // doesn't have Myco installed. Silently succeed so their workflow is
  // unaffected.
  const notInstalled =
    err.code === 'ENOENT' ||
    (err.code === 127) ||
    (typeof err.message === 'string' && err.message.includes('not found'));

  if (notInstalled) {
    process.exit(0);
  }

  // Any other error (stale wrapper, permission denied, Node version mismatch,
  // vault not initialized, daemon connection failure) IS worth surfacing.
  process.stderr.write(`[myco-hook] ${err.message}\n`);
  process.exit(1);
});

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    process.exit(0); // myco-run not installed — silent
  }
  process.stderr.write(`[myco-hook] ${err.message}\n`);
  process.exit(1);
});
```

**Error taxonomy** — know which errors to swallow vs. surface:
- `ENOENT` / exit 127 / "not found" → Myco not installed → **exit 0 silently**
- Everything else → real problem → **write to stderr, exit 1**

**Do not** `require()` any Myco package at the top of this file. If Myco isn't installed, those imports will throw before you can handle the error gracefully.

### 2. Update all symbiont hook templates

Every symbiont agent that has hooks committed to the repo must invoke the guard, not `myco-run` directly. Find the hook template files (typically `src/installer/templates/`) and replace the hook command pattern:

**Before:**
```
myco-run hook session-start
```

**After:**
```
node .agents/myco-hook.cjs hook session-start
```

Do this for all 5 agents: Claude Code (`.claude/settings.json`), Gemini CLI, Windsurf, Cursor (`.cursor/hooks.json`), and Codex/VS Code where hooks are supported.

For Cursor and Windsurf, hook config is a flat JSON file with camelCase event names. The command value is what changes — the file structure stays the same.

### 3. Update `isMycoHookGroup` detection in `SymbiontInstaller`

`SymbiontInstaller` uses an `isMycoHookGroup` predicate to identify existing Myco-managed hooks (so it can update or remove them without touching user hooks). After this change, two prefixes are valid:

```ts
function isMycoHookGroup(cmd: string): boolean {
  return (
    cmd.startsWith('node .agents/myco-hook.cjs') || // new guard
    cmd.startsWith('myco-run') ||                    // legacy — present during update transitions
    cmd.startsWith('myco ')                          // any other legacy forms
  );
}
```

Keep the legacy prefixes until you're confident no live installations still have them. `myco update` will migrate them to the new form, but that takes time across a contributor base.

### 4. Expose lifecycle methods in `SymbiontInstaller`

The installer should be able to install and uninstall the guard file as part of `myco init` / `myco update` / `myco remove`:

```ts
async installHookGuard(projectRoot: string): Promise<void> {
  const dest = path.join(projectRoot, '.agents', 'myco-hook.cjs');
  const src  = path.join(__dirname, '../templates/myco-hook.cjs');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async uninstallHookGuard(projectRoot: string): Promise<void> {
  const dest = path.join(projectRoot, '.agents', 'myco-hook.cjs');
  await fs.rm(dest, { force: true });
}
```

Call `installHookGuard()` during `myco init` and `myco update`. Call `uninstallHookGuard()` during `myco remove`. The `.agents/` directory mirrors the `.agents/skills/` convention already in use.

### 5. Commit the guard file

`.agents/myco-hook.cjs` must be committed to the repository. It's the whole point — the file needs to be present for contributors who clone the repo without running `myco init`.

Check `.gitignore` to ensure `.agents/` is not ignored. The skills directory (`.agents/skills/`) is already committed, so the hook guard should follow naturally.

### 6. Test the guard

```bash
# Simulate "Myco not installed" — rename myco-run temporarily or test in a
# clean PATH environment. The command should exit 0 without any output.
node .agents/myco-hook.cjs hook session-start

# Test with a bad vault (Myco installed but vault missing) — should exit 1
# with a descriptive error to stderr.
```

The most reliable end-to-end test is running `myco update` against the project itself after making changes — this exercises the full installer lifecycle.

## Common Pitfalls

**Symlink instead of committed file** — Don't create a symlink from `.agents/myco-hook.cjs` into Myco's install directory. The whole point is that this file works when Myco isn't installed. A symlink into Myco's install dir breaks in that exact scenario.

**`.js` instead of `.cjs`** — With `"type": "module"` in `package.json`, a `.js` extension means ESM. `require()` will throw a `SyntaxError` before the script does anything useful. Always use `.cjs`.

**`execFile('start', [url])` on Windows** — `start` is a cmd.exe builtin, not a binary. If you're adding Windows `open`-URL behavior elsewhere in the codebase, use `exec('start ' + url)` not `execFile('start', [url])`. Unrelated to the hook guard but a common Windows trap in the same neighborhood.

**Only hooks, not MCP** — The guard applies to hook configs only. MCP server configs surface once at session start and don't need this protection. Don't add the guard to MCP-related config.

**Forgetting the legacy prefix in `isMycoHookGroup`** — During `myco update` transitions, some contributors will have old hook configs with `myco-run` prefixes. If `isMycoHookGroup` only matches the new prefix, the updater won't recognize or replace the old hooks — leading to duplicates.
