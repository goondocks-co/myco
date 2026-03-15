import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMycoServer } from '@myco/mcp/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MCP Server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates server with all 8 tools registered', () => {
    const server = createMycoServer({ vaultDir: tmpDir });
    const tools = server.getRegisteredTools();
    expect(tools).toContain('myco_search');
    expect(tools).toContain('myco_recall');
    expect(tools).toContain('myco_remember');
    expect(tools).toContain('myco_plans');
    expect(tools).toContain('myco_sessions');
    expect(tools).toContain('myco_team');
    expect(tools).toContain('myco_graph');
    expect(tools).toContain('myco_orphans');
    expect(tools).toHaveLength(8);
  });

  it('exports server name and version', () => {
    const server = createMycoServer({ vaultDir: tmpDir });
    expect(server.name).toBe('myco');
  });
});
