import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMycoTools } from '@myco/tools/index';
import { DaemonClient } from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tool-surface guards. After Phase 1 of the MCP transport standardization,
 * `mcp/server.ts` no longer owns a tool registry — `createMycoTools()` is the
 * single source of truth, consumed by both the in-daemon HTTP MCP handler
 * (`mcp/http.ts`) and (transitively, via the stdio bridge) every stdio agent.
 * These tests live here to keep guarding the surface those transports expose.
 */
describe('MCP tool surface (createMycoTools)', () => {
  let tmpDir: string;
  let client: DaemonClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-'));
    ensureProjectManifest(tmpDir, { projectName: 'mcp-server-test' });
    client = new DaemonClient(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the consolidated core tool surface (7 retrieval/entity tools + 1 operator tool)', () => {
    const tools = createMycoTools(tmpDir, client).getRegisteredTools();
    expect(tools).toContain('myco_search');
    expect(tools).toContain('myco_cortex');
    expect(tools).toContain('myco_plans');
    expect(tools).toContain('myco_sessions');
    expect(tools).toContain('myco_skills');
    expect(tools).toContain('myco_spores');
    expect(tools).toContain('myco_agent');
    // Stream J — agent-native parity (operator action tool).
    expect(tools).toContain('myco_maintenance');
    expect(tools).toHaveLength(8);
  });

  it('no longer registers the retired MCP surfaces', () => {
    const tools = createMycoTools(tmpDir, client).getRegisteredTools();
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
    const tools = createMycoTools(tmpDir, client).getRegisteredTools();
    expect(tools).not.toContain('collective_search');
    expect(tools).not.toContain('collective_projects');
    expect(tools).not.toContain('collective_project');
    expect(tools).not.toContain('collective_settings');
  });
});
