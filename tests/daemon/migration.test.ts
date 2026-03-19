import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { migrateSporeFiles } from '@myco/daemon/main';

describe('migrateSporeFiles', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-migrate-'));
    fs.mkdirSync(path.join(vaultDir, 'spores'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeSporeFile(filename: string, observationType: string): void {
    const fm = { type: 'spore', id: filename.replace('.md', ''), observation_type: observationType, created: new Date().toISOString() };
    const content = `---\n${YAML.stringify(fm)}---\n\n# Test`;
    fs.writeFileSync(path.join(vaultDir, 'spores', filename), content);
  }

  it('moves flat spore files into type subdirectories', () => {
    writeSporeFile('gotcha-abc123-123.md', 'gotcha');
    writeSporeFile('decision-abc123-456.md', 'decision');

    const moved = migrateSporeFiles(vaultDir);

    expect(moved).toBe(2);
    expect(fs.existsSync(path.join(vaultDir, 'spores/gotcha/gotcha-abc123-123.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'spores/decision/decision-abc123-456.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'spores/gotcha-abc123-123.md'))).toBe(false);
  });

  it('normalizes underscores to hyphens in directory name', () => {
    writeSporeFile('bug_fix-abc123-789.md', 'bug_fix');

    migrateSporeFiles(vaultDir);

    expect(fs.existsSync(path.join(vaultDir, 'spores/bug-fix/bug_fix-abc123-789.md'))).toBe(true);
  });

  it('skips files already in subdirectories', () => {
    fs.mkdirSync(path.join(vaultDir, 'spores/gotcha'), { recursive: true });
    const subFile = path.join(vaultDir, 'spores/gotcha/gotcha-abc123-123.md');
    fs.writeFileSync(subFile, '---\ntype: spore\n---\n\n# Test');

    const moved = migrateSporeFiles(vaultDir);

    expect(moved).toBe(0);
    expect(fs.existsSync(subFile)).toBe(true);
  });

  it('skips files with missing observation_type', () => {
    const fm = { type: 'spore', id: 'broken' };
    fs.writeFileSync(
      path.join(vaultDir, 'spores/broken.md'),
      `---\n${YAML.stringify(fm)}---\n\n# Broken`,
    );

    const moved = migrateSporeFiles(vaultDir);

    expect(moved).toBe(0);
    expect(fs.existsSync(path.join(vaultDir, 'spores/broken.md'))).toBe(true);
  });

  it('is idempotent — running twice moves nothing on second run', () => {
    writeSporeFile('gotcha-abc123-123.md', 'gotcha');

    migrateSporeFiles(vaultDir);
    const secondRun = migrateSporeFiles(vaultDir);

    expect(secondRun).toBe(0);
  });
});
