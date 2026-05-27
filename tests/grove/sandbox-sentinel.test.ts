import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../../packages/myco/src/grove/paths.js';

describe('expandHome — MYCO_SANDBOX_ROOT enforcement', () => {
  const originalEnv = { ...process.env };
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sandbox-test-'));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes through when MYCO_SANDBOX_ROOT is unset (production default)', () => {
    delete process.env.MYCO_SANDBOX_ROOT;
    expect(expandHome('~/.claude/settings.json')).toContain(process.env.HOME ?? os.homedir());
  });

  it('accepts a HOME inside the sandbox', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = sandbox;
    expect(expandHome('~/.claude/settings.json')).toBe(path.join(sandbox, '.claude/settings.json'));
  });

  it('accepts a HOME that is a subdirectory of the sandbox', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = path.join(sandbox, 'home', 'tester');
    expect(expandHome('~/.cursor/hooks.json')).toBe(path.join(sandbox, 'home/tester/.cursor/hooks.json'));
  });

  it('throws when HOME resolves outside the sandbox', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = '/Users/someone-else';
    expect(() => expandHome('~/.claude/settings.json')).toThrow(/MYCO_SANDBOX_ROOT.*set but HOME.*outside/);
  });

  it('throws when HOME is undefined and os.homedir() falls outside the sandbox', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    delete process.env.HOME;
    // os.homedir() returns the developer's real home which is not inside our tmp sandbox.
    if (os.homedir().startsWith(sandbox)) {
      // Skip test if real homedir happens to be under sandbox tmpdir prefix
      return;
    }
    expect(() => expandHome('~/.claude/settings.json')).toThrow(/outside/);
  });

  it('does NOT throw for absolute non-~ paths even when sandbox mismatches', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = '/Users/someone-else';
    // Absolute, non-tilde paths require no home expansion, so the
    // sandbox sentinel has nothing to enforce — passing them through
    // verbatim keeps a leaked MYCO_SANDBOX_ROOT from poisoning
    // unrelated code paths.
    expect(expandHome('/etc/passwd')).toBe('/etc/passwd');
    expect(expandHome('/absolute/no-tilde')).toBe('/absolute/no-tilde');
  });

  it('does NOT throw for relative non-~ paths either', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = '/Users/someone-else';
    expect(expandHome('relative/path')).toBe('relative/path');
  });

  it('honors explicit homeDir argument over env when provided (still verified against sandbox)', () => {
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    process.env.HOME = '/Users/someone-else';
    // Explicit override pointing INTO the sandbox is valid even when env HOME would fail.
    expect(expandHome('~/.codex/hooks.json', sandbox)).toBe(path.join(sandbox, '.codex/hooks.json'));
  });
});
