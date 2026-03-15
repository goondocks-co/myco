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

  it('extracts candidates from Write events', () => {
    const specPath = path.join(projectRoot, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# My Spec\n\nSpec content.');

    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: specPath } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('docs/spec.md');
    expect(result[0].content).toContain('My Spec');
  });

  it('extracts candidates from Edit events', () => {
    const specPath = path.join(projectRoot, 'docs', 'design.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# Design Doc');

    const events = [
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: specPath } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('docs/design.md');
  });

  it('filters out non-matching extensions', () => {
    const tsPath = path.join(projectRoot, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(tsPath), { recursive: true });
    fs.writeFileSync(tsPath, 'export const x = 1;');

    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: tsPath } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('filters out gitignored files', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
    const ignoredPath = path.join(projectRoot, 'node_modules', 'pkg', 'README.md');
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(ignoredPath, '# Package README');

    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: ignoredPath } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('drops candidates when file no longer exists on disk', () => {
    const gone = path.join(projectRoot, 'docs', 'deleted.md');

    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: gone } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('deduplicates to unique paths', () => {
    const specPath = path.join(projectRoot, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# Final Version');

    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: specPath } },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: specPath } },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: specPath } },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(1);
  });

  it('ignores non-Write/Edit events', () => {
    const events = [
      { type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/some/file.md' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      { type: 'user_prompt', prompt: 'hello' },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when no events have file paths', () => {
    const events = [
      { type: 'tool_use', tool_name: 'Write', tool_input: {} },
    ];

    const result = collectArtifactCandidates(events, { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });
});
