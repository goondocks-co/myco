/**
 * The `myco` binary registers the `host` command (decision-48174c9f: host
 * operator orchestration moved from `myco-team` into the main binary).
 * Spawned as a real subprocess — like `tests/mcp/stdio-bridge-auth.test.ts`
 * exercises `cli.ts mcp` — so this proves the dispatch table in `cli.ts`
 * actually wires `host` to `cli/host.js`, not just that the module exists.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CLI_PATH = path.resolve('packages/myco/src/cli.ts');

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('myco CLI registers `host`', () => {
  it('`myco --help` lists `host` in the top-level command list', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*host\s/m);
  }, 30_000);

  it('`myco host --help` dispatches to the host command module', () => {
    const result = runCli(['host', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: myco host <command>/);
    // Flags the parser actually reads. An earlier form of this test pinned
    // `enable --server-url`, which nothing has ever parsed — so the assertion
    // held the phantom in place instead of catching it.
    expect(result.stdout).toMatch(/--designate-fresh/);
    expect(result.stdout).toMatch(/rotate-key/);
    expect(result.stdout).not.toMatch(/--server-url|headscale/i);
  }, 30_000);

  it('`myco host` (bare) exits 2 with usage', () => {
    const result = runCli(['host']);
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Usage: myco host/);
  }, 30_000);
});
