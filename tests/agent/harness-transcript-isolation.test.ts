import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gate: harness-spawned Claude CLI runs must not write into the transcript
 * directory `claude-code.yaml` declares as its discovery root.
 *
 * The CLI persists every session under `CLAUDE_CONFIG_DIR`, defaulting to
 * `~/.claude` — the same tree a developer's sessions occupy. Left there, agent
 * runs are indistinguishable on disk from a person's work: they carry no
 * origin marker, so anything reading that directory attributes them to
 * whatever project the agent ran in, and Myco ingests its own output.
 *
 * A source scan rather than a live run: the invariant is that every spawn site
 * sets the variable, which is checkable without a CLI or an API key.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_DIR = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'agent', 'harness');

/** Every module that spawns the Claude Code CLI. */
const SPAWN_SITES = ['claude.ts', 'scratch-probe.ts'];

describe('harness transcript isolation', () => {
  it.each(SPAWN_SITES)('%s redirects CLAUDE_CONFIG_DIR away from the user session tree', (file) => {
    const source = fs.readFileSync(path.join(HARNESS_DIR, file), 'utf8');
    expect(source).toContain('CLAUDE_CONFIG_DIR');
  });

  it('finds no unguarded spawn site', () => {
    // A new module resolving the CLI executable is a new spawn site and needs
    // the same redirection; this fails until it is listed and guarded above.
    const unguarded: string[] = [];
    for (const entry of fs.readdirSync(HARNESS_DIR)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(HARNESS_DIR, entry), 'utf8');
      const spawnsCli = source.includes('pathToClaudeCodeExecutable');
      if (spawnsCli && !source.includes('CLAUDE_CONFIG_DIR')) unguarded.push(entry);
    }
    expect(unguarded).toEqual([]);
  });

  it('keeps the redirect target outside the manifest discovery root', () => {
    const manifest = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'myco', 'src', 'symbionts', 'manifests', 'claude-code.yaml'),
      'utf8',
    );
    expect(manifest).toContain('~/.claude/projects');

    const claude = fs.readFileSync(path.join(HARNESS_DIR, 'claude.ts'), 'utf8');
    // Session storage lives under MYCO_HOME, which is never ~/.claude.
    expect(claude).toContain("path.join(resolveMycoHome(), 'agent-sessions')");
  });
});
