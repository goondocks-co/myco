import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LineageGraph } from '@myco/daemon/lineage';
import { VaultWriter } from '@myco/vault/writer';
import { VaultReader } from '@myco/vault/reader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Lineage integration', () => {
  let vaultDir: string;
  let graph: LineageGraph;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lineage-int-'));
    graph = new LineageGraph(vaultDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('full flow: heuristic detection → session write with parent', () => {
    const now = new Date();
    const justEnded = new Date(now.getTime() - 1000);

    const recentSessions = [
      { id: 'parent-session', ended: justEnded.toISOString(), branch: 'main' },
    ];

    const link = graph.detectHeuristicParent('child-session', {
      started_at: now.toISOString(),
      branch: 'main',
    }, recentSessions, []);

    expect(link).not.toBeNull();
    expect(link!.parent).toBe('parent-session');

    const writer = new VaultWriter(vaultDir);
    writer.writeSession({
      id: 'child-session',
      started: now.toISOString(),
      parent: `[[session-${link!.parent}]]`,
      parent_reason: link!.signal,
      summary: '# Test\n\nTest session.',
    });

    const reader = new VaultReader(vaultDir);
    const note = reader.readNote(`sessions/${now.toISOString().slice(0, 10)}/session-child-session.md`);
    expect((note.frontmatter as any).parent).toBe('[[session-parent-session]]');
    expect((note.frontmatter as any).parent_reason).toBe('clear');

    const reloaded = new LineageGraph(vaultDir);
    expect(reloaded.getParent('child-session')).toBe('parent-session');
    expect(reloaded.getChildren('parent-session')).toContain('child-session');
  });

  it('plan-reference detection via detectHeuristicParent', () => {
    graph.registerPlanForSession('planning-session', 'plan-auth-redesign');

    const link = graph.detectHeuristicParent('impl-session', {
      started_at: new Date().toISOString(),
    }, [], [], 'Implementing the auth redesign from plan-auth-redesign');

    expect(link).not.toBeNull();
    expect(link!.signal).toBe('plan_reference');
    expect(link!.parent).toBe('planning-session');
  });

  it('no parent when gap exceeds threshold and no branch match', () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 48 * 3600000); // 48 hours

    const link = graph.detectHeuristicParent('new', {
      started_at: now.toISOString(),
      branch: 'feat/new',
    }, [{ id: 'old', ended: longAgo.toISOString(), branch: 'main' }], []);

    expect(link).toBeNull();
  });
});
