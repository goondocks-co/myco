import { describe, it, expect } from 'bun:test';
import {
  AntigravityJsonlParser,
  cleanAntigravityUserPrompt,
  extractAntigravityFilePath,
} from '@myco/symbionts/parsers/antigravity-jsonl.js';

/** Build a JSONL string from an array of step objects. */
function toJsonl(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function userInput(stepIndex: number, prompt: string, ts = '2026-05-23T20:20:53Z'): Record<string, unknown> {
  return {
    step_index: stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: ts,
    content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nLocal time noise\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel toggle noise\n</USER_SETTINGS_CHANGE>`,
  };
}

function plannerWithTool(stepIndex: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-05-23T20:20:54Z',
    tool_calls: [{ name, args }],
  };
}

function plannerWithReply(stepIndex: number, content: string): Record<string, unknown> {
  return {
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-05-23T20:20:55Z',
    content,
  };
}

function toolResult(stepIndex: number, type: string, content: string): Record<string, unknown> {
  return {
    step_index: stepIndex,
    source: 'MODEL',
    type,
    status: 'DONE',
    created_at: '2026-05-23T20:20:55Z',
    content,
  };
}

describe('AntigravityJsonlParser', () => {
  const parser = new AntigravityJsonlParser();

  it('parses a single-turn session with a user prompt, two tool calls, and a final reply', () => {
    const content = toJsonl([
      userInput(0, 'hello'),
      plannerWithTool(3, 'call_mcp_tool', { Arguments: { op: 'list' }, ServerName: 'myco', ToolName: 'myco_plans' }),
      toolResult(4, 'MCP_TOOL', 'plan list output'),
      plannerWithTool(7, 'run_command', { CommandLine: 'git status', Cwd: '/Users/chris/repos/myco' }),
      toolResult(8, 'RUN_COMMAND', 'On branch main'),
      plannerWithReply(10, 'Hello! Here is the status.'),
    ]);

    const turns = parser.parseTurns(content);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.prompt).toBe('hello');
    expect(turn.toolCount).toBe(2);
    expect(turn.toolBreakdown).toEqual({ call_mcp_tool: 1, run_command: 1 });
    expect(turn.aiResponse).toBe('Hello! Here is the status.');
    expect(turn.timestamp).toBe('2026-05-23T20:20:53Z');
    // run_command's CommandLine is not a path → no file. The MCP call isn't path-bearing.
    expect(turn.files).toBeUndefined();
  });

  it('splits multiple USER_INPUT rows into separate turns and isolates per-turn tool counts', () => {
    const content = toJsonl([
      userInput(0, 'first ask'),
      plannerWithTool(1, 'view_file', { AbsolutePath: '/repo/a.ts' }),
      plannerWithReply(2, 'done'),
      userInput(3, 'second ask'),
      plannerWithTool(4, 'view_file', { AbsolutePath: '/repo/b.ts' }),
      plannerWithTool(5, 'list_dir', { DirectoryPath: '/repo/sub' }),
      plannerWithReply(6, 'done2'),
    ]);

    const turns = parser.parseTurns(content);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toBe('first ask');
    expect(turns[0]!.toolCount).toBe(1);
    expect(turns[0]!.files).toEqual(['/repo/a.ts']);
    expect(turns[1]!.prompt).toBe('second ask');
    expect(turns[1]!.toolCount).toBe(2);
    expect(turns[1]!.files).toEqual(['/repo/b.ts', '/repo/sub']);
  });

  it('skips orphan planner rows before any USER_INPUT', () => {
    const content = toJsonl([
      plannerWithTool(0, 'view_file', { AbsolutePath: '/repo/early.ts' }),
      userInput(1, 'the real ask'),
      plannerWithReply(2, 'ok'),
    ]);

    const turns = parser.parseTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCount).toBe(0); // orphan planner ignored
  });

  it('tolerates malformed JSONL lines without throwing', () => {
    const good = JSON.stringify(userInput(0, 'hi'));
    const bad = '{not valid json';
    const turns = parser.parseTurns(`${bad}\n${good}\n`);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toBe('hi');
  });

  it('keeps only the last PLANNER_RESPONSE prose row (AGY narrates between tool calls; only the final reply matters)', () => {
    const content = toJsonl([
      userInput(0, 'multi-reply'),
      plannerWithReply(1, 'intermediate narration'),
      plannerWithReply(2, 'final reply'),
    ]);
    const turns = parser.parseTurns(content);
    expect(turns[0]!.aiResponse).toBe('final reply');
  });

  it('dedupes byte-identical USER_INPUT rows AGY re-emits at step 0 of each execution', () => {
    const content = toJsonl([
      userInput(0, 'one logical prompt'),
      plannerWithTool(3, 'view_file', { AbsolutePath: '/repo/a.ts' }),
      plannerWithReply(16, 'intermediate'),
      userInput(0, 'one logical prompt'), // restamped at execution 2 start
      plannerWithTool(3, 'view_file', { AbsolutePath: '/repo/b.ts' }),
      plannerWithReply(46, 'final reply'),
    ]);
    const turns = parser.parseTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toBe('one logical prompt');
    expect(turns[0]!.toolCount).toBe(2);
    expect(turns[0]!.aiResponse).toBe('final reply');
  });
});

describe('cleanAntigravityUserPrompt', () => {
  it('extracts the body of <USER_REQUEST> and strips metadata + settings envelopes', () => {
    const raw =
      '<USER_REQUEST>\nactual prompt\n</USER_REQUEST>\n' +
      '<ADDITIONAL_METADATA>\nLocal time …\n</ADDITIONAL_METADATA>\n' +
      '<USER_SETTINGS_CHANGE>\nmodel switch\n</USER_SETTINGS_CHANGE>';
    expect(cleanAntigravityUserPrompt(raw)).toBe('actual prompt');
  });

  it('falls back to whole-string metadata-strip when no <USER_REQUEST> envelope is present', () => {
    const raw = 'bare prompt\n<ADDITIONAL_METADATA>\ntimestamp\n</ADDITIONAL_METADATA>';
    expect(cleanAntigravityUserPrompt(raw)).toBe('bare prompt');
  });
});

describe('extractAntigravityFilePath', () => {
  it.each<[string, Record<string, unknown>, string | null]>([
    ['view_file', { AbsolutePath: '/a/b.ts' }, '/a/b.ts'],
    ['write_to_file', { TargetFile: '/a/c.ts', CodeContent: 'x' }, '/a/c.ts'],
    ['replace_file_content', { TargetFile: '/a/d.ts' }, '/a/d.ts'],
    ['list_dir', { DirectoryPath: '/a/sub' }, '/a/sub'],
    ['find_by_name', { SearchDirectory: '/a' }, '/a'],
    ['grep_search', { SearchPath: '/a/src' }, '/a/src'],
    ['run_command', { CommandLine: 'ls' }, null],
    ['call_mcp_tool', { ToolName: 'foo' }, null],
    ['view_file', {}, null],
    ['view_file', { AbsolutePath: 42 as unknown }, null],
  ])('maps %s args → %j', (name, args, expected) => {
    expect(extractAntigravityFilePath(name, args)).toBe(expected);
  });
});
