import fs from 'node:fs';
import path from 'node:path';

/** Prefix used to identify Myco-owned hooks in settings files. */
const MYCO_HOOK_COMMAND_PREFIX = 'myco-run';

/** Check if a command string belongs to Myco (old or new guard format). */
export function isMycoHookCommand(command: string): boolean {
  return command.startsWith(MYCO_HOOK_COMMAND_PREFIX) || command.includes('.agents/myco-hook.cjs');
}

/**
 * Check if a hook group is Myco-owned.
 * Handles both nested format (Claude Code, Codex, etc.) and flat format (Windsurf).
 *
 * Nested: { hooks: [{ command: "cd \"$(git rev-parse ...)\" && node .agents/myco-hook.cjs ..." }] }
 * Flat:   { command: "cd \"$(git rev-parse ...)\" && node .agents/myco-hook.cjs ..." }
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
}

export function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
  } catch { /* does not exist or is not a symlink — proceed */ }
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(target, linkPath);
}
