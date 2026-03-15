import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectArtifactCandidates, isExcludedPath } from '@myco/artifacts/candidates';
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

  it('excludes CLAUDE.md and other agent rules files', () => {
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Project Rules');

    const result = collectArtifactCandidates(new Set([claudeMd]), { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('excludes plugin command files', () => {
    const cmdPath = path.join(projectRoot, 'commands', 'init.md');
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
    fs.writeFileSync(cmdPath, '# Init Command');

    const result = collectArtifactCandidates(new Set([cmdPath]), { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('excludes plugin skill files', () => {
    const skillPath = path.join(projectRoot, 'skills', 'myco', 'myco.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# Myco Skill');

    const result = collectArtifactCandidates(new Set([skillPath]), { artifact_extensions: ['.md'] }, projectRoot);
    expect(result).toHaveLength(0);
  });

  it('keeps legitimate docs alongside excluded files', () => {
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Rules');
    const specPath = path.join(projectRoot, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# Architecture Spec');

    const result = collectArtifactCandidates(
      new Set([claudeMd, specPath]),
      { artifact_extensions: ['.md'] },
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('docs/spec.md');
  });
});

describe('isExcludedPath', () => {
  it('excludes CLAUDE.md (case-insensitive)', () => {
    expect(isExcludedPath('CLAUDE.md')).toBe(true);
    expect(isExcludedPath('claude.md')).toBe(true);
  });

  it('excludes AGENTS.md and GEMINI.md', () => {
    expect(isExcludedPath('AGENTS.md')).toBe(true);
    expect(isExcludedPath('GEMINI.md')).toBe(true);
  });

  it('excludes nested rules files', () => {
    expect(isExcludedPath('src/CLAUDE.md')).toBe(true);
  });

  it('excludes commands/ directory', () => {
    expect(isExcludedPath('commands/init.md')).toBe(true);
    expect(isExcludedPath('commands/setup-llm.md')).toBe(true);
  });

  it('excludes skills/ directory', () => {
    expect(isExcludedPath('skills/myco/myco.md')).toBe(true);
  });

  it('excludes hooks/ directory', () => {
    expect(isExcludedPath('hooks/session-start')).toBe(true);
  });

  it('excludes .claude-plugin/ directory', () => {
    expect(isExcludedPath('.claude-plugin/plugin.json')).toBe(true);
  });

  it('excludes .claude/ directory', () => {
    expect(isExcludedPath('.claude/settings.json')).toBe(true);
  });

  it('does not exclude legitimate docs', () => {
    expect(isExcludedPath('docs/spec.md')).toBe(false);
    expect(isExcludedPath('docs/superpowers/plans/plan.md')).toBe(false);
    expect(isExcludedPath('src/README.md')).toBe(false);
  });
});
