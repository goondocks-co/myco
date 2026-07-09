import { describe, expect, it } from 'bun:test';
import { generateDirectoryIndexes, generateIndexes } from '@myco/okf/indexes.js';
import type { OkfConcept, OkfDocument } from '@myco/okf/types.js';

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

function doc(docPath: string, frontmatter: Record<string, unknown>, body = 'Body'): OkfDocument {
  return { path: docPath, frontmatter: frontmatter as OkfDocument['frontmatter'], body };
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

  it('neutralizes newline injection in titles, descriptions, and types', () => {
    const indexes = generateDirectoryIndexes([
      concept('spores/n1', 'note\n\n# Injected heading', 'Title\n# Also injected', 'desc\nwith newline'),
    ]);
    const content = indexes.get('spores/index.md')!;
    // Every generated line is one of the known line shapes — nothing injected.
    for (const line of content.split('\n').filter(Boolean)) {
      expect(/^(# |## |\* \[)/.test(line)).toBe(true);
    }
    expect(content).toContain('## note # Injected heading');
    expect(content).toContain('Title # Also injected');
  });

  it('groups concepts with a non-string type under "unknown" instead of crashing', () => {
    const broken = concept('spores/x1', 'placeholder', 'T', 'D');
    (broken.frontmatter as Record<string, unknown>).type = 42;
    const indexes = generateDirectoryIndexes([broken]);
    expect(indexes.get('spores/index.md')).toContain('## unknown');
  });

  it('sorts by UTF-16 code units, independent of runtime locale', () => {
    const indexes = generateDirectoryIndexes([
      concept('spores/a-item', 'note', 'ärgernis', 'Ad'),
      concept('spores/z-item', 'note', 'zebra', 'Zd'),
    ]);
    const content = indexes.get('spores/index.md')!;
    // 'z' (U+007A) < 'ä' (U+00E4) in code-unit order, whatever the locale says.
    expect(content.indexOf('[zebra]')).toBeLessThan(content.indexOf('[ärgernis]'));
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

describe('generateIndexes', () => {
  it('groups documents by type with empty frontmatter, and roots a Subdirectories section for the parent', () => {
    const docs: OkfDocument[] = [
      doc('tables/users.md', { type: 'Table', title: 'Users', description: 'User accounts' }),
      doc('tables/posts.md', { type: 'Table', title: 'Posts', description: 'Blog posts' }),
    ];
    const indexes = generateIndexes(docs);
    expect(indexes.map((d) => d.path).sort()).toEqual(['index.md', 'tables/index.md']);

    const tablesIndex = indexes.find((d) => d.path === 'tables/index.md')!;
    expect(tablesIndex.frontmatter).toEqual({});
    expect(tablesIndex.body).not.toContain('---');
    expect(tablesIndex.body).toBe(
      '# Table\n\n' + '* [Posts](posts.md) - Blog posts\n' + '* [Users](users.md) - User accounts\n',
    );

    const rootIndex = indexes.find((d) => d.path === 'index.md')!;
    expect(rootIndex.frontmatter).toEqual({});
    expect(rootIndex.body).toBe('# Subdirectories\n\n' + '* [tables](tables/index.md) - 2 Table concepts\n');
  });

  it('produces a Subdirectories section at every nesting level, processed deepest-first', () => {
    const docs: OkfDocument[] = [
      doc('projects/backend/api.md', { type: 'Service', title: 'Api', description: 'Backend API service' }),
      doc('projects/frontend/ui.md', { type: 'Service', title: 'Ui', description: 'Frontend UI service' }),
      doc('projects/readme.md', { type: 'Doc', title: 'Readme', description: 'Project readme' }),
    ];
    const indexes = generateIndexes(docs);
    const byPath = new Map(indexes.map((d) => [d.path, d]));

    // Single-child directories reuse that child's description verbatim.
    expect(byPath.get('projects/backend/index.md')!.body).toBe(
      '# Service\n\n* [Api](api.md) - Backend API service\n',
    );
    expect(byPath.get('projects/frontend/index.md')!.body).toBe(
      '# Service\n\n* [Ui](ui.md) - Frontend UI service\n',
    );

    // Mixed directory: own Doc entry + a Subdirectories section, bullets sorted by title.
    expect(byPath.get('projects/index.md')!.body).toBe(
      '# Doc\n\n' +
        '* [Readme](readme.md) - Project readme\n' +
        '\n' +
        '# Subdirectories\n\n' +
        '* [backend](backend/index.md) - Backend API service\n' +
        '* [frontend](frontend/index.md) - Frontend UI service\n',
    );

    // Root's Subdirectories section carries a deterministic (non-LLM) summary
    // for the multi-entry "projects" directory.
    expect(byPath.get('index.md')!.body).toBe(
      '# Subdirectories\n\n* [projects](projects/index.md) - 3 concepts across 2 types\n',
    );
  });

  it('falls back to the file stem when a document has no title, and omits the suffix when it has no description', () => {
    const indexes = generateIndexes([doc('notes/bare.md', { type: 'Note' })]);
    expect(indexes.find((d) => d.path === 'notes/index.md')!.body).toBe('# Note\n\n* [bare](bare.md)\n');
  });

  it('buckets a missing or blank type under "Other"', () => {
    const indexes = generateIndexes([doc('notes/untyped.md', { type: '' })]);
    expect(indexes.find((d) => d.path === 'notes/index.md')!.body).toContain('# Other');
  });

  it('sorts bullets within a type by title, case-insensitively', () => {
    const indexes = generateIndexes([
      doc('mixed/z.md', { type: 'Note', title: 'zebra' }),
      doc('mixed/a.md', { type: 'Note', title: 'Ardvark' }),
    ]);
    const body = indexes.find((d) => d.path === 'mixed/index.md')!.body;
    expect(body.indexOf('Ardvark')).toBeLessThan(body.indexOf('zebra'));
  });

  it('skips an existing index.md child instead of double-listing it', () => {
    const indexes = generateIndexes([
      doc('notes/index.md', { type: 'Myco OKF Bundle' }),
      doc('notes/one.md', { type: 'Note', title: 'One' }),
    ]);
    const body = indexes.find((d) => d.path === 'notes/index.md')!.body;
    expect(body).not.toContain('index.md)');
    expect(body).toContain('[One](one.md)');
  });

  it('produces no indexes for an empty document set', () => {
    expect(generateIndexes([])).toEqual([]);
  });

  it('is deterministic — same inputs produce the same output', () => {
    const docs = [
      doc('a/one.md', { type: 'X', title: 'One', description: 'D1' }),
      doc('a/two.md', { type: 'X', title: 'Two', description: 'D2' }),
    ];
    expect(generateIndexes(docs)).toEqual(generateIndexes([...docs]));
  });
});
