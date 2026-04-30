import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

  it('registers the consolidated 7-tool core surface', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    expect(tools).toContain('myco_search');
    expect(tools).toContain('myco_cortex');
    expect(tools).toContain('myco_plans');
    expect(tools).toContain('myco_sessions');
    expect(tools).toContain('myco_skills');
    expect(tools).toContain('myco_spores');
    expect(tools).toContain('myco_agent');
    expect(tools).toHaveLength(7);
  });

  it('no longer registers the retired MCP surfaces', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    // These were retired in the 2026-04-22 MCP surface cleanup.
    for (const retired of [
      'myco_team',
      'myco_graph',
      'myco_skill_candidates',
      'myco_recall',
      'myco_remember',
      'myco_save_plan',
      'myco_supersede',
      'myco_consolidate',
      'myco_context',
      'myco_runs',
      'canopy_map',
      'myco_evaluations',
      'myco_write_intents',
      'myco_phase_audit',
      'myco_resume_run',
      'myco_digest_revisions',
    ]) {
      expect(tools).not.toContain(retired);
    }
  });

  it('does not leak collective tools into the core registration', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    expect(tools).not.toContain('collective_search');
    expect(tools).not.toContain('collective_projects');
    expect(tools).not.toContain('collective_project');
    expect(tools).not.toContain('collective_settings');
  });

  it('exports server name and version', () => {
    const server = createMycoServer(tmpDir, client);
    expect(server.name).toBe('myco');
  });
});
