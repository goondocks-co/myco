import { describe, expect, it } from 'bun:test';
import { adoptConcepts } from '@myco/okf/projectors/concepts.js';

const VALID_CONCEPT =
  '---\n' +
  'type: Architecture Note\n' +
  'title: Locking Model\n' +
  'description: Why the bundle lock is async.\n' +
  'tags:\n  - okf\n' +
  'timestamp: 2026-07-05T00:00:00Z\n' +
  'source_concepts:\n  - concepts/decision-log\n' +
  'x_vendor: preserved\n' +
  '---\n' +
  '\n' +
  'The lock retries acquisition.\n';

const CITED_PEER =
  '---\ntype: Note\ntitle: Decision Log\ndescription: D.\ntags:\n  - okf\ntimestamp: 2026-07-05T00:00:00Z\n---\n\nBody with a [link](../spores/decisions/decision-1.md).\n';

function file(bundleRelPath: string, raw: string, mtimeIso = '2026-07-05T12:00:00Z') {
  return { bundleRelPath, raw, mtimeIso };
}

describe('adoptConcepts', () => {
  it('adopts a valid concept verbatim, preserving unknown frontmatter', () => {
    const { concepts, errors } = adoptConcepts({
      files: [file('concepts/locking-model.md', VALID_CONCEPT), file('concepts/decision-log.md', CITED_PEER)],
    });
    expect(errors.filter((e) => e.level === 'error')).toEqual([]);
    const adopted = concepts.find((c) => c.id === 'concepts/locking-model')!;
    expect(adopted.path).toBe('concepts/locking-model.md');
    expect(adopted.frontmatter.type).toBe('Architecture Note');
    expect(adopted.frontmatter.x_vendor).toBe('preserved');
    expect(adopted.frontmatter.source_concepts).toEqual(['concepts/decision-log']);
    expect(adopted.body).toBe('The lock retries acquisition.');
    expect(adopted.source.sourceKind).toBe('okf_concept');
    expect(adopted.source.sourceUpdatedAt).toBe('2026-07-05T12:00:00Z');
    expect(typeof adopted.source.sourceHash).toBe('string');
  });

  it('rejects files outside concepts/ as deterministic paths', () => {
    const { concepts, errors } = adoptConcepts({
      files: [file('spores/decisions/decision-1.md', VALID_CONCEPT)],
    });
    expect(concepts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('deterministic_path_not_adoptable');
    expect(errors[0].level).toBe('error');
  });

  it('rejects a concept without a type', () => {
    const { errors } = adoptConcepts({
      files: [file('concepts/untyped.md', '---\ntitle: No type\n---\n\nBody.\n')],
    });
    expect(errors.map((e) => e.code)).toEqual(['missing_type']);
    expect(errors[0].level).toBe('error');
  });

  it('surfaces parser codes for unparseable files instead of dropping them', () => {
    const { concepts, errors } = adoptConcepts({
      files: [file('concepts/broken.md', 'no frontmatter here')],
    });
    expect(concepts).toEqual([]);
    expect(errors[0].code).toBe('missing_frontmatter');
    expect(errors[0].level).toBe('error');
  });

  it('warns (not errors) on missing citations', () => {
    const bare = '---\ntype: Note\ntitle: Bare\ndescription: B.\n---\n\nNo citations at all.\n';
    const { concepts, errors } = adoptConcepts({ files: [file('concepts/bare.md', bare)] });
    expect(concepts).toHaveLength(1);
    const warnings = errors.filter((e) => e.level === 'warning');
    expect(warnings.map((w) => w.code)).toEqual(['concept_missing_citation']);
    expect(errors.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('treats an in-bundle markdown link as a citation', () => {
    const { errors } = adoptConcepts({ files: [file('concepts/linked.md', CITED_PEER)] });
    expect(errors).toEqual([]);
  });

  it('errors on dangling source_concepts within the concepts/ namespace', () => {
    const dangling = VALID_CONCEPT.replace('concepts/decision-log', 'concepts/never-existed');
    const { errors } = adoptConcepts({ files: [file('concepts/locking-model.md', dangling)] });
    expect(errors.filter((e) => e.level === 'error').map((e) => e.code)).toEqual(['concept_citation_dangling']);
  });

  it('defers cross-namespace source_concepts to the bundle capability', () => {
    const crossNamespace = VALID_CONCEPT.replace('concepts/decision-log', 'spores/decisions/decision-1');
    const { errors } = adoptConcepts({ files: [file('concepts/locking-model.md', crossNamespace)] });
    // Not resolvable here — and deliberately not an error at adoption time.
    expect(errors.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('is deterministic — double adoption is deep-equal', () => {
    const files = [file('concepts/locking-model.md', VALID_CONCEPT), file('concepts/decision-log.md', CITED_PEER)];
    expect(adoptConcepts({ files })).toEqual(adoptConcepts({ files }));
  });
});
