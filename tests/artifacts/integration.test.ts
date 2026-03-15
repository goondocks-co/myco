import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectArtifactCandidates } from '@myco/artifacts/candidates';
import { slugifyPath } from '@myco/artifacts/slugify';
import { VaultWriter } from '@myco/vault/writer';
import { VaultReader } from '@myco/vault/reader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

describe('Artifact capture integration', () => {
  let projectRoot: string;
  let vaultDir: string;
  let writer: VaultWriter;
  let reader: VaultReader;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-art-int-'));
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-int-'));
    writer = new VaultWriter(vaultDir);
    reader = new VaultReader(vaultDir);
    execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('full pipeline: events -> candidates -> slugify -> write -> read', () => {
    const specDir = path.join(projectRoot, 'docs', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specFile = path.join(specDir, 'auth-design.md');
    fs.writeFileSync(specFile, '# Auth Design\n\nRedesign the auth layer for JWT support.');

    const filePaths = new Set([specFile]);

    // Pre-filter
    const candidates = collectArtifactCandidates(
      filePaths,
      { artifact_extensions: ['.md'] },
      projectRoot,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe('docs/specs/auth-design.md');

    // Slugify
    const id = slugifyPath(candidates[0].path);
    expect(id).toBe('docs-specs-auth-design');

    // Write to vault
    const vaultPath = writer.writeArtifact({
      id,
      artifact_type: 'spec',
      source_path: candidates[0].path,
      title: 'Auth Design Specification',
      session: 'test-session',
      tags: ['auth', 'jwt'],
      content: candidates[0].content,
    });

    expect(vaultPath).toBe('artifacts/docs-specs-auth-design.md');

    // Read back and verify
    const note = reader.readNote(vaultPath);
    expect(note.frontmatter.type).toBe('artifact');
    expect((note.frontmatter as any).source_path).toBe('docs/specs/auth-design.md');
    expect((note.frontmatter as any).title).toBe('Auth Design Specification');
    expect((note.frontmatter as any).last_captured_by).toBe('session-test-session');
    expect(note.content).toContain('Auth Design');
    expect(note.content).toContain('JWT support');

    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/artifact');
    expect(tags).toContain('artifact/spec');
    expect(tags).toContain('auth');
    expect(tags).toContain('jwt');
  });

  it('update preserves created, replaces content', () => {
    const specFile = path.join(projectRoot, 'docs', 'plan.md');
    fs.mkdirSync(path.dirname(specFile), { recursive: true });

    // First capture
    fs.writeFileSync(specFile, '# Plan v1');
    writer.writeArtifact({
      id: 'docs-plan',
      artifact_type: 'plan',
      source_path: 'docs/plan.md',
      title: 'Plan v1',
      session: 's1',
      content: '# Plan v1',
    });

    const first = reader.readNote('artifacts/docs-plan.md');
    const originalCreated = (first.frontmatter as any).created;

    // Second capture
    fs.writeFileSync(specFile, '# Plan v2 — Revised');
    writer.writeArtifact({
      id: 'docs-plan',
      artifact_type: 'plan',
      source_path: 'docs/plan.md',
      title: 'Plan v2',
      session: 's2',
      content: '# Plan v2 — Revised',
    });

    const second = reader.readNote('artifacts/docs-plan.md');
    expect((second.frontmatter as any).created).toBe(originalCreated);
    expect((second.frontmatter as any).last_captured_by).toBe('session-s2');
    expect(second.content).toContain('Plan v2');
    expect(second.content).not.toContain('# Plan v1');
  });
});
