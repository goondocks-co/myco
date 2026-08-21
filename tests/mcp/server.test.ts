import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMycoTools } from '@myco/tools/index';
import { DaemonClient } from '@myco/daemon/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

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
    client = new DaemonClient(tmpDir, {
      lockNamespace: testPerUserLockNamespace,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the trimmed core tool surface (7 read/editorial tools — no admin)', () => {
    // The MCP surface is for Symbionts to read project intelligence and make
    // constrained editorial edits. Administrative operations belong to the
    // CLI + UI, not MCP. See docs/architecture/actors-and-boundaries.md and
    // Bucket K (PR #308) for the removal of myco_maintenance, myco_update,
    // and myco_skill_candidates.
    const tools = createMycoTools(tmpDir, client).getRegisteredTools();
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
    const tools = createMycoTools(tmpDir, client).getRegisteredTools();
    // Three waves of retirement:
    //   - 2026-04-22 MCP surface cleanup (myco_team, myco_graph, …)
    //   - 2026-05-17 Bucket K boundary restoration (myco_maintenance,
    //     myco_update, myco_skill_candidates) — see actors-and-boundaries.md
    //   - 2026-07-10 OKF retirement (myco_okf) — the never-shipped wiki
    //     surface, replaced by the myco-okf skill
    for (const retired of [
      'myco_team',
      'myco_graph',
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
      'myco_maintenance',
      'myco_update',
      'myco_skill_candidates',
      'myco_okf',
    ]) {
      expect(tools).not.toContain(retired);
    }
  });
});
