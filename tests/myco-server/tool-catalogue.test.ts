/**
 * Gate: every MCP tool the ledger keeps is named by the code that delivers it.
 *
 * `docs/architecture/myco-2.0.md` §7.3 assigns three of its rows to #919 (the
 * child holding their tables) while #921 delivers their MCP surface. The Owner
 * column names one child per row, so nothing in the ledger itself guarantees a
 * row's non-owning surface is delivered (#994). This gate reads §7.3 rather than
 * its own list — the same shape as the v7 schema gate over §7.6 — and holds
 * `SERVED_TOOLS` equal to it in both directions: a tool the ledger keeps that
 * the server does not name fails by name, and so does a tool the server names
 * that the ledger never disposed of.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVED_TOOLS, isServedTool } from '@myco-server-worker/core/tool-catalogue.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

interface ToolRow { tool: string; disposition: string; surfaces: string[] }

/** Every §7.3 row: first backticked token, disposition, and the surface cell split on commas. */
function ledgerMcpRows(): ToolRow[] {
  const doc = fs.readFileSync(LEDGER, 'utf8');
  const start = doc.indexOf('### 7.3');
  const end = doc.indexOf('### 7.4');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end).split('\n')
    .filter((l) => l.startsWith('| `'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map((cells) => ({
      tool: cells[0].match(/`([^`]+)`/)?.[1] ?? '',
      disposition: cells[1],
      surfaces: cells[2].split(',').map((s) => s.trim()),
    }));
}

describe('the tool catalogue', () => {
  it('parses a non-trivial §7.3 (guards against a silently empty parse)', () => {
    const rows = ledgerMcpRows();
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.every((r) => r.tool.startsWith('myco_'))).toBe(true);
  });

  it('names every MCP tool the ledger keeps, and none it does not', () => {
    const kept = ledgerMcpRows()
      .filter((r) => r.disposition !== 'DROP' && r.surfaces.includes('MCP'))
      .map((r) => r.tool);

    const unserved = kept.filter((t) => !isServedTool(t));
    expect(
      unserved,
      `§7.3 keeps these MCP tools but the server does not name them in SERVED_TOOLS — the delivering child must enumerate every row it delivers: ${unserved.join(', ')}`,
    ).toEqual([]);

    const undisposed = SERVED_TOOLS.filter((t) => !kept.includes(t));
    expect(
      undisposed,
      `SERVED_TOOLS names tools §7.3 never kept — a tool cannot be served that the ledger dropped or never disposed of: ${undisposed.join(', ')}`,
    ).toEqual([]);
  });

  it('serves no tool twice', () => {
    expect(new Set(SERVED_TOOLS).size).toBe(SERVED_TOOLS.length);
  });
});
