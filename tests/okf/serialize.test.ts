import { describe, expect, it } from 'bun:test';
import {
  escapeInlineText,
  escapeLinkLabel,
  renderConcept,
  renderRootIndex,
  renderRootLog,
} from '@myco/okf/serialize.js';
import { validateConceptSource } from '@myco/okf/validate.js';
import type { OkfConcept } from '@myco/okf/types.js';

const RAW_HTML = /<\/?[a-zA-Z][^>]*>/;

function concept(overrides: Partial<OkfConcept>): OkfConcept {
  return {
    id: 'spores/decisions/decision-abcd1234',
    path: 'spores/decisions/decision-abcd1234.md',
    frontmatter: { type: 'decision' },
    body: 'Body',
    source: { sourceKind: 'spore', id: 'decision-abcd1234', projectId: null },
    links: [],
    ...overrides,
  };
}

describe('renderConcept', () => {
  it('renders a minimal concept byte-exactly with injected source identity', () => {
    const { path, content } = renderConcept(
      concept({ frontmatter: { type: 'decision' }, source: { id: 'decision-abcd1234', projectId: null } }),
    );
    expect(path).toBe('spores/decisions/decision-abcd1234.md');
    expect(content).toBe('---\ntype: decision\nmyco_id: decision-abcd1234\n---\n\nBody\n');
  });

  it('injects full provenance without overriding projector-set keys', () => {
    const { content } = renderConcept(
      concept({
        frontmatter: { type: 'decision', title: 'T', myco_id: 'projector-owned' },
        source: {
          sourceKind: 'spore',
          id: 'decision-abcd1234',
          projectId: 'proj_x',
          machineId: 'm1',
          sourceHash: 'hash',
          sourceUpdatedAt: '2026-07-04T00:00:00Z',
          projectionVersion: '1',
          generatedByRunId: 'run-9',
        },
      }),
    );
    expect(content).toContain('myco_id: projector-owned\n');
    expect(content).toContain('myco_source_kind: spore\n');
    expect(content).toContain('myco_project: proj_x\n');
    expect(content).toContain('myco_machine_id: m1\n');
    expect(content).toContain('myco_source_hash: hash\n');
    expect(content).toContain('myco_source_updated_at: 2026-07-04T00:00:00Z\n');
    expect(content).toContain('myco_projection_version: "1"\n');
    expect(content).toContain('myco_generated_by_run_ref: run-9\n');
  });

  it('marks stale concepts', () => {
    const { content } = renderConcept(concept({ stale: true }));
    expect(content).toContain('stale: true\n');
  });

  it('renders links as a deterministic Related section with relative hrefs', () => {
    const { content } = renderConcept(
      concept({
        links: [
          {
            from: 'spores/decisions/decision-abcd1234',
            to: 'spores/gotchas/gotcha-1',
            label: 'Related gotcha',
            reason: 'concept_reference',
          },
          {
            from: 'spores/decisions/decision-abcd1234',
            to: 'canopy/map',
            label: 'Project map',
            reason: 'map_reference',
          },
        ],
      }),
    );
    expect(content).toContain(
      '## Related\n\n- [Related gotcha](../gotchas/gotcha-1.md) — concept_reference\n- [Project map](../../canopy/map.md) — map_reference\n',
    );
  });

  it('refuses reserved filenames', () => {
    expect(() => renderConcept(concept({ id: 'spores/index', path: 'spores/index.md' }))).toThrow(
      /reserved_filename/,
    );
    expect(() => renderConcept(concept({ id: 'log', path: 'log.md' }))).toThrow(/reserved_filename/);
  });

  it('refuses a path that does not match the id', () => {
    expect(() => renderConcept(concept({ path: 'somewhere/else.md' }))).toThrow(/path_identity_violation/);
  });

  it('renders a hostile title safely and the output passes validation', () => {
    const hostile = concept({
      frontmatter: {
        type: 'decision',
        title: '<script>alert(1)</script>',
        description: 'Legit ](javascript:x) description',
        tags: ['okf'],
        timestamp: '2026-07-05T00:00:00Z',
      },
      body: 'Safe body.',
      links: [
        {
          from: 'spores/decisions/decision-abcd1234',
          to: 'spores/gotchas/gotcha-1',
          label: '</b>](javascript:alert(1))',
          reason: 'concept_reference',
        },
      ],
    });
    const { path, content } = renderConcept(hostile);
    // The link label is neutralized — no unescaped ]( sequence survives in the Related section.
    expect(content).toContain('- [&lt;/b&gt;\\]\\(javascript:alert\\(1\\)\\)](../gotchas/gotcha-1.md)');
    // The rendered body carries no raw HTML.
    const body = content.split('---\n').slice(2).join('---\n');
    expect(RAW_HTML.test(body)).toBe(false);
    // Frontmatter stores the title as data; the document still validates cleanly.
    expect(validateConceptSource(content, path, 'conformance')).toEqual([]);
    expect(
      validateConceptSource(content, path, 'myco_strict').filter((issue) => issue.level === 'error'),
    ).toEqual([]);
  });
});

describe('renderRootIndex', () => {
  it('renders the frontmatter-bearing root index byte-exactly', () => {
    const out = renderRootIndex({
      title: 'Myco Knowledge Bundle',
      description: 'Generated from the project vault.',
      timestamp: '2026-07-05T12:00:00Z',
      mycoProjectRef: 'myco://proj_abc',
      inputsHash: 'deadbeef',
      generatedByRunRef: null,
      sections: [{ dir: 'spores', summary: '3 decision concepts.' }],
    });
    expect(out).toBe(
      '---\n' +
        'okf_version: "0.1"\n' +
        'type: Myco OKF Bundle\n' +
        'title: Myco Knowledge Bundle\n' +
        'description: Generated from the project vault.\n' +
        'timestamp: 2026-07-05T12:00:00Z\n' +
        'generator: myco\n' +
        'myco_project_ref: myco://proj_abc\n' +
        'inputs_hash: deadbeef\n' +
        '---\n' +
        '\n' +
        '# Myco Knowledge Bundle\n' +
        '\n' +
        'Generated from the project vault.\n' +
        '\n' +
        '## Contents\n' +
        '\n' +
        '* [spores/](spores/index.md) - 3 decision concepts.\n',
    );
  });

  it('includes generated_by_run_ref when present', () => {
    const out = renderRootIndex({
      title: 'T',
      description: 'D',
      timestamp: '2026-07-05T12:00:00Z',
      mycoProjectRef: 'myco://proj_abc',
      inputsHash: 'deadbeef',
      generatedByRunRef: 'run-42',
      sections: [],
    });
    expect(out).toContain('generated_by_run_ref: run-42\n');
  });

  it('escapes hostile titles and summaries in the rendered body', () => {
    const out = renderRootIndex({
      title: '<script>x</script>',
      description: 'desc <b>bold</b>',
      timestamp: '2026-07-05T12:00:00Z',
      mycoProjectRef: 'myco://proj_abc',
      inputsHash: 'deadbeef',
      sections: [{ dir: 'spores', summary: '<img src=x>' }],
    });
    const body = out.split('---\n').slice(2).join('---\n');
    expect(RAW_HTML.test(body)).toBe(false);
    expect(body).toContain('# &lt;script&gt;x&lt;/script&gt;');
  });
});

describe('renderRootLog', () => {
  it('renders the log byte-exactly in caller order', () => {
    const out = renderRootLog([
      { date: '2026-07-05', lines: ['Added 3 spore concepts', 'Updated canopy/map'] },
      { date: '2026-07-01', lines: ['Initial bundle'] },
    ]);
    expect(out).toBe(
      '# Directory Update Log\n' +
        '\n' +
        '## 2026-07-05\n' +
        '\n' +
        '- Added 3 spore concepts\n' +
        '- Updated canopy/map\n' +
        '\n' +
        '## 2026-07-01\n' +
        '\n' +
        '- Initial bundle\n',
    );
  });

  it('escapes raw HTML in log lines', () => {
    const out = renderRootLog([{ date: '2026-07-05', lines: ['<script>bad</script>'] }]);
    expect(RAW_HTML.test(out)).toBe(false);
    expect(out).toContain('- &lt;script&gt;bad&lt;/script&gt;');
  });
});

describe('escape helpers', () => {
  it('escapeInlineText neutralizes HTML metacharacters', () => {
    expect(escapeInlineText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('escapeLinkLabel additionally neutralizes link metacharacters', () => {
    expect(escapeLinkLabel('x](evil)')).toBe('x\\]\\(evil\\)');
    expect(escapeLinkLabel('[x]')).toBe('\\[x\\]');
  });
});
