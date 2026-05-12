import { describe, it, expect } from 'bun:test';
import { resolveCanopyReadTool } from '@myco/symbionts/canopy-read-tools.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

const claudeManifest = {
  capabilities: {
    canopyReadTools: [
      { tool: 'Read', pathField: 'file_path', pathKind: 'file' },
    ],
  },
} as unknown as SymbiontManifest;

const codexManifest = {
  capabilities: {
    canopyReadTools: [
      {
        tool: 'Bash',
        pathField: 'command',
        extract: 'shell-arg',
        readCommands: ['cat', 'head', 'tail', 'less', 'bat', 'more', 'wc',
          'file', 'nl', 'sed', 'awk', 'grep', 'rg', 'perl'],
      },
    ],
  },
} as unknown as SymbiontManifest;

describe('resolveCanopyReadTool — basics', () => {
  it('returns null when manifest is undefined', () => {
    expect(resolveCanopyReadTool(undefined, 'Read', { file_path: '/x' })).toBeNull();
  });
  it('returns null when capabilities is missing', () => {
    expect(resolveCanopyReadTool({} as SymbiontManifest, 'Read', { file_path: '/x' })).toBeNull();
  });
  it('returns null when canopyReadTools is empty', () => {
    const m = { capabilities: { canopyReadTools: [] } } as unknown as SymbiontManifest;
    expect(resolveCanopyReadTool(m, 'Read', { file_path: '/x' })).toBeNull();
  });
  it('returns null when toolInput is not an object', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Read', null)).toBeNull();
    expect(resolveCanopyReadTool(claudeManifest, 'Read', 'foo')).toBeNull();
    expect(resolveCanopyReadTool(claudeManifest, 'Read', 42)).toBeNull();
  });
  it('returns null when tool name does not match any entry', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Write', { file_path: '/x' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Write', { command: 'cat x' })).toBeNull();
  });
});

describe('resolveCanopyReadTool — structured variant', () => {
  it('extracts the path from the declared field', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Read', { file_path: '/abs/foo.ts' }))
      .toEqual({ filePath: '/abs/foo.ts' });
  });
  it('returns null when the declared field is missing', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Read', {})).toBeNull();
  });
  it('returns null when the declared field is empty string', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Read', { file_path: '' })).toBeNull();
  });
  it('returns null when the declared field is not a string', () => {
    expect(resolveCanopyReadTool(claudeManifest, 'Read', { file_path: 123 })).toBeNull();
    expect(resolveCanopyReadTool(claudeManifest, 'Read', { file_path: null })).toBeNull();
  });
});

describe('resolveCanopyReadTool — shell-arg variant', () => {
  it('extracts the path from a simple cat command', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts an absolute path', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat /Users/me/foo.ts' }))
      .toEqual({ filePath: '/Users/me/foo.ts' });
  });
  it('handles head with a numeric short flag (-10)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'head -10 src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('handles short flags before the path (cat -n src/x.ts)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat -n src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('handles end-of-options marker (cat -- src/x.ts)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat -- src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('handles end-of-options after flags (cat -n -- src/x.ts)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat -n -- src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('handles quoted paths with spaces', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat "src/file with space.ts"' }))
      .toEqual({ filePath: 'src/file with space.ts' });
  });
  it('returns null when the command is not in readCommands', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'ls -la src/' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'find src/ -name "*.ts"' })).toBeNull();
  });

  it('extracts path as last positional for sed -n (script then path)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: "sed -n '1,220p' src/x.ts" }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts path as last positional for rg (pattern then path)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'rg pattern src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts path as last positional for perl -ne (script then path)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: "perl -ne 'print if /foo/' src/x.ts" }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts path as last positional for awk (script then path)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: "awk '/pat/' src/x.ts" }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts path as last positional for grep (pattern then path)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'grep PATTERN src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts path as last positional for nl (with flag)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'nl -ba src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('picks the LAST path for multi-path reads (wc a b)', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'wc a.txt b.txt' }))
      .toEqual({ filePath: 'b.txt' });
  });
  it('returns null on pipe / redirect / control operators', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat src/x.ts | grep foo' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat src/x.ts > out.txt' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat src/x.ts && echo done' })).toBeNull();
  });
  it('returns null on env-var / glob / subshell substitutions', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat $FILE' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat $(echo src/x.ts)' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat src/*.ts' })).toBeNull();
  });
  it('returns null when command has no positional argument', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat' })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'cat -n' })).toBeNull();
  });
  it('returns null when the field is missing or not a string', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', {})).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 42 })).toBeNull();
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: '' })).toBeNull();
  });
  it('returns null when the field is whitespace-only', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: '   ' })).toBeNull();
  });
  it('still works when multiple readCommands are allowed', () => {
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'head src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
    expect(resolveCanopyReadTool(codexManifest, 'Bash', { command: 'tail -n 5 src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
  });
});

describe('resolveCanopyReadTool — multiple entries', () => {
  const mixedManifest = {
    capabilities: {
      canopyReadTools: [
        { tool: 'Read', pathField: 'file_path', pathKind: 'file' },
        { tool: 'Bash', pathField: 'command', extract: 'shell-arg', readCommands: ['cat'] },
      ],
    },
  } as unknown as SymbiontManifest;

  it('matches structured first', () => {
    expect(resolveCanopyReadTool(mixedManifest, 'Read', { file_path: 'foo' }))
      .toEqual({ filePath: 'foo' });
  });
  it('matches shell second', () => {
    expect(resolveCanopyReadTool(mixedManifest, 'Bash', { command: 'cat foo' }))
      .toEqual({ filePath: 'foo' });
  });
});
