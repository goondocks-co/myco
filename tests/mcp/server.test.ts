import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMycoServer } from '@myco/mcp/server';
import { DaemonClient } from '@myco/hooks/client';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MCP Server', () => {
  let tmpDir: string;
  let client: DaemonClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-'));
    client = new DaemonClient(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers all 20 core tools', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    expect(tools).toContain('myco_search');
    expect(tools).toContain('myco_recall');
    expect(tools).toContain('myco_remember');
    expect(tools).toContain('myco_plans');
    expect(tools).toContain('myco_save_plan');
    expect(tools).toContain('myco_sessions');
    expect(tools).toContain('myco_team');
    expect(tools).toContain('myco_graph');
    expect(tools).toContain('myco_supersede');
    expect(tools).toContain('myco_consolidate');
    expect(tools).toContain('myco_context');
    expect(tools).toContain('myco_skills');
    expect(tools).toContain('myco_skill_candidates');
    // Bundle D additions (pre-0.21.0 agent-native MCP parity).
    expect(tools).toContain('myco_cortex');
    expect(tools).toContain('myco_runs');
    // Bundle G additions (post-0.21.0 follow-ups — #95..#99).
    expect(tools).toContain('myco_evaluations');
    expect(tools).toContain('myco_write_intents');
    expect(tools).toContain('myco_phase_audit');
    expect(tools).toContain('myco_resume_run');
    expect(tools).toContain('myco_digest_revisions');
    expect(tools).toHaveLength(20);
  });

  it('does not leak collective tools into the core registration', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    expect(tools).not.toContain('collective_search');
    expect(tools).not.toContain('collective_projects');
    expect(tools).not.toContain('collective_project');
  });

  it('exports server name and version', () => {
    const server = createMycoServer(tmpDir, client);
    expect(server.name).toBe('myco');
  });
});
