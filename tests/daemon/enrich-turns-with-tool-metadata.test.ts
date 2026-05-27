import { describe, it, expect } from 'bun:test';
import { enrichTurnsWithToolMetadata } from '@myco/daemon/stop-processing.js';
import type { TranscriptTurn } from '@myco/symbionts/adapter.js';

function turn(prompt: string, timestamp: string, overrides: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return { prompt, toolCount: 0, timestamp, ...overrides };
}

function evt(toolName: string | undefined, timestamp: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool_use',
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    timestamp,
    ...extras,
  };
}

describe('enrichTurnsWithToolMetadata', () => {
  it('overwrites breakdown + files when buffer events are named', () => {
    const turns = [turn('q', '2026-05-23T20:20:00Z', {
      toolBreakdown: { stale: 99 },
      files: ['stale.ts'],
      toolCount: 2,
    })];
    const events = [
      evt('Read', '2026-05-23T20:20:05Z', { tool_input: { file_path: '/a/b.ts' } }),
      evt('Edit', '2026-05-23T20:20:06Z', { tool_input: { path: '/a/c.ts' } }),
    ];
    enrichTurnsWithToolMetadata(turns, events);
    expect(turns[0]!.toolBreakdown).toEqual({ Read: 1, Edit: 1 });
    expect(turns[0]!.files).toEqual(['/a/b.ts', '/a/c.ts']);
  });

  it("preserves parser breakdown when ALL buffer tool_use events have empty tool_name (Antigravity case)", () => {
    const parserBreakdown = { call_mcp_tool: 2, view_file: 3 };
    const parserFiles = ['/repo/a.ts', '/repo/b.ts'];
    const turns = [turn('hello', '2026-05-23T20:20:00Z', {
      toolCount: 5,
      toolBreakdown: parserBreakdown,
      files: parserFiles,
    })];
    const events = [
      evt('', '2026-05-23T20:20:05Z'), // empty tool_name
      evt('', '2026-05-23T20:20:06Z'),
      evt(undefined, '2026-05-23T20:20:07Z'), // missing field entirely
    ];
    enrichTurnsWithToolMetadata(turns, events);
    // Parser data untouched — no clobbering with {'': N}
    expect(turns[0]!.toolBreakdown).toEqual(parserBreakdown);
    expect(turns[0]!.files).toEqual(parserFiles);
  });

  it("ignores 'unknown' tool_name buffer events (legacy fallback marker)", () => {
    const turns = [turn('q', '2026-05-23T20:20:00Z', { toolBreakdown: { Read: 1 } })];
    enrichTurnsWithToolMetadata(turns, [evt('unknown', '2026-05-23T20:20:05Z')]);
    expect(turns[0]!.toolBreakdown).toEqual({ Read: 1 });
  });

  it('drops empty-named events from a mixed batch but counts the named ones', () => {
    const turns = [turn('q', '2026-05-23T20:20:00Z')];
    const events = [
      evt('', '2026-05-23T20:20:05Z'),
      evt('Bash', '2026-05-23T20:20:06Z', { tool_input: { file_path: '/x.sh' } }),
      evt('', '2026-05-23T20:20:07Z'),
      evt('Bash', '2026-05-23T20:20:08Z'),
    ];
    enrichTurnsWithToolMetadata(turns, events);
    expect(turns[0]!.toolBreakdown).toEqual({ Bash: 2 });
    expect(turns[0]!.files).toEqual(['/x.sh']);
  });

  it("honors the legacy 'tool' alias on buffer events", () => {
    const turns = [turn('q', '2026-05-23T20:20:00Z')];
    const events = [
      { type: 'tool_use', tool: 'LegacyName', timestamp: '2026-05-23T20:20:05Z' },
      { type: 'tool_use', tool: '', timestamp: '2026-05-23T20:20:06Z' }, // empty legacy alias dropped too
    ];
    enrichTurnsWithToolMetadata(turns, events);
    expect(turns[0]!.toolBreakdown).toEqual({ LegacyName: 1 });
  });
});
