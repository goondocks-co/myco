import { describe, expect, it } from 'bun:test';
import { generateDirectoryIndexes } from '@myco/okf/indexes.js';
import type { OkfConcept } from '@myco/okf/types.js';

const RAW_HTML = /<\/?[a-zA-Z][^>]*>/;

function concept(id: string, type: string, title?: string, description?: string): OkfConcept {
  return {
    id,
    path: `${id}.md`,
    frontmatter: { type, ...(title ? { title } : {}), ...(description ? { description } : {}) },
    body: 'Body',
    source: { id, projectId: null },
    links: [],
  };
}

const FIXTURE: OkfConcept[] = [
  concept('spores/decisions/d1', 'decision', 'Beta decision', 'About beta'),
  concept('spores/decisions/d2', 'decision', 'Alpha decision', 'About alpha'),
  concept('spores/gotchas/g1', 'gotcha', 'A gotcha', 'Gotcha description'),
];

describe('generateDirectoryIndexes', () => {
  it('generates an index for every directory with concepts beneath it', () => {
    const indexes = generateDirectoryIndexes(FIXTURE);
    // Keys are ordered by directory path (root first, then depth-lexicographic).
    expect([...indexes.keys()]).toEqual([
      'index.md',
      'spores/index.md',
      'spores/decisions/index.md',
      'spores/gotchas/index.md',
    ]);
  });

  it('groups entries by type, sorted by title then path', () => {
    const indexes = generateDirectoryIndexes(FIXTURE);
    expect(indexes.get('spores/decisions/index.md')).toBe(
      '# spores/decisions\n' +
        '\n' +
        '## decision\n' +
        '\n' +
        '* [Alpha decision](d2.md) - About alpha\n' +
        '* [Beta decision](d1.md) - About beta\n',
    );
  });

  it('renders all three directory summary forms', () => {
    const indexes = generateDirectoryIndexes(FIXTURE);
    // Homogeneous subtree: "N <type> concepts."; single child with description: reuse it.
    expect(indexes.get('spores/index.md')).toBe(
      '# spores\n' +
        '\n' +
        '## Directories\n' +
        '\n' +
        '* [decisions](decisions/index.md) - 2 decision concepts.\n' +
        '* [gotchas](gotchas/index.md) - Gotcha description\n',
    );
    // Mixed subtree: "N concepts across M types."
    expect(indexes.get('index.md')).toBe(
      '# Index\n' +
        '\n' +
        '## Directories\n' +
        '\n' +
        '* [spores](spores/index.md) - 3 concepts across 2 types.\n',
    );
  });

  it('sorts type groups alphabetically within one directory', () => {
    const indexes = generateDirectoryIndexes([
      concept('mixed/z1', 'gotcha', 'Z gotcha', 'Zd'),
      concept('mixed/a1', 'decision', 'A decision', 'Ad'),
    ]);
    const content = indexes.get('mixed/index.md')!;
    expect(content.indexOf('## decision')).toBeLessThan(content.indexOf('## gotcha'));
  });

  it('omits the description suffix when a concept has none and falls back to the basename title', () => {
    const indexes = generateDirectoryIndexes([concept('spores/bare-1', 'note')]);
    expect(indexes.get('spores/index.md')).toContain('* [bare-1](bare-1.md)\n');
  });

  it('produces no indexes for an empty concept set', () => {
    expect(generateDirectoryIndexes([]).size).toBe(0);
  });

  it('is deterministic — same inputs produce the same map', () => {
    const first = generateDirectoryIndexes(FIXTURE);
    const second = generateDirectoryIndexes([...FIXTURE]);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('escapes hostile titles and descriptions in entries', () => {
    const indexes = generateDirectoryIndexes([
      concept('spores/h1', 'note', '<script>alert(1)</script>', 'desc ](javascript:x) end'),
    ]);
    const content = indexes.get('spores/index.md')!;
    expect(RAW_HTML.test(content)).toBe(false);
    expect(content).toContain('&lt;script&gt;');
    // The escaped label cannot close the link early.
    expect(content).toContain('\\]\\(');
  });
});
