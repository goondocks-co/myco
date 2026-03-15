import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { migrateMemoryFiles } from '@myco/daemon/main';

describe('migrateMemoryFiles', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-migrate-'));
    fs.mkdirSync(path.join(vaultDir, 'memories'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeMemoryFile(filename: string, observationType: string): void {
    const fm = { type: 'memory', id: filename.replace('.md', ''), observation_type: observationType, created: new Date().toISOString() };
    const content = `---\n${YAML.stringify(fm)}---\n\n# Test`;
    fs.writeFileSync(path.join(vaultDir, 'memories', filename), content);
  }

  it('moves flat memory files into type subdirectories', () => {
    writeMemoryFile('gotcha-abc123-123.md', 'gotcha');
    writeMemoryFile('decision-abc123-456.md', 'decision');

    const moved = migrateMemoryFiles(vaultDir);

    expect(moved).toBe(2);
    expect(fs.existsSync(path.join(vaultDir, 'memories/gotcha/gotcha-abc123-123.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'memories/decision/decision-abc123-456.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'memories/gotcha-abc123-123.md'))).toBe(false);
  });

  it('normalizes underscores to hyphens in directory name', () => {
    writeMemoryFile('bug_fix-abc123-789.md', 'bug_fix');

    migrateMemoryFiles(vaultDir);

    expect(fs.existsSync(path.join(vaultDir, 'memories/bug-fix/bug_fix-abc123-789.md'))).toBe(true);
  });

  it('skips files already in subdirectories', () => {
    fs.mkdirSync(path.join(vaultDir, 'memories/gotcha'), { recursive: true });
    const subFile = path.join(vaultDir, 'memories/gotcha/gotcha-abc123-123.md');
    fs.writeFileSync(subFile, '---\ntype: memory\n---\n\n# Test');

    const moved = migrateMemoryFiles(vaultDir);

    expect(moved).toBe(0);
    expect(fs.existsSync(subFile)).toBe(true);
  });

  it('skips files with missing observation_type', () => {
    const fm = { type: 'memory', id: 'broken' };
    fs.writeFileSync(
      path.join(vaultDir, 'memories/broken.md'),
      `---\n${YAML.stringify(fm)}---\n\n# Broken`,
    );

    const moved = migrateMemoryFiles(vaultDir);

    expect(moved).toBe(0);
    expect(fs.existsSync(path.join(vaultDir, 'memories/broken.md'))).toBe(true);
  });

  it('is idempotent — running twice moves nothing on second run', () => {
    writeMemoryFile('gotcha-abc123-123.md', 'gotcha');

    migrateMemoryFiles(vaultDir);
    const secondRun = migrateMemoryFiles(vaultDir);

    expect(secondRun).toBe(0);
  });
});
