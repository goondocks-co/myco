import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LineageGraph } from '@myco/daemon/lineage';
import type { RegisteredSession } from '@myco/daemon/lifecycle';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('LineageGraph', () => {
  let vaultDir: string;

  beforeEach(() => { vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lin-')); });
  afterEach(() => { fs.rmSync(vaultDir, { recursive: true, force: true }); });

  it('adds a link and persists to lineage.json', () => {
    const graph = new LineageGraph(vaultDir);
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });

    expect(graph.getLinks()).toHaveLength(1);
    const raw = JSON.parse(fs.readFileSync(path.join(vaultDir, 'lineage.json'), 'utf-8'));
    expect(raw.links).toHaveLength(1);
  });

  it('detects plan reference signal', () => {
    const graph = new LineageGraph(vaultDir);
    graph.registerPlanForSession('s1', 'plan-abc');

    const detected = graph.detectLineage('s2', 'implement the plan from plan-abc');
    expect(detected).not.toBeNull();
    expect(detected!.parent).toBe('s1');
    expect(detected!.signal).toBe('plan_reference');
  });

  it('rehydrates from disk', () => {
    const g1 = new LineageGraph(vaultDir);
    g1.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });

    const g2 = new LineageGraph(vaultDir);
    expect(g2.getLinks()).toHaveLength(1);
  });

  it('returns children and parent', () => {
    const graph = new LineageGraph(vaultDir);
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });
    graph.addLink({ parent: 's1', child: 's3', signal: 'clear', confidence: 'medium' });

    expect(graph.getChildren('s1')).toEqual(['s2', 's3']);
    expect(graph.getParent('s2')).toBe('s1');
  });

  it('does not duplicate links', () => {
    const graph = new LineageGraph(vaultDir);
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });
    expect(graph.getLinks()).toHaveLength(1);
  });

  describe('heuristic detection', () => {
    it('tier 1: links session that ended within 5 seconds', () => {
      const graph = new LineageGraph(vaultDir);
      const now = new Date();
      const justEnded = new Date(now.getTime() - 2000);

      const link = graph.detectHeuristicParent('new-session', {
        started_at: now.toISOString(),
        branch: 'main',
      }, [{ id: 'prev', ended: justEnded.toISOString(), branch: 'main' }], []);

      expect(link).not.toBeNull();
      expect(link!.signal).toBe('clear');
      expect(link!.confidence).toBe('high');
    });

    it('tier 1: does not link if gap exceeds 5 seconds', () => {
      const graph = new LineageGraph(vaultDir);
      const now = new Date();
      const endedLongAgo = new Date(now.getTime() - 10000);

      const link = graph.detectHeuristicParent('new', {
        started_at: now.toISOString(),
        branch: 'main',
      }, [{ id: 'old', ended: endedLongAgo.toISOString() }], []);

      expect(link).toBeNull();
    });

    it('tier 2: links to active session when no just-ended match', () => {
      const graph = new LineageGraph(vaultDir);
      const now = new Date();

      const link = graph.detectHeuristicParent('new', {
        started_at: now.toISOString(),
        branch: 'main',
      }, [], [{ id: 'active-session', started_at: '2026-03-14T09:00:00Z', branch: 'main' }]);

      expect(link).not.toBeNull();
      expect(link!.signal).toBe('clear_active');
    });

    it('tier 3: links to recent session on same branch within 24h', () => {
      const graph = new LineageGraph(vaultDir);
      const now = new Date();
      const sixHoursAgo = new Date(now.getTime() - 6 * 3600000);

      const link = graph.detectHeuristicParent('new', {
        started_at: now.toISOString(),
        branch: 'feat/auth',
      }, [{ id: 'prev', ended: sixHoursAgo.toISOString(), branch: 'feat/auth' }], []);

      expect(link).not.toBeNull();
      expect(link!.signal).toBe('inferred');
      expect(link!.confidence).toBe('medium');
    });

    it('tier 3: does not link if branches differ', () => {
      const graph = new LineageGraph(vaultDir);
      const now = new Date();
      const sixHoursAgo = new Date(now.getTime() - 6 * 3600000);

      const link = graph.detectHeuristicParent('new', {
        started_at: now.toISOString(),
        branch: 'feat/auth',
      }, [{ id: 'prev', ended: sixHoursAgo.toISOString(), branch: 'main' }], []);

      expect(link).toBeNull();
    });

    it('falls back to plan-reference detection', () => {
      const graph = new LineageGraph(vaultDir);
      graph.registerPlanForSession('planning', 'plan-xyz');

      const link = graph.detectHeuristicParent('impl', {
        started_at: new Date().toISOString(),
      }, [], [], 'implement plan-xyz now');

      expect(link).not.toBeNull();
      expect(link!.signal).toBe('plan_reference');
    });
  });
});
