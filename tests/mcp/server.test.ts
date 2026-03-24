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

  it('creates server with all 10 tools registered', () => {
    const server = createMycoServer(tmpDir, client);
    const tools = server.getRegisteredTools();
    expect(tools).toContain('myco_search');
    expect(tools).toContain('myco_recall');
    expect(tools).toContain('myco_remember');
    expect(tools).toContain('myco_plans');
    expect(tools).toContain('myco_sessions');
    expect(tools).toContain('myco_team');
    expect(tools).toContain('myco_graph');
    expect(tools).toContain('myco_supersede');
    expect(tools).toContain('myco_consolidate');
    expect(tools).toContain('myco_context');
    expect(tools).toHaveLength(10);
  });

  it('exports server name and version', () => {
    const server = createMycoServer(tmpDir, client);
    expect(server.name).toBe('myco');
  });
});
