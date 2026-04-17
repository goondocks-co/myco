import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, enumerateCells, formatTable, parsePhaseArg, formatPhaseOverrides } from '@myco/cli/agent-eval';
import { enumerateMatrixCells } from '@myco/daemon/api/agent-evaluations';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  // Capture and suppress process.exit + stdout during help tests
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('parses required --task flag', () => {
    const result = parseArgs(['--task', 'full-intelligence']);
    expect(result.taskId).toBe('full-intelligence');
  });

  it('parses --runtimes comma-separated', () => {
    const result = parseArgs(['--task', 't', '--runtimes', 'claude-sdk,openai-agents']);
    expect(result.matrix.runtimes).toEqual(['claude-sdk', 'openai-agents']);
  });

  it('parses --reasoning comma-separated', () => {
    const result = parseArgs(['--task', 't', '--reasoning', 'low,default,high']);
    expect(result.matrix.reasoningLevels).toEqual(['low', 'default', 'high']);
  });

  it('parses --models comma-separated', () => {
    const result = parseArgs(['--task', 't', '--models', 'claude-opus-4-5,claude-sonnet-4-5']);
    expect(result.matrix.models).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
  });

  it('parses --dry-run flag', () => {
    const result = parseArgs(['--task', 't', '--dry-run']);
    expect(result.matrix.dryRun).toBe(true);
  });

  it('dry-run is absent when not provided', () => {
    const result = parseArgs(['--task', 't']);
    expect(result.matrix.dryRun).toBeUndefined();
  });

  it('parses --no-wait flag', () => {
    const result = parseArgs(['--task', 't', '--no-wait']);
    expect(result.noWait).toBe(true);
  });

  it('parses --poll-interval', () => {
    const result = parseArgs(['--task', 't', '--poll-interval', '5']);
    expect(result.pollInterval).toBe(5);
  });

  it('parses --timeout', () => {
    const result = parseArgs(['--task', 't', '--timeout', '120']);
    expect(result.timeout).toBe(120);
  });

  it('defaults pollInterval to 10 and timeout to 3600', () => {
    const result = parseArgs(['--task', 't']);
    expect(result.pollInterval).toBe(10);
    expect(result.timeout).toBe(3600);
  });

  it('parses combined flags correctly', () => {
    const result = parseArgs([
      '--task', 't',
      '--runtimes', 'a,b',
      '--dry-run',
    ]);
    expect(result.taskId).toBe('t');
    expect(result.matrix.runtimes).toEqual(['a', 'b']);
    expect(result.matrix.dryRun).toBe(true);
    expect(result.noWait).toBe(false);
  });

  it('throws if --task is missing', () => {
    expect(() => parseArgs(['--runtimes', 'claude-sdk'])).toThrow('--task');
  });

  it('throws if --runtimes is empty after split', () => {
    expect(() => parseArgs(['--task', 't', '--runtimes', ',,,'])).toThrow('zero values');
  });

  it('throws if --reasoning is empty after split', () => {
    expect(() => parseArgs(['--task', 't', '--reasoning', ',,,'])).toThrow('zero values');
  });

  it('throws if --models is empty after split', () => {
    expect(() => parseArgs(['--task', 't', '--models', ',,,'])).toThrow('zero values');
  });

  it('prints help and exits on --help', () => {
    expect(() => parseArgs(['--help'])).toThrow('process.exit(0)');
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('prints help and exits on -h', () => {
    expect(() => parseArgs(['-h'])).toThrow('process.exit(0)');
    expect(stdoutSpy).toHaveBeenCalled();
  });

  // --- --phase-reasoning / --phase-model ---

  it('parses --phase-reasoning into matrix.phases', () => {
    const result = parseArgs([
      '--task', 't', '--phase-reasoning', 'extract:low,digest:high',
    ]);
    expect(result.matrix.phases).toEqual({
      extract: { reasoningLevel: 'low' },
      digest: { reasoningLevel: 'high' },
    });
  });

  it('parses --phase-model into matrix.phases', () => {
    const result = parseArgs([
      '--task', 't', '--phase-model', 'extract:claude-haiku-4-5,digest:claude-opus-4-6',
    ]);
    expect(result.matrix.phases).toEqual({
      extract: { model: 'claude-haiku-4-5' },
      digest: { model: 'claude-opus-4-6' },
    });
  });

  it('merges --phase-reasoning and --phase-model on the same phase', () => {
    const result = parseArgs([
      '--task', 't',
      '--phase-reasoning', 'extract:low',
      '--phase-model', 'extract:claude-haiku-4-5',
    ]);
    expect(result.matrix.phases).toEqual({
      extract: { reasoningLevel: 'low', model: 'claude-haiku-4-5' },
    });
  });

  it('throws on invalid --phase-reasoning value', () => {
    expect(() =>
      parseArgs(['--task', 't', '--phase-reasoning', 'extract:medium']),
    ).toThrow(/Invalid reasoning level/);
  });

  it('throws on malformed --phase-reasoning pair (missing colon)', () => {
    expect(() =>
      parseArgs(['--task', 't', '--phase-reasoning', 'extract']),
    ).toThrow(/Malformed phase pair/);
  });

  it('throws on malformed --phase-model pair (missing value)', () => {
    expect(() =>
      parseArgs(['--task', 't', '--phase-model', 'extract:']),
    ).toThrow(/Malformed phase pair/);
  });

  it('does not set matrix.phases when no phase flags are provided', () => {
    const result = parseArgs(['--task', 't']);
    expect(result.matrix.phases).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parsePhaseArg (direct)
// ---------------------------------------------------------------------------

describe('parsePhaseArg', () => {
  it('parses reasoning pairs', () => {
    expect(parsePhaseArg('a:low,b:high', 'reasoningLevel')).toEqual({
      a: { reasoningLevel: 'low' },
      b: { reasoningLevel: 'high' },
    });
  });

  it('parses model pairs', () => {
    expect(parsePhaseArg('a:m1,b:m2', 'model')).toEqual({
      a: { model: 'm1' },
      b: { model: 'm2' },
    });
  });

  it('merges into an accumulator from a prior call', () => {
    const acc = parsePhaseArg('extract:low', 'reasoningLevel');
    const merged = parsePhaseArg('extract:m1', 'model', acc);
    expect(merged).toEqual({
      extract: { reasoningLevel: 'low', model: 'm1' },
    });
  });

  it('rejects invalid reasoning values', () => {
    expect(() => parsePhaseArg('a:medium', 'reasoningLevel')).toThrow(/Invalid reasoning level/);
  });

  it('rejects malformed pairs', () => {
    expect(() => parsePhaseArg('noColonHere', 'model')).toThrow(/Malformed phase pair/);
    expect(() => parsePhaseArg(':value', 'model')).toThrow(/Malformed phase pair/);
    expect(() => parsePhaseArg('phase:', 'model')).toThrow(/Malformed phase pair/);
  });

  it('throws when splitting produces zero pairs', () => {
    expect(() => parsePhaseArg(',,,', 'model')).toThrow(/zero pairs/);
  });

  it('allows values containing colons after the first (e.g. claude-opus-4-6)', () => {
    // The first colon is the separator; any subsequent text including
    // dashes and digits is preserved verbatim as the model value.
    expect(parsePhaseArg('extract:claude-opus-4-6', 'model')).toEqual({
      extract: { model: 'claude-opus-4-6' },
    });
  });
});

// ---------------------------------------------------------------------------
// formatPhaseOverrides
// ---------------------------------------------------------------------------

describe('formatPhaseOverrides', () => {
  it('returns empty string for undefined / empty input', () => {
    expect(formatPhaseOverrides(undefined)).toBe('');
    expect(formatPhaseOverrides({})).toBe('');
  });

  it('renders reasoning pins preferentially', () => {
    expect(formatPhaseOverrides({
      extract: { reasoningLevel: 'low' },
      digest: { reasoningLevel: 'high' },
    })).toBe('extract=low, digest=high');
  });

  it('falls back to model when reasoning is absent', () => {
    expect(formatPhaseOverrides({
      extract: { model: 'claude-haiku-4-5' },
    })).toBe('extract=claude-haiku-4-5');
  });
});

// ---------------------------------------------------------------------------
// enumerateCells (client-side) vs enumerateMatrixCells (server-side)
// ---------------------------------------------------------------------------

describe('enumerateCells', () => {
  it('returns a single empty cell when no dimensions are set', () => {
    const cells = enumerateCells({});
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({});
  });

  it('returns one cell per runtime when only runtimes set', () => {
    const cells = enumerateCells({ runtimes: ['claude-sdk', 'openai-agents'] });
    expect(cells).toHaveLength(2);
    expect(cells[0].runtime).toBe('claude-sdk');
    expect(cells[1].runtime).toBe('openai-agents');
  });

  it('produces a full Cartesian product', () => {
    const cells = enumerateCells({
      runtimes: ['claude-sdk', 'openai-agents'],
      reasoningLevels: ['low', 'high'],
    });
    // 2 runtimes × 2 reasoning = 4 cells
    expect(cells).toHaveLength(4);
    expect(cells[0]).toEqual({ runtime: 'claude-sdk', reasoningLevel: 'low' });
    expect(cells[1]).toEqual({ runtime: 'claude-sdk', reasoningLevel: 'high' });
    expect(cells[2]).toEqual({ runtime: 'openai-agents', reasoningLevel: 'low' });
    expect(cells[3]).toEqual({ runtime: 'openai-agents', reasoningLevel: 'high' });
  });

  it('matches server-side enumerateMatrixCells cell count', () => {
    const matrix = {
      runtimes: ['claude-sdk', 'openai-agents'] as const,
      reasoningLevels: ['low', 'default', 'high'] as const,
      models: ['model-a', 'model-b'] as const,
    };
    const clientCells = enumerateCells(matrix);
    const serverCells = enumerateMatrixCells(matrix);
    expect(clientCells).toHaveLength(serverCells.length);
  });

  it('matches server-side cell order for multi-dimension matrix', () => {
    const matrix = {
      runtimes: ['claude-sdk', 'openai-agents'] as const,
      reasoningLevels: ['low', 'high'] as const,
    };
    const clientCells = enumerateCells(matrix);
    const serverCells = enumerateMatrixCells(matrix);

    for (let i = 0; i < clientCells.length; i++) {
      expect(clientCells[i].runtime).toBe(serverCells[i].runtime);
      expect(clientCells[i].reasoningLevel).toBe(serverCells[i].reasoningLevel);
    }
  });

  it('omits undefined fields from cell objects', () => {
    const cells = enumerateCells({ runtimes: ['claude-sdk'] });
    expect('reasoningLevel' in cells[0]).toBe(false);
    expect('model' in cells[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe('formatTable', () => {
  const sampleRows = [
    {
      runtime: 'claude-sdk',
      reasoning: 'low',
      model: 'claude-sonnet',
      dryRun: 'yes',
      status: 'completed',
      turns: '12',
      tokens: '3000',
      cost: '$0.0045',
      duration: '42.1s',
    },
    {
      runtime: 'openai-agents',
      reasoning: 'high',
      model: 'gpt-4o',
      dryRun: 'no',
      status: 'failed',
      turns: '5',
      tokens: '1200',
      cost: '$0.0012',
      duration: '18.3s',
    },
  ];

  it('includes all column headers', () => {
    const table = formatTable(sampleRows);
    expect(table).toContain('runtime');
    expect(table).toContain('reasoning');
    expect(table).toContain('model');
    expect(table).toContain('dry-run');
    expect(table).toContain('status');
    expect(table).toContain('turns');
    expect(table).toContain('tokens');
    expect(table).toContain('cost');
    expect(table).toContain('duration');
  });

  it('includes all data row values', () => {
    const table = formatTable(sampleRows);
    expect(table).toContain('claude-sdk');
    expect(table).toContain('openai-agents');
    expect(table).toContain('completed');
    expect(table).toContain('failed');
    expect(table).toContain('$0.0045');
  });

  it('has consistent column widths — each row has same number of separators', () => {
    const table = formatTable(sampleRows);
    const lines = table.split('\n').filter(Boolean);
    // All non-separator lines should have the same number of ' | ' separators
    const dataLines = lines.filter((l) => !l.match(/^[-+| ]+$/));
    const separatorCounts = dataLines.map((l) => (l.match(/ \| /g) ?? []).length);
    expect(new Set(separatorCounts).size).toBe(1);
  });

  it('returns empty-ish table (headers + sep only) for zero rows', () => {
    const table = formatTable([]);
    const lines = table.split('\n');
    expect(lines).toHaveLength(2); // header + separator
  });

  it('pads short values to column width', () => {
    const table = formatTable(sampleRows);
    const lines = table.split('\n');
    // All rows should have the same total length (consistent padding)
    const dataLines = lines.filter((l) => !l.match(/^[-+| ]+$/));
    const lengths = dataLines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it('omits phase overrides column when no row has a value', () => {
    const table = formatTable(sampleRows);
    expect(table).not.toContain('phase overrides');
  });

  it('includes phase overrides column when any row has a value', () => {
    const rowsWithPhases = sampleRows.map((r) => ({
      ...r,
      phaseOverrides: 'extract=low, digest=high',
    }));
    const table = formatTable(rowsWithPhases);
    expect(table).toContain('phase overrides');
    expect(table).toContain('extract=low, digest=high');
  });
});
