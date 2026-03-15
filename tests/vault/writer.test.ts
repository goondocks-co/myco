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

  it('writes a session note with hierarchical tags', () => {
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
    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/session');
    expect(tags).toContain('session/ended');
    expect(tags).toContain('user/chris');
    expect(tags).toContain('auth');
  });

  it('writes a plan note with inline fields and tags', () => {
    const notePath = writer.writePlan({
      id: 'auth-redesign',
      author: 'chris',
      tags: ['auth', 'security'],
      content: '# Auth Redesign\n\nRedesign auth.',
    });

    expect(notePath).toBe('plans/auth-redesign.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('plan');
    // Inline fields in body
    expect(note.content).toContain('Plan:: [[auth-redesign]]');
    expect(note.content).toContain('Status:: active');
    expect(note.content).toContain('Author:: chris');
    // Hierarchical tags
    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/plan');
    expect(tags).toContain('plan/active');
    expect(tags).toContain('auth');
    expect(tags).toContain('security');
  });

  it('writes a memory note with hierarchical tags', () => {
    const notePath = writer.writeMemory({
      id: 'gotcha-cors',
      observation_type: 'gotcha',
      session: 'session-abc123',
      tags: ['cors'],
      content: '# CORS Gotcha\n\nProxy strips headers.',
    });

    expect(notePath).toBe('memories/gotcha-cors.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('memory');
    expect((note.frontmatter as any).observation_type).toBe('gotcha');
    expect((note.frontmatter as any).session).toBe('session-abc123');
    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/memory');
    expect(tags).toContain('memory/gotcha');
    expect(tags).toContain('cors');
  });

  it('writes a new artifact with full content', () => {
    const notePath = writer.writeArtifact({
      id: 'docs-specs-auth-design',
      artifact_type: 'spec',
      source_path: 'docs/specs/auth-design.md',
      title: 'Auth Redesign Specification',
      session: 'abc123',
      tags: ['auth', 'api'],
      content: '# Auth Redesign\n\nRedesign the auth layer.',
    });

    expect(notePath).toBe('artifacts/docs-specs-auth-design.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('artifact');
    expect((note.frontmatter as any).id).toBe('docs-specs-auth-design');
    expect((note.frontmatter as any).artifact_type).toBe('spec');
    expect((note.frontmatter as any).source_path).toBe('docs/specs/auth-design.md');
    expect((note.frontmatter as any).title).toBe('Auth Redesign Specification');
    expect((note.frontmatter as any).last_captured_by).toBe('session-abc123');
    expect((note.frontmatter as any).created).toBeDefined();
    expect((note.frontmatter as any).updated).toBeDefined();
    expect(note.content).toContain('Auth Redesign');
    expect(note.content).toContain('Redesign the auth layer.');
    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/artifact');
    expect(tags).toContain('artifact/spec');
    expect(tags).toContain('auth');
    expect(tags).toContain('api');
  });

  it('preserves created date on artifact update', () => {
    writer.writeArtifact({
      id: 'docs-specs-auth-design',
      artifact_type: 'spec',
      source_path: 'docs/specs/auth-design.md',
      title: 'Auth Redesign v1',
      session: 's1',
      content: '# V1',
    });

    const firstNote = reader.readNote('artifacts/docs-specs-auth-design.md');
    const originalCreated = (firstNote.frontmatter as any).created;

    writer.writeArtifact({
      id: 'docs-specs-auth-design',
      artifact_type: 'spec',
      source_path: 'docs/specs/auth-design.md',
      title: 'Auth Redesign v2',
      session: 's2',
      content: '# V2 — Updated',
    });

    const updatedNote = reader.readNote('artifacts/docs-specs-auth-design.md');
    expect((updatedNote.frontmatter as any).created).toBe(originalCreated);
    expect((updatedNote.frontmatter as any).title).toBe('Auth Redesign v2');
    expect((updatedNote.frontmatter as any).last_captured_by).toBe('session-s2');
    expect(updatedNote.content).toContain('V2 — Updated');
    expect(updatedNote.content).not.toContain('# V1');
  });

  it('writes a team member note with callout and tags', () => {
    const notePath = writer.writeTeamMember({
      user: 'chris',
      role: 'lead',
    });

    expect(notePath).toBe('team/chris.md');
    const note = reader.readNote(notePath);
    expect(note.frontmatter.type).toBe('team-member');
    // Callout and inline fields in body
    expect(note.content).toContain('> [!info] Team Member');
    expect(note.content).toContain('User:: chris');
    expect(note.content).toContain('Role:: lead');
    // Hierarchical tags
    const tags = (note.frontmatter as any).tags as string[];
    expect(tags).toContain('type/team');
    expect(tags).toContain('user/chris');
  });

  it('creates vault directories on first write', () => {
    const freshDir = path.join(vaultDir, 'fresh-vault');
    const freshWriter = new VaultWriter(freshDir);
    freshWriter.writePlan({ id: 'test', content: '# Test' });
    expect(fs.existsSync(path.join(freshDir, 'plans', 'test.md'))).toBe(true);
  });

  it('writes plans array to session frontmatter', () => {
    const sessionPath = writer.writeSession({
      id: 's1', started: '2026-01-01', summary: 'Test', plans: ['plan-a', 'plan-b'],
    });
    const content = fs.readFileSync(path.join(vaultDir, sessionPath), 'utf-8');
    expect(content).toContain('plans:');
    expect(content).toContain('plan-a');
    expect(content).toContain('plan-b');
  });

  it('omits plans when array is empty', () => {
    const sessionPath = writer.writeSession({
      id: 's2', started: '2026-01-01', summary: 'Test', plans: [],
    });
    const content = fs.readFileSync(path.join(vaultDir, sessionPath), 'utf-8');
    expect(content).not.toContain('plans:');
  });
});
