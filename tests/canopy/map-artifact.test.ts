import { expect, it } from 'bun:test';
import { assertIncrementalMap, assertMapEvidence, parseMapArtifact, renderMap } from '@goondocks/myco-shared/canopy';

const file = { path: 'src/main.ts', sha256: 'a'.repeat(64) };
const value = () => ({
  directories: [{ path: 'src', annotation: 'Application source.', groundedIn: [file] }],
  domains: [{ id: 'application', title: 'Application', files: [{ path: file.path, annotation: 'Starts the application.', groundedIn: [file] }] }],
});

it('refuses invented file evidence and annotations over unread source', () => {
  const artifact = parseMapArtifact(value());
  expect(() => assertMapEvidence(artifact, [file], new Set())).toThrow('Read the annotated source');
  expect(() => assertMapEvidence(artifact, [{ ...file, sha256: 'b'.repeat(64) }], new Set([file.path]))).toThrow('grounding');
  expect(() => assertMapEvidence(artifact, [file], new Set([file.path]))).not.toThrow();
  expect(() => assertMapEvidence(artifact, [file], new Set(), artifact)).not.toThrow();
  expect(() => assertMapEvidence(artifact, [{ ...file, sha256: 'b'.repeat(64) }], new Set(), artifact)).toThrow('grounding');
  expect(() => parseMapArtifact({ ...value(), domains: [value().domains[0], value().domains[0]] })).toThrow('unique');
});

it('preserves unaffected domains while permitting a changed-file update', () => {
  const before = parseMapArtifact(value());
  const after = parseMapArtifact(value());
  after.domains[0]!.files[0]!.annotation = 'Starts the revised application.';
  expect(() => assertIncrementalMap(before, after, new Set(['other.ts']))).toThrow('Preserve');
  expect(() => assertIncrementalMap(before, after, new Set([file.path]))).not.toThrow();
});

it('renders the accepted map structure with machine-readable commit and annotation provenance', () => {
  const repository = { url: 'https://example.test/repo.git', branch: 'main', commit: 'b'.repeat(40) };
  const content = renderMap(parseMapArtifact(value()), repository);
  expect(content).toContain('## Directory skeleton');
  expect(content).toContain('## Key files / golden paths');
  const provenance = JSON.parse(content.split('<!-- Map Provenance\n')[1]!.split('\n-->')[0]!);
  expect(provenance.repository).toEqual(repository);
  expect(provenance.domains[0].annotations[0].groundedIn).toEqual([file]);
});
