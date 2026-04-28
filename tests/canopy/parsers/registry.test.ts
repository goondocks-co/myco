import { describe, it, expect } from 'bun:test';
import { parserFor } from '@myco/canopy/parsers/registry';
import { typescriptParser } from '@myco/canopy/parsers/typescript';
import { pythonParser } from '@myco/canopy/parsers/python';
import { markdownParser } from '@myco/canopy/parsers/markdown';
import { yamlJsonParser } from '@myco/canopy/parsers/yaml-json';
import { sqlParser } from '@myco/canopy/parsers/sql';
import { fallbackParser } from '@myco/canopy/parsers/fallback';

describe('parserFor', () => {
  it('routes TypeScript / JavaScript variants to the typescript parser', () => {
    for (const p of ['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.mjs', 'f.cjs', 'g.mts', 'h.cts']) {
      expect(parserFor(p)).toBe(typescriptParser);
    }
  });

  it('routes .py to the python parser', () => {
    expect(parserFor('foo/bar.py')).toBe(pythonParser);
  });

  it('routes markdown variants to the markdown parser', () => {
    expect(parserFor('README.md')).toBe(markdownParser);
    expect(parserFor('docs/x.markdown')).toBe(markdownParser);
  });

  it('routes yaml/yml/json to the yaml-json parser', () => {
    for (const p of ['a.yaml', 'b.yml', 'c.json']) {
      expect(parserFor(p)).toBe(yamlJsonParser);
    }
  });

  it('routes .sql to the sql parser', () => {
    expect(parserFor('migrations/v1.sql')).toBe(sqlParser);
  });

  it('falls back for unknown extensions and extensionless files', () => {
    expect(parserFor('Makefile')).toBe(fallbackParser);
    expect(parserFor('foo.unknown')).toBe(fallbackParser);
    expect(parserFor('binary.bin')).toBe(fallbackParser);
  });

  it('matches case-insensitively', () => {
    expect(parserFor('Foo.TS')).toBe(typescriptParser);
    expect(parserFor('NOTES.MD')).toBe(markdownParser);
  });
});
