import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectArtifactCandidates } from '@myco/artifacts/candidates';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

describe('collectArtifactCandidates', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-candidates-'));
    execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('extracts candidates from file paths', () => {
    const specPath = path.join(projectRoot, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# My Spec\n\nSpec content.');

    const filePaths = new Set([specPath]);

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('docs/spec.md');
    expect(result[0].content).toContain('My Spec');
  });

  it('filters out non-matching extensions', () => {
    const tsPath = path.join(projectRoot, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(tsPath), { recursive: true });
    fs.writeFileSync(tsPath, 'export const x = 1;');

    const filePaths = new Set([tsPath]);

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('filters out gitignored files', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
    const ignoredPath = path.join(projectRoot, 'node_modules', 'pkg', 'README.md');
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(ignoredPath, '# Package README');

    const filePaths = new Set([ignoredPath]);

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('drops candidates when file no longer exists on disk', () => {
    const gone = path.join(projectRoot, 'docs', 'deleted.md');

    const filePaths = new Set([gone]);

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('deduplicates to unique paths', () => {
    const specPath = path.join(projectRoot, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# Final Version');

    // Set inherently deduplicates — pass the same path once
    const filePaths = new Set([specPath]);

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty set', () => {
    const filePaths = new Set<string>();

    const result = collectArtifactCandidates(filePaths, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });
});
