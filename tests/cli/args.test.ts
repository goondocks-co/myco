import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { parseStrictFlags } from '@myco/cli/args.js';

const USAGE = 'Usage: myco fake [options]\n';

function expectUsageExit(fn: () => void): { stderr: string; code: number | undefined } {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(fn).toThrow(/process\.exit\(2\)/);
    return {
      stderr: stderrSpy.mock.calls.flat().join(''),
      code: exitSpy.mock.calls[0]?.[0] as number | undefined,
    };
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('parseStrictFlags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses boolean, required-value, and optional-value flags', () => {
    const parsed = parseStrictFlags('myco fake', ['--force', '--name', 'alpha', '--project', '/tmp/x'], [
      { name: '--force' },
      { name: '--name', value: 'required' },
      { name: '--project', value: 'optional' },
    ], USAGE);

    expect(parsed.has('--force')).toBe(true);
    expect(parsed.value('--name')).toBe('alpha');
    expect(parsed.value('--project')).toBe('/tmp/x');
    expect(parsed.has('--absent')).toBe(false);
    expect(parsed.value('--absent')).toBeUndefined();
  });

  it('maps aliases to the canonical flag name', () => {
    const parsed = parseStrictFlags('myco fake', ['-h'], [
      { name: '--help', aliases: ['-h'] },
    ], USAGE);
    expect(parsed.has('--help')).toBe(true);
  });

  it('treats a bare optional-value flag as presence without a value', () => {
    const parsed = parseStrictFlags('myco fake', ['--project', '--force'], [
      { name: '--project', value: 'optional' },
      { name: '--force' },
    ], USAGE);
    expect(parsed.has('--project')).toBe(true);
    expect(parsed.value('--project')).toBeUndefined();
    expect(parsed.has('--force')).toBe(true);
  });

  it('rejects an unknown flag with exit code 2 and prints usage', () => {
    const { stderr } = expectUsageExit(() =>
      parseStrictFlags('myco fake', ['--frobnicate'], [{ name: '--force' }], USAGE),
    );
    expect(stderr).toContain("unknown flag '--frobnicate'");
    expect(stderr).toContain(USAGE);
  });

  it('rejects a required-value flag at end of args with exit code 2', () => {
    const { stderr } = expectUsageExit(() =>
      parseStrictFlags('myco fake', ['--name'], [{ name: '--name', value: 'required' }], USAGE),
    );
    expect(stderr).toContain('--name requires a value');
  });

  it('rejects a required-value flag followed by another flag with exit code 2', () => {
    const { stderr } = expectUsageExit(() =>
      parseStrictFlags('myco fake', ['--name', '--force'], [
        { name: '--name', value: 'required' },
        { name: '--force' },
      ], USAGE),
    );
    expect(stderr).toContain('--name requires a value');
  });

  it('rejects a stray positional argument with exit code 2', () => {
    const { stderr } = expectUsageExit(() =>
      parseStrictFlags('myco fake', ['oops'], [{ name: '--force' }], USAGE),
    );
    expect(stderr).toContain("unexpected argument 'oops'");
  });
});
