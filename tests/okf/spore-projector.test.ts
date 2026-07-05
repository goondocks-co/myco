import { describe, expect, it } from 'bun:test';
import type { SporeRow } from '@myco/db/queries/spores.js';
import { pluralTypeDir, projectSpores, type SporeProjectionInput } from '@myco/okf/projectors/spores.js';
import { renderConcept } from '@myco/okf/serialize.js';
import { validateConceptSource } from '@myco/okf/validate.js';

const PROJECT_ID = 'proj_0123456789abcdef0123456789abcdef';

function spore(overrides: Partial<SporeRow>): SporeRow {
  return {
    id: 'decision-abc123',
    project_id: PROJECT_ID,
    agent_id: 'claude-code',
    session_id: 'sess-1111',
    prompt_batch_id: 42,
    observation_type: 'decision',
    status: 'active',
    content: 'We chose the async lock. It retries acquisition instead of blocking.',
    context: null,
    importance: 5,
    file_path: null,
    tags: null,
    content_hash: 'hash-1',
    properties: null,
    embedded: 1,
    created_at: 1_783_000_000,
    updated_at: 1_783_100_000,
    machine_id: 'machine-secret-01',
    synced_at: null,
    ...overrides,
  };
}

function input(overrides: Partial<SporeProjectionInput>): SporeProjectionInput {
  return {
    spores: [],
    resolutionEdges: [],
    releaseStates: new Map(),
    projectId: PROJECT_ID,
    mode: 'published',
    includedIds: new Set(),
    canopyConceptIdByRepoPath: new Map(),
    ...overrides,
  };
}

describe('pluralTypeDir', () => {
  it('maps the known lifecycle types', () => {
    expect(pluralTypeDir('decision')).toBe('decisions');
    expect(pluralTypeDir('gotcha')).toBe('gotchas');
    expect(pluralTypeDir('bug_fix')).toBe('bug-fixes');
    expect(pluralTypeDir('discovery')).toBe('discoveries');
    expect(pluralTypeDir('trade_off')).toBe('trade-offs');
    expect(pluralTypeDir('cross-cutting')).toBe('cross-cutting');
    expect(pluralTypeDir('wisdom')).toBe('wisdom');
  });

  it('slugifies unknown types deterministically', () => {
    expect(pluralTypeDir('architecture')).toBe('architectures');
    expect(pluralTypeDir('Weird Type!')).toBe('weird-types');
  });
});

describe('projectSpores', () => {
  it('derives a stable concept path and spec frontmatter', () => {
    const { concepts, warnings } = projectSpores(input({ spores: [spore({})] }));
    expect(warnings).toEqual([]);
    expect(concepts).toHaveLength(1);
    const concept = concepts[0];
    expect(concept.path).toBe('spores/decisions/decision-abc123.md');
    expect(concept.frontmatter.type).toBe('Myco Spore');
    expect(concept.frontmatter.resource).toBe('myco://spores/decision-abc123');
    expect(concept.frontmatter.observation_type).toBe('decision');
    expect(concept.frontmatter.status).toBe('active');
    expect(concept.frontmatter.source_hash).toBe('hash-1');
    expect(concept.frontmatter.timestamp).toBe(new Date(1_783_100_000 * 1000).toISOString());
    expect(concept.frontmatter.tags).toEqual(['myco', 'spore', 'decision']);
    expect(String(concept.frontmatter.myco_project_ref)).toStartWith('project-hash-');
  });

  it('splits stored comma-joined tags and dedupes', () => {
    const { concepts } = projectSpores(
      input({ spores: [spore({ tags: 'sqlite, locking, decision' })] }),
    );
    expect(concepts[0].frontmatter.tags).toEqual(['myco', 'spore', 'decision', 'sqlite', 'locking']);
  });

  it('carries all four lifecycle statuses into frontmatter', () => {
    for (const status of ['active', 'superseded', 'consolidated', 'obsolete']) {
      const { concepts } = projectSpores(input({ spores: [spore({ id: `s-${status}`, status })] }));
      expect(concepts[0].frontmatter.status).toBe(status);
    }
  });

  it('renders supersession links in both directions when both spores are included', () => {
    const a = spore({ id: 'decision-old', status: 'superseded' });
    const b = spore({ id: 'decision-new' });
    const { concepts, warnings } = projectSpores(
      input({
        spores: [a, b],
        resolutionEdges: [{ spore_id: 'decision-old', new_spore_id: 'decision-new', action: 'supersede' }],
        includedIds: new Set(['decision-old', 'decision-new']),
      }),
    );
    expect(warnings).toEqual([]);
    const oldBody = concepts.find((c) => c.id.endsWith('decision-old'))!.body;
    const newBody = concepts.find((c) => c.id.endsWith('decision-new'))!.body;
    expect(oldBody).toContain('- Superseded by [decision-new](decision-new.md)');
    expect(newBody).toContain('- Supersedes [decision-old](decision-old.md)');
  });

  it('renders consolidation relationships', () => {
    const source = spore({ id: 'gotcha-1', observation_type: 'gotcha', status: 'consolidated' });
    const target = spore({ id: 'wisdom-1', observation_type: 'wisdom' });
    const { concepts } = projectSpores(
      input({
        spores: [source, target],
        resolutionEdges: [{ spore_id: 'gotcha-1', new_spore_id: 'wisdom-1', action: 'consolidate' }],
        includedIds: new Set(['gotcha-1', 'wisdom-1']),
      }),
    );
    const sourceBody = concepts.find((c) => c.id.endsWith('gotcha-1'))!.body;
    const targetBody = concepts.find((c) => c.id.endsWith('wisdom-1'))!.body;
    expect(sourceBody).toContain('- Consolidated into [wisdom-1](../wisdom/wisdom-1.md)');
    expect(targetBody).toContain('- Consolidates [gotcha-1](../gotchas/gotcha-1.md)');
  });

  it('notes excluded relationship targets in plain text with a warning', () => {
    const { concepts, warnings } = projectSpores(
      input({
        spores: [spore({ id: 'decision-old', status: 'superseded' })],
        resolutionEdges: [{ spore_id: 'decision-old', new_spore_id: 'decision-gone', action: 'supersede' }],
        includedIds: new Set(['decision-old']),
      }),
    );
    expect(concepts[0].body).toContain('Replacement spore decision-gone was not included in this export.');
    expect(concepts[0].body).not.toContain('](decision-gone.md)');
    expect(warnings.map((w) => w.code)).toEqual(['relationship_target_excluded']);
  });

  it('links file_path to an included canopy concept and falls back to plain text', () => {
    const linked = projectSpores(
      input({
        spores: [spore({ file_path: 'src/lock.ts' })],
        canopyConceptIdByRepoPath: new Map([['src/lock.ts', 'canopy/files/src/lock.ts']]),
      }),
    );
    expect(linked.concepts[0].body).toContain(
      '- Discussed file: [src/lock.ts](../../canopy/files/src/lock.ts.md)',
    );

    const plain = projectSpores(input({ spores: [spore({ file_path: 'src/lock.ts' })] }));
    expect(plain.concepts[0].body).toContain('- Discussed file: src/lock.ts');
    expect(plain.concepts[0].body).not.toContain('](../../canopy');
  });

  it('handles missing optional metadata and still validates at myco_strict', () => {
    const { concepts } = projectSpores(
      input({
        spores: [spore({ updated_at: null, content_hash: null, tags: null, session_id: null, file_path: null })],
      }),
    );
    const rendered = renderConcept(concepts[0]);
    const issues = validateConceptSource(rendered.content, rendered.path, 'myco_strict');
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(concepts[0].frontmatter.timestamp).toBe(new Date(1_783_000_000 * 1000).toISOString());
    expect(typeof concepts[0].frontmatter.source_hash).toBe('string');
  });

  it('includes release_state only when known', () => {
    const withState = projectSpores(
      input({ spores: [spore({})], releaseStates: new Map([['decision-abc123', 'released']]) }),
    );
    expect(withState.concepts[0].frontmatter.release_state).toBe('released');

    const without = projectSpores(input({ spores: [spore({})] }));
    expect('release_state' in without.concepts[0].frontmatter).toBe(false);
  });

  it('omits machine, session, and batch identifiers in published mode', () => {
    const { concepts } = projectSpores(input({ spores: [spore({})], mode: 'published' }));
    const rendered = renderConcept(concepts[0]).content;
    expect(rendered).not.toContain('machine-secret-01');
    expect(rendered).not.toContain('sess-1111');
    expect(rendered).not.toContain(PROJECT_ID);
  });

  it('includes local provenance in local mode', () => {
    const { concepts } = projectSpores(input({ spores: [spore({})], mode: 'local' }));
    expect(concepts[0].frontmatter.myco_machine_id).toBe('machine-secret-01');
    expect(concepts[0].frontmatter.myco_session_id).toBe('sess-1111');
  });

  it('injects myco_id into the rendered document', () => {
    const { concepts } = projectSpores(input({ spores: [spore({})] }));
    expect(renderConcept(concepts[0]).content).toContain('myco_id: decision-abc123\n');
  });

  it('ignores #-comment lines inside code fences when deriving the title', () => {
    const content = 'Fix applied to the retry loop.\n\n```bash\n# run the smoke suite\nnpm test\n```';
    const { concepts } = projectSpores(input({ spores: [spore({ content })] }));
    expect(concepts[0].frontmatter.title).toBe('Fix applied to the retry loop.');
  });

  it('does not let a heading buried after prose outrank the first sentence', () => {
    const content = 'The lock was broken. Details follow.\n\n# Appendix\n\nMore text.';
    const { concepts } = projectSpores(input({ spores: [spore({ content })] }));
    expect(concepts[0].frontmatter.title).toBe('The lock was broken.');
  });

  it('truncates titles on code-point boundaries, never splitting surrogate pairs', () => {
    const content = `${'😀'.repeat(60)} end.`;
    const { concepts } = projectSpores(input({ spores: [spore({ content })] }));
    const title = concepts[0].frontmatter.title as string;
    expect(title.isWellFormed()).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
  });

  it('dedupes duplicate resolution edges and skips self-edges', () => {
    const { concepts, warnings } = projectSpores(
      input({
        spores: [spore({ id: 'x', status: 'superseded' })],
        resolutionEdges: [
          { spore_id: 'x', new_spore_id: 'x', action: 'supersede' },
          { spore_id: 'x', new_spore_id: 'y', action: 'supersede' },
          { spore_id: 'x', new_spore_id: 'y', action: 'supersede' },
        ],
        includedIds: new Set(['x']),
      }),
    );
    const body = concepts[0].body;
    expect(body.split('Replacement spore y was not included in this export.')).toHaveLength(2);
    expect(body).not.toContain('Superseded by [x]');
    expect(warnings).toHaveLength(1);
  });

  it('labels excluded incoming counterparts as predecessors, not replacements', () => {
    const { concepts } = projectSpores(
      input({
        spores: [spore({ id: 'decision-new' })],
        resolutionEdges: [{ spore_id: 'decision-gone', new_spore_id: 'decision-new', action: 'supersede' }],
        includedIds: new Set(['decision-new']),
      }),
    );
    expect(concepts[0].body).toContain('Predecessor spore decision-gone was not included in this export.');
  });

  it('is deterministic — double projection is deep-equal', () => {
    const args = input({
      spores: [spore({}), spore({ id: 'gotcha-9', observation_type: 'gotcha' })],
      resolutionEdges: [{ spore_id: 'gotcha-9', new_spore_id: 'decision-abc123', action: 'supersede' }],
      includedIds: new Set(['gotcha-9', 'decision-abc123']),
    });
    expect(projectSpores(args)).toEqual(projectSpores(args));
  });
});
