import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_AGENTS_STARTER = `# Project Rules

<!-- This starter file was created by Myco. Replace it with your project's rules and conventions. -->

Rules haven't been defined yet. Use the /rules skill to generate project rules, or edit this file directly.
`;

/**
 * Check if a command string belongs to Myco.
 *
 * Three legacy shapes we still need to recognize so uninstall / re-install
 * can strip old entries cleanly:
 *   1. `.agents/myco-run.cjs`  — current hook guard entry point
 *   2. `.agents/myco-hook.cjs` — prior cross-platform guard (pre-rename)
 *   3. `myco-run` bare         — published MCP entry point and old shell shim
 *
 * Any of these signals "this is our group, safe to replace on reinstall."
 */
export function isMycoHookCommand(command: string): boolean {
  return (
    command.includes('.agents/myco-run.cjs') ||
    command.includes('.agents/myco-hook.cjs') ||
    command.startsWith('myco-run')
  );
}

/**
 * Check if a hook group is Myco-owned.
 * Handles both nested format (Claude Code, Codex, etc.) and flat format (Windsurf).
 *
 * Nested: { hooks: [{ command: "cd \"$(git rev-parse ...)\" && node .agents/myco-run.cjs ..." }] }
 * Flat:   { command: "cd \"$(git rev-parse ...)\" && node .agents/myco-run.cjs ..." }
 */
export function isMycoHookGroup(group: Record<string, unknown>): boolean {
  // Nested format: { hooks: [{ command: "..." }] }
  if (Array.isArray(group.hooks) && group.hooks.some((h: { command?: string }) => h.command && isMycoHookCommand(h.command))) return true;
  // Flat format: { command: "..." }
  if (typeof group.command === 'string' && isMycoHookCommand(group.command)) return true;
  return false;
}

/**
 * Create a starter AGENTS.md if the project doesn't have one.
 * Idempotent — skips if AGENTS.md already exists.
 */
export function ensureAgentsMd(projectRoot: string, packageRoot: string): void {
  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) return;

  const candidates = [
    path.join(packageRoot, 'src/symbionts/templates/agents-starter.md'),
    path.join(packageRoot, 'dist/src/symbionts/templates/agents-starter.md'),
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      fs.writeFileSync(agentsMdPath, content, 'utf-8');
      return;
    } catch { /* try next */ }
  }

  fs.writeFileSync(agentsMdPath, DEFAULT_AGENTS_STARTER, 'utf-8');
}

export function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
  } catch { /* does not exist or is not a symlink — proceed */ }
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(target, linkPath);
}
