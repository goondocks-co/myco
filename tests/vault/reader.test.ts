import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultReader } from '@myco/vault/reader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeNote(dir: string, relPath: string, frontmatter: Record<string, unknown>, body: string) {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  fs.writeFileSync(fullPath, `---\n${fm}\n---\n\n${body}`);
}

describe('VaultReader', () => {
  let vaultDir: string;
  let reader: VaultReader;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vault-'));
    reader = new VaultReader(vaultDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('reads a session note', () => {
    writeNote(vaultDir, 'sessions/2026-03-12/session-abc.md', {
      type: 'session', id: 'abc', agent: 'claude-code', user: 'chris',
      started: '2026-03-12T09:00:00Z', tags: [],
    }, '# Test Session\n\nSome content.');

    const note = reader.readNote('sessions/2026-03-12/session-abc.md');
    expect(note.frontmatter.type).toBe('session');
    expect(note.content).toContain('Test Session');
  });

  it('lists notes by type', () => {
    writeNote(vaultDir, 'sessions/2026-03-12/session-a.md', {
      type: 'session', id: 'a', agent: 'claude-code', user: 'chris', started: '2026-03-12T09:00:00Z',
    }, '');
    writeNote(vaultDir, 'sessions/2026-03-12/session-b.md', {
      type: 'session', id: 'b', agent: 'claude-code', user: 'chris', started: '2026-03-12T10:00:00Z',
    }, '');
    writeNote(vaultDir, 'plans/my-plan.md', {
      type: 'plan', id: 'my-plan', status: 'active', created: '2026-03-12T00:00:00Z',
    }, '');

    const sessions = reader.listNotes('sessions');
    expect(sessions).toHaveLength(2);

    const plans = reader.listNotes('plans');
    expect(plans).toHaveLength(1);
  });

  it('returns empty array for missing directory', () => {
    const notes = reader.listNotes('nonexistent');
    expect(notes).toEqual([]);
  });

  it('skips non-markdown files', () => {
    fs.mkdirSync(path.join(vaultDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'sessions', 'notes.txt'), 'not markdown');
    const notes = reader.listNotes('sessions');
    expect(notes).toEqual([]);
  });

  it('readAllNotes reads entire vault', () => {
    writeNote(vaultDir, 'sessions/2026-03-12/s.md', {
      type: 'session', id: 's', agent: 'claude-code', user: 'chris', started: '2026-03-12T09:00:00Z',
    }, '');
    writeNote(vaultDir, 'memories/m.md', {
      type: 'memory', id: 'm', observation_type: 'gotcha', created: '2026-03-12T10:00:00Z',
    }, '');

    const all = reader.readAllNotes();
    expect(all).toHaveLength(2);
  });
});
