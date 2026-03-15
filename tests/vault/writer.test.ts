import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultWriter } from '@myco/vault/writer';
import { VaultReader } from '@myco/vault/reader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('VaultWriter', () => {
  let vaultDir: string;
  let writer: VaultWriter;
  let reader: VaultReader;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-'));
    writer = new VaultWriter(vaultDir);
    reader = new VaultReader(vaultDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('writes a session note', () => {
    const notePath = writer.writeSession({
      id: 'abc123',
      agent: 'claude-code',
      user: 'chris',
      started: '2026-03-12T09:00:00Z',
      tags: ['auth'],
      summary: '# Auth Session\n\nDid auth things.',
    });

    expect(notePath).toContain('sessions/2026-03-12/session-abc123.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('session');
    expect(note.content).toContain('Auth Session');
  });

  it('writes a plan note', () => {
    const notePath = writer.writePlan({
      id: 'auth-redesign',
      author: 'chris',
      tags: ['auth', 'security'],
      content: '# Auth Redesign\n\nRedesign auth.',
    });

    expect(notePath).toBe('plans/auth-redesign.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('plan');
  });

  it('writes a memory note', () => {
    const notePath = writer.writeMemory({
      id: 'gotcha-cors',
      observation_type: 'gotcha',
      session: '[[session-abc123]]',
      tags: ['cors'],
      content: '# CORS Gotcha\n\nProxy strips headers.',
    });

    expect(notePath).toBe('memories/gotcha-cors.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('memory');
    expect((note.frontmatter as any).observation_type).toBe('gotcha');
  });

  it('writes an artifact reference with copy', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proj-'));
    const specDir = path.join(projectRoot, 'docs', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'design.md'), '# Design Spec\n\nThe spec content.');

    const notePath = writer.writeArtifactRef({
      id: 'spec-design',
      source: 'docs/specs/design.md',
      artifact_type: 'spec',
      detected_via: 'file-watch',
      session: '[[session-abc123]]',
      tags: ['design'],
      copySource: true,
      projectRoot,
    });

    expect(notePath).toBe('artifacts/spec-design.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('artifact-ref');
    expect((note.frontmatter as any).source).toBe('docs/specs/design.md');
    expect(note.content).toContain('Design Spec');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes a team member note', () => {
    const notePath = writer.writeTeamMember({
      user: 'chris',
      role: 'lead',
    });

    expect(notePath).toBe('team/chris.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('team-member');
  });

  it('creates vault directories on first write', () => {
    const freshDir = path.join(vaultDir, 'fresh-vault');
    const freshWriter = new VaultWriter(freshDir);
    freshWriter.writePlan({ id: 'test', content: '# Test' });
    expect(fs.existsSync(path.join(freshDir, 'plans', 'test.md'))).toBe(true);
  });
});
