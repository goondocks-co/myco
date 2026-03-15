import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LineageGraph } from '@myco/daemon/lineage';
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
    graph.addLink({ parent: 's1', child: 's3', signal: 'branch_continuity', confidence: 'medium' });

    expect(graph.getChildren('s1')).toEqual(['s2', 's3']);
    expect(graph.getParent('s2')).toBe('s1');
  });

  it('does not duplicate links', () => {
    const graph = new LineageGraph(vaultDir);
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });
    graph.addLink({ parent: 's1', child: 's2', signal: 'plan_reference', confidence: 'high' });
    expect(graph.getLinks()).toHaveLength(1);
  });
});
