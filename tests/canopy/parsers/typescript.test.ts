import { describe, it, expect } from 'bun:test';
import { typescriptParser } from '@myco/canopy/parsers/typescript';

function input(content: string, path = 'src/sample.ts') {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('typescriptParser', () => {
  it('extracts named function/class/const exports', () => {
    const out = typescriptParser(input(`
      export function foo() {}
      export class Bar {}
      export const baz = 1, qux = 2;
    `));
    expect(out.language).toBe('typescript');
    expect(out.exports.sort()).toEqual(['Bar', 'baz', 'foo', 'qux']);
  });

  it('extracts type-only and interface exports', () => {
    const out = typescriptParser(input(`
      export interface Foo {}
      export type Bar = number;
      export enum Color { Red }
    `));
    expect(out.exports.sort()).toEqual(['Bar', 'Color', 'Foo']);
  });

  it('extracts re-exports and named export lists', () => {
    const out = typescriptParser(input(`
      export { a, b } from './neighbor';
      export * from './deep';
    `));
    expect(out.exports).toContain('a');
    expect(out.exports).toContain('b');
    expect(out.exports.some((e) => e.startsWith('* from '))).toBe(true);
  });

  it('records default exports with the "default" sentinel', () => {
    const out = typescriptParser(input(`
      const x = 1;
      export default x;
    `));
    expect(out.exports).toContain('default');
  });

  it('extracts import module specifiers', () => {
    const out = typescriptParser(input(`
      import foo from 'foo';
      import { bar } from './bar.js';
      import * as ns from "node:path";
    `));
    expect(out.imports.sort()).toEqual(['./bar.js', 'foo', 'node:path']);
  });

  it('extracts a leading JSDoc as topComment, stripped of markers', () => {
    const out = typescriptParser(input(`/**
 * Top-level documentation.
 * Continued on a second line.
 */
export const x = 1;
`));
    expect(out.topComment).toContain('Top-level documentation');
    expect(out.topComment).not.toContain('*');
    expect(out.topComment).not.toContain('/');
  });

  it('extracts a leading // banner comment as topComment', () => {
    const out = typescriptParser(input(`// Banner line one\n// Banner line two\nexport const y = 2;\n`));
    expect(out.topComment).toBe('Banner line one Banner line two');
  });

  it('returns a graceful result on syntactically malformed input', () => {
    const out = typescriptParser(input('export const = ;\nfunction foo( {\n'));
    expect(out.language).toBe('typescript');
    expect(Array.isArray(out.exports)).toBe(true);
    expect(Array.isArray(out.imports)).toBe(true);
  });

  it('handles destructured exports', () => {
    const out = typescriptParser(input(`export const { a, b } = obj;`));
    expect(out.exports.sort()).toEqual(['a', 'b']);
  });

  it('parses TSX without choking on JSX', () => {
    const out = typescriptParser(
      input(`import { x } from './x';\nexport const C = () => <div>{x}</div>;\n`, 'a.tsx'),
    );
    expect(out.exports).toContain('C');
    expect(out.imports).toContain('./x');
  });
});
