import { describe, expect, it } from 'bun:test';
import type { CanopyEntry } from '@myco/db/schema.js';
import type { CanopyMapRow } from '@myco/canopy/map/store.js';
import { projectCanopy, type CanopyProjectionInput } from '@myco/okf/projectors/canopy.js';
import { renderConcept } from '@myco/okf/serialize.js';
import { validateConceptSource } from '@myco/okf/validate.js';

const PROJECT_ID = 'proj_0123456789abcdef0123456789abcdef';

function entry(overrides: Partial<CanopyEntry>): CanopyEntry {
  return {
    project_id: PROJECT_ID,
    machine_id: 'machine-secret-01',
    path: 'src/lock.ts',
    content_hash: 'cafebabe',
    size_bytes: 2048,
    token_estimate: 512,
    line_count: 80,
    language: 'typescript',
    exports_json: '["acquireLock","releaseLock"]',
    imports_json: '["node:fs"]',
    top_comment: 'Async lock over LifecycleLock.',
    mechanical_updated_at: 1_783_000_000,
    llm_description: 'Implements the async project lock.',
    llm_updated_at: 1_783_100_000,
    embedded: 1,
    ...overrides,
  };
}

function map(overrides: Partial<CanopyMapRow>): CanopyMapRow {
  return {
    project_id: PROJECT_ID,
    machine_id: 'machine-secret-01',
    content: '# Map\n\n- src/lock.ts — locking\n- src/missing.ts — not exported\n',
    inputs_hash: 'inputs-1',
    generated_at: 1_783_200_000,
    generated_by_run_id: 'run-raw-42',
    token_estimate: 100,
    ...overrides,
  };
}

function input(overrides: Partial<CanopyProjectionInput>): CanopyProjectionInput {
  return {
    entries: [],
    map: null,
    projectId: PROJECT_ID,
    isExcluded: () => false,
    includeUndescribed: false,
    mode: 'published',
    ...overrides,
  };
}

/** These tests run without a map; drop the expected map-missing warning. */
function fileWarnings(warnings: Array<{ code: string }>): Array<{ code: string }> {
  return warnings.filter((warning) => warning.code !== 'canopy_map_missing');
}

describe('projectCanopy — file entries', () => {
  it('derives traversal-safe encoded paths preserving basename case', () => {
    const { concepts } = projectCanopy(
      input({ entries: [entry({ path: 'packages/a b/#X.ts' })], map: null }),
    );
    const file = concepts.find((c) => c.id.startsWith('canopy/files/'))!;
    expect(file.path).toBe('canopy/files/packages/a%20b/%23X.ts.md');
  });

  it('emits spec frontmatter and body sections, and validates at myco_strict', () => {
    const { concepts } = projectCanopy(input({ entries: [entry({})] }));
    const file = concepts[0];
    expect(file.frontmatter.type).toBe('Source File');
    expect(file.frontmatter.resource).toBe('repo://src/lock.ts');
    expect(file.frontmatter.myco_path).toBe('src/lock.ts');
    expect(file.frontmatter.source_hash).toBe('cafebabe');
    expect(file.body).toContain('# Summary\n\nImplements the async project lock.');
    expect(file.body).toContain('# File Anatomy');
    expect(file.body).toContain('- acquireLock');
    expect(file.body).toContain('# Top Comment');
    expect(file.body).toContain('# Citations\n\n- repo://src/lock.ts');
    const rendered = renderConcept(file);
    expect(validateConceptSource(rendered.content, rendered.path, 'myco_strict').filter((i) => i.level === 'error')).toEqual([]);
  });

  it('skips excluded paths silently using the provided matcher', () => {
    const { concepts, warnings } = projectCanopy(
      input({
        entries: [entry({ path: '.env', llm_description: 'secrets' }), entry({})],
        isExcluded: (p) => p === '.env',
      }),
    );
    expect(concepts.map((c) => c.id)).toEqual(['canopy/files/src/lock.ts']);
    expect(fileWarnings(warnings)).toEqual([]);
  });

  it('skips undescribed entries by default with one aggregate warning', () => {
    const { concepts, warnings } = projectCanopy(
      input({
        entries: [
          entry({ path: 'a.ts', llm_description: null }),
          entry({ path: 'b.ts', llm_description: null }),
          entry({}),
        ],
      }),
    );
    expect(concepts).toHaveLength(1);
    const relevant = fileWarnings(warnings);
    expect(relevant).toHaveLength(1);
    expect(relevant[0].code).toBe('canopy_entry_undescribed');
    expect((relevant[0] as { message: string }).message).toContain('2');
  });

  it('includes undescribed entries with the flag, using the fallback summary', () => {
    const { concepts, warnings } = projectCanopy(
      input({ entries: [entry({ path: 'a.ts', llm_description: null, llm_updated_at: null })], includeUndescribed: true }),
    );
    expect(fileWarnings(warnings)).toEqual([]);
    expect(concepts[0].body).toContain('No LLM description has been generated for this file.');
    expect(concepts[0].frontmatter.timestamp).toBe(new Date(1_783_000_000 * 1000).toISOString());
  });

  it('renders malformed exports_json as "None recorded." with a warning instead of crashing', () => {
    const { concepts, warnings } = projectCanopy(
      input({ entries: [entry({ exports_json: '{not json' })] }),
    );
    expect(concepts[0].body).toContain('# Exports\n\nNone recorded.');
    expect(fileWarnings(warnings).map((w) => w.code)).toEqual(['canopy_json_malformed']);
  });
});

describe('projectCanopy — map', () => {
  it('warns and emits no map concept when the map is missing', () => {
    const { concepts, warnings } = projectCanopy(input({ entries: [entry({})], map: null }));
    expect(concepts.some((c) => c.id === 'canopy/map')).toBe(false);
    expect(warnings.map((w) => w.code)).toEqual(['canopy_map_missing']);
  });

  it('keeps map content verbatim and appends only exact-path reference links', () => {
    const { concepts } = projectCanopy(input({ entries: [entry({})], map: map({}) }));
    const mapConcept = concepts.find((c) => c.id === 'canopy/map')!;
    expect(mapConcept.path).toBe('canopy/map.md');
    expect(mapConcept.body).toStartWith('# Map\n\n- src/lock.ts — locking');
    expect(mapConcept.body).toContain('# Referenced Files\n\n- [src/lock.ts](files/src/lock.ts.md)');
    // src/missing.ts appears in the map text but projects no concept — no link.
    expect(mapConcept.body).not.toContain('](files/src/missing.ts.md)');
  });

  it('omits the referenced-files section when nothing matches', () => {
    const { concepts } = projectCanopy(
      input({ entries: [], map: map({ content: '# Map\n\nNothing relevant.\n' }) }),
    );
    const mapConcept = concepts.find((c) => c.id === 'canopy/map')!;
    expect(mapConcept.body).not.toContain('# Referenced Files');
  });

  it('hashes the generating run id in published mode and keeps it raw in local mode', () => {
    const published = projectCanopy(input({ map: map({}) })).concepts.find((c) => c.id === 'canopy/map')!;
    expect(published.source.generatedByRunId).toStartWith('run-hash-');
    expect(renderConcept(published).content).not.toContain('run-raw-42');

    const local = projectCanopy(input({ map: map({}), mode: 'local' })).concepts.find((c) => c.id === 'canopy/map')!;
    expect(local.source.generatedByRunId).toBe('run-raw-42');
  });

  it('never emits machine or raw project identifiers in published mode', () => {
    const { concepts } = projectCanopy(input({ entries: [entry({})], map: map({}) }));
    for (const concept of concepts) {
      const rendered = renderConcept(concept).content;
      expect(rendered).not.toContain('machine-secret-01');
      expect(rendered).not.toContain(PROJECT_ID);
    }
  });

  it('is deterministic — double projection is deep-equal', () => {
    const args = input({ entries: [entry({}), entry({ path: 'src/other.ts' })], map: map({}) });
    expect(projectCanopy(args)).toEqual(projectCanopy(args));
  });
});
