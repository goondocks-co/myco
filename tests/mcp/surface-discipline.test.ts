/**
 * Structural test that the MCP tool surface stays read/editorial — no
 * administrative primitives reachable from any handler under
 * `packages/myco/src/tools/`.
 *
 * Why this exists: Bucket K (2026-05-17) reversed the boundary erosion
 * caused by Bucket F's "agent-native parity" misread, which had added
 * `myco_maintenance`, `myco_update`, and `myco_skill_candidates` —
 * tools that drove daemon lifecycle, npm-install, and skill-candidate
 * state mutation. The external compound-engineering-plugin's
 * agent-native-reviewer agent uses generic "agent" terminology and
 * doesn't know about Myco's Symbiont/User boundary. This test makes
 * the boundary structural: the next reviewer pass that tries to add
 * an admin tool fails CI before review.
 *
 * The boundary in plain English:
 *   - MCP tools serve Symbionts (Claude Code, Cursor, etc.)
 *   - Symbionts use Myco; they do not control it
 *   - Admin ops (restart, update, restore, db maintenance, lifecycle)
 *     belong to the CLI and UI — not the MCP wire
 *
 * See `docs/architecture/actors-and-boundaries.md`.
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../packages/myco/src/tools');

/**
 * Import paths that an MCP tool handler must NEVER pull in. Each one is
 * an administrative primitive — touching it from a tool surface means
 * the tool is doing something Symbionts should not do. If you have a
 * legitimate need for one of these, the right place is the CLI or the
 * daemon HTTP API, not the MCP tool surface.
 */
const BANNED_IMPORT_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /from\s+['"]@myco\/daemon\/api\/restart(\.js)?['"]/,
    why: 'daemon restart handler is for /api/restart, not MCP tools',
  },
  {
    pattern: /from\s+['"][^'"]*\/daemon\/intent(\.js)?['"]/,
    why: 'intent file writers (writeRestartIntent/writeUpdateIntent) are admin primitives',
  },
  {
    pattern: /from\s+['"][^'"]*\/daemon\/self-reconcile(-wiring)?(\.js)?['"]/,
    why: 'self-reconcile machinery drives the daemon lifecycle',
  },
  {
    pattern: /from\s+['"][^'"]*\/daemon\/update-installer(\.js)?['"]/,
    why: 'update-installer spawns the post-install script — admin only',
  },
  {
    pattern: /from\s+['"]@myco\/service\/manager(\.js)?['"]/,
    why: 'ServiceManager drives launchctl/systemctl — admin only',
  },
  {
    pattern: /from\s+['"]node:child_process['"]/,
    why: 'spawn/exec from a tool handler is almost always an admin escape hatch',
  },
];

function readToolSourceFiles(): { relPath: string; source: string }[] {
  const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      relPath: `packages/myco/src/tools/${entry.name}`,
      source: fs.readFileSync(path.join(TOOLS_DIR, entry.name), 'utf-8'),
    }));
}

describe('MCP tool surface discipline', () => {
  const files = readToolSourceFiles();

  it('has files to check (guard against silent test no-op)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no tool source file imports administrative primitives', () => {
    const violations: { file: string; pattern: string; why: string }[] = [];
    for (const file of files) {
      for (const { pattern, why } of BANNED_IMPORT_PATTERNS) {
        if (pattern.test(file.source)) {
          violations.push({ file: file.relPath, pattern: pattern.source, why });
        }
      }
    }
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file} matches ${v.pattern}\n      reason: ${v.why}`)
        .join('\n');
      throw new Error(
        `MCP tool surface discipline violation — tools must stay read/editorial.\n${detail}\n\n`
        + 'If you genuinely need to drive an admin op, expose it via the CLI or the daemon\n'
        + 'HTTP API. The MCP surface is for Symbionts (Claude Code, Cursor, etc.) to read\n'
        + 'project intelligence. See docs/architecture/actors-and-boundaries.md.',
      );
    }
    expect(violations).toEqual([]);
  });

  it('no tool source file references the removed admin tool names', () => {
    // Catches stragglers — comments, dead code, copy-paste from old buckets.
    const REMOVED = ['myco_maintenance', 'myco_update', 'myco_skill_candidates'];
    const survivors: { file: string; name: string }[] = [];
    for (const file of files) {
      for (const name of REMOVED) {
        if (file.source.includes(name)) {
          survivors.push({ file: file.relPath, name });
        }
      }
    }
    expect(survivors).toEqual([]);
  });
});
