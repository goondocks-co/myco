#!/usr/bin/env node
// Myco global launcher — single absolute entry point used by every symbiont's
// hook + MCP commands under the global install.
//
// One template, two installed copies:
//   - ~/.myco/launcher.cjs       → hook entry point (agent fires hooks here)
//   - ~/.myco/mcp-launcher.cjs   → MCP entry point (agent spawns MCP server here)
//
// The launcher distinguishes its mode from `path.basename(__filename)` and
// honors a layered project-local override before doing anything else: when
// a project ships its own `.agents/myco-run.cjs` / `.agents/myco-cli.cjs`
// (the dogfood / dev pin written by `make dev-link-worktree` and by
// `myco init --project`), this launcher delegates to it. Every other
// invocation falls through to the runtime-resolution chain.
//
// Runtime resolution chain (first match wins):
//   1. Project-local `<projectRoot>/.myco/runtime.command` (highest)
//   2. Machine-global `~/.myco/runtime.command`
//   3. `<core>/vendor/resolved.json` via package-root walk from process.execPath
//   4. PATH `myco` (last resort; may not be on PATH under launchd / GUI agents)
//
// Managed by: myco init / myco update (writes here are owned by the daemon's
// self-reconcile loop via the `intent.refresh-launchers.toml` intent path —
// never edit by hand).
'use strict';

if (process.env.MYCO_AGENT_SESSION) process.exit(0);

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LAUNCHER_TO_OVERRIDE = {
  'launcher.cjs': 'myco-run.cjs',
  'mcp-launcher.cjs': 'myco-cli.cjs',
};

const args = process.argv.slice(2);
const launcherName = path.basename(__filename);
const overrideName = LAUNCHER_TO_OVERRIDE[launcherName] ?? 'myco-run.cjs';

// Anchor cwd to the project the spawning agent is actually working in,
// using whatever project-dir env var that agent provides. Required because
// some agents fire user-level hooks with cwd set to the agent's own dir
// (e.g. Cursor fires from `~/.cursor/`, not the workspace), and we can't
// safely prepend `cd "$X" &&` to the hook command — Cursor's hook spawn
// drops stdin entirely when the command contains shell operators, so the
// pipeline carrying the JSON payload to node breaks and every handler
// silently bails on the missing `session_id` check. Doing the chdir
// inside node-land sidesteps the spawn quirk and keeps every downstream
// `process.cwd()`-based resolver (vault, project-local override walk,
// runtime.command pin walk) pointed at the right tree.
//
// First-match wins. Agents that don't set a project-dir env var fall
// through to whatever cwd the spawn handed us — the original behavior
// for Claude Code, Codex, etc., which always run hooks from the workspace.
const PROJECT_DIR_ENV_VARS = [
  'CURSOR_PROJECT_DIR',
  'CLAUDE_PROJECT_DIR',
  'WINDSURF_PROJECT_DIR',
  'MYCO_PROJECT_ROOT',
];
for (const name of PROJECT_DIR_ENV_VARS) {
  const value = process.env[name];
  if (value && value !== '.') {
    try { process.chdir(value); break; } catch { /* try next */ }
  }
}

// 0. Project-local launcher override.
// Preserves the dogfood path (`make dev-link-worktree` writes
// `.agents/myco-run.cjs` + `.myco/runtime.command` in the dev repo) and
// the deliberate per-project escape hatch from `myco init --project`.
// Walk up from cwd so the check is worktree-aware.
const override = findProjectLocalOverride(process.cwd(), overrideName);
if (override) {
  try {
    execFileSync(process.execPath, [override, ...args], { stdio: 'inherit' });
    process.exit(0);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') process.exit(0);
    process.exit((err && typeof err.status === 'number') ? err.status : 1);
  }
}

const bin = resolveBinary();
if (!bin) {
  // No pin, no vendored binary, no PATH — surface as a tool-error envelope
  // when invoked as the MCP CLI so the agent host sees the failure cleanly,
  // and as a silent exit for hook contexts (which would just spam stderr
  // every keystroke under Cursor).
  if (args[0] === 'tool') writeToolRuntimeUnavailable('myco', args);
  process.exit(args[0] === 'tool' ? 1 : 0);
}

try {
  execFileSync(bin, args, { stdio: 'inherit' });
} catch (err) {
  if (err && typeof err === 'object' && err.code === 'ENOENT') {
    if (args[0] === 'tool') {
      writeToolRuntimeUnavailable(bin, args);
      process.exit(1);
    }
    process.exit(0);
  }
  process.exit((err && typeof err.status === 'number') ? err.status : 1);
}

function findProjectLocalOverride(startDir, basename) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.agents', basename);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not present at this level */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPinFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || null;
  } catch { return null; }
}

function readProjectRuntimeCommand(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const pin = readPinFile(path.join(dir, '.myco', 'runtime.command'));
    if (pin) return pin;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readMachineRuntimeCommand() {
  const home = process.env.MYCO_HOME ? expandHome(process.env.MYCO_HOME) : path.join(os.homedir(), '.myco');
  return readPinFile(path.join(home, 'runtime.command'));
}

function readVendoredBinary() {
  // Walk up from process.execPath looking for the @goondocks/myco core
  // package, then read its vendor/resolved.json for the platform binary
  // path. Works when node is installed inside a Myco bundle layout (npm
  // install, packaged Bun runtime); harmlessly returns null for system
  // node installs where the walk doesn't reach the package.
  const start = path.dirname(process.execPath);
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && pkg.name === '@goondocks/myco') {
        const resolved = path.join(dir, 'vendor', 'resolved.json');
        try {
          const { binaryPath } = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
          if (typeof binaryPath === 'string' && fs.existsSync(binaryPath)) return binaryPath;
        } catch { /* missing or unreadable */ }
        return null;
      }
    } catch { /* no package.json here */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveBinary() {
  const project = readProjectRuntimeCommand(process.cwd());
  if (project) return project;
  const machine = readMachineRuntimeCommand();
  if (machine) return machine;
  const vendored = readVendoredBinary();
  if (vendored) return vendored;
  return 'myco';
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function toolNameFromArgs(args) {
  if (args[0] !== 'tool' || args[1] !== 'call') return undefined;
  for (let idx = 2; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === '--json') continue;
    if (arg === '--input') {
      idx++;
      continue;
    }
    if (arg && !arg.startsWith('-')) return arg;
  }
  return undefined;
}

function writeToolRuntimeUnavailable(command, args) {
  const tool = toolNameFromArgs(args);
  const envelope = {
    ok: false,
    ...(tool ? { tool } : {}),
    error: {
      code: 'runtime_unavailable',
      message: `Myco runtime command '${command}' could not be found. Check <project>/.myco/runtime.command and ~/.myco/runtime.command, or reinstall with: npm install --include=optional -g @goondocks/myco`,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}
