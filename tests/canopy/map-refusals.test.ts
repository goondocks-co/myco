import { expect, it } from 'bun:test';
import { MAP_LIMITS, MAP_WRITE_BOUNDS, MAX_MAP_BYTES, MapArtifactError, assertMapEvidence, assertIncrementalMap, parseMapArtifact, parseMapSourcePin } from '@goondocks/myco-shared/canopy';

const SENTINEL = 'private-submitted-content';
const file = () => ({ path: 'src/main.ts', sha256: 'a'.repeat(MAP_LIMITS.sha256) });
const annotation = () => ({ path: 'src', annotation: 'Source', groundedIn: [file()] });
const artifact = () => ({ directories: [annotation()], domains: [{ id: 'core', title: 'Core', files: [annotation()] }] });

function message(parse: () => unknown): string {
  try { parse(); } catch (error) {
    expect(error).toBeInstanceOf(MapArtifactError);
    return (error as Error).message;
  }
  throw new Error('Expected a map refusal');
}
function check(parse: () => unknown, path: string, bound: string, received: string) {
  const text = message(parse);
  expect(text).toContain(path + ':');
  expect(text).toContain(bound);
  expect(text).toContain('received ' + received);
  expect(text).not.toContain(SENTINEL);
}

it('names every list and line bound, indexed field and received kind or length without content', () => {
  const listFields = [
    ['directories', MAP_LIMITS.directories], ['domains', MAP_LIMITS.domains],
    ['domains.0.files', MAP_LIMITS.files], ['directories.0.groundedIn', MAP_LIMITS.groundedIn],
    ['domains.0.files.0.groundedIn', MAP_LIMITS.groundedIn],
  ] as const;
  const lineFields = [
    ['directories.0.path', MAP_LIMITS.path], ['directories.0.annotation', MAP_LIMITS.annotation],
    ['domains.0.id', MAP_LIMITS.id], ['domains.0.title', MAP_LIMITS.title],
    ['domains.0.files.0.path', MAP_LIMITS.path], ['domains.0.files.0.annotation', MAP_LIMITS.annotation],
    ['domains.0.files.0.groundedIn.0.path', MAP_LIMITS.path],
  ] as const;
  const changed = (field: string, value: unknown) => {
    const result = artifact();
    const parts = field.split('.');
    let parent: Record<string, unknown> = result;
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[parts.at(-1)!] = value;
    return () => parseMapArtifact(result);
  };
  const path = (field: string) => 'artifact.' + field;
  for (const [field, max] of listFields) {
    for (const [value, received] of [[[], 'array length 0'], [Array(max + 1).fill(SENTINEL), `array length ${max + 1}`], [SENTINEL, `string length ${SENTINEL.length}`], [null, 'null']] as const) {
      check(changed(field, value), path(field), `1..${max}`, received);
    }
  }
  for (const [field, max] of lineFields) {
    for (const value of ['', ' ', SENTINEL + '\n', SENTINEL.padEnd(max + 1, 'x')]) {
      check(changed(field, value), path(field), `1..${max}`, `string length ${value.length}`);
    }
    check(changed(field, {}), path(field), `1..${max}`, 'object');
  }
  for (const field of ['directories.0.groundedIn.0.sha256', 'domains.0.files.0.groundedIn.0.sha256']) {
    for (const value of ['', SENTINEL, 'A'.repeat(MAP_LIMITS.sha256), 'a'.repeat(MAP_LIMITS.sha256 + 1), null]) {
      check(changed(field, value), path(field), `exactly ${MAP_LIMITS.sha256} lowercase hex characters`, value === null ? 'null' : `string length ${value.length}`);
    }
  }
  for (const field of ['directories.0', 'domains.0', 'domains.0.files.0', 'directories.0.groundedIn.0']) {
    check(changed(field, SENTINEL), path(field), 'one object', `string length ${SENTINEL.length}`);
  }
  check(() => parseMapArtifact(null), 'artifact', 'one object', 'null');
  check(changed('domains.0.id', '-' + SENTINEL), 'artifact.domains.0.id', `1..${MAP_LIMITS.id} lowercase`, `string length ${SENTINEL.length + 1}`);
  check(changed('directories.0.path', '../' + SENTINEL), 'artifact.directories.0.path', `1..${MAP_LIMITS.path}`, `string length ${SENTINEL.length + 3}`);
});

it('names uniqueness and serialized byte bounds without echoing entries', () => {
  const duplicate = artifact();
  duplicate.domains[0]!.id = SENTINEL;
  duplicate.domains.push(duplicate.domains[0]!);
  check(() => parseMapArtifact(duplicate), 'artifact.domains.1.id', `1..${MAP_LIMITS.domains}`, '2 entries with 1 unique values');
  const skeleton = artifact();
  skeleton.directories[0]!.path = SENTINEL;
  skeleton.directories.push(skeleton.directories[0]!);
  check(() => parseMapArtifact(skeleton), 'artifact.directories.1.path', `1..${MAP_LIMITS.directories}`, '2 entries with 1 unique values');
  const large = artifact();
  large.directories = Array.from({ length: MAP_LIMITS.directories }, (_, index) => ({ ...annotation(), path: `src/${index}`, groundedIn: Array.from({ length: MAP_LIMITS.groundedIn }, () => ({ ...file(), path: SENTINEL.padEnd(MAP_LIMITS.path, 'x') })) }));
  const bytes = new TextEncoder().encode(JSON.stringify(large)).byteLength;
  expect(bytes).toBeGreaterThan(MAX_MAP_BYTES);
  check(() => parseMapArtifact(large), 'artifact', `at most ${MAX_MAP_BYTES} UTF-8 bytes`, `${bytes} bytes`);
});

it('accepts exact line and list boundaries and reports source-pin bounds', () => {
  const exact = artifact();
  exact.directories = Array.from({ length: MAP_LIMITS.directories }, (_, index) => ({ ...annotation(), path: `${index}`.padEnd(MAP_LIMITS.path, 'x'), annotation: 'x'.repeat(MAP_LIMITS.annotation) }));
  exact.domains = Array.from({ length: MAP_LIMITS.domains }, (_, index) => ({ id: `${index}`.padEnd(MAP_LIMITS.id, 'x'), title: 'x'.repeat(MAP_LIMITS.title), files: Array.from({ length: MAP_LIMITS.files }, () => annotation()) }));
  exact.domains[0]!.files[0]!.groundedIn = Array.from({ length: MAP_LIMITS.groundedIn }, file);
  expect(parseMapArtifact(exact)).toEqual(exact);
  check(() => parseMapSourcePin({ inputHash: SENTINEL, priorRevision: null }), 'source.inputHash', `exactly ${MAP_LIMITS.sha256}`, `string length ${SENTINEL.length}`);
  const source = { inputHash: file().sha256, priorRevision: SENTINEL.padEnd(MAP_LIMITS.priorRevision + 1, 'x') };
  check(() => parseMapSourcePin(source), 'source.priorRevision', `1..${MAP_LIMITS.priorRevision}`, `string length ${source.priorRevision.length}`);
  expect(parseMapSourcePin({ ...source, priorRevision: 'x'.repeat(MAP_LIMITS.priorRevision) }).priorRevision).toHaveLength(MAP_LIMITS.priorRevision);
});

it('keeps submitted paths and titles out of evidence and incremental refusals', () => {
  const value = artifact();
  value.directories[0]!.path = SENTINEL;
  value.domains[0]!.title = SENTINEL;
  value.domains[0]!.files[0]!.path = SENTINEL;
  value.domains[0]!.files[0]!.groundedIn = [{ path: SENTINEL, sha256: file().sha256 }];
  check(() => assertMapEvidence(value, [file()], new Set()), 'artifact.domains.0.files.0.path', 'one admitted source file', `string length ${SENTINEL.length}`);
  const files = [{ path: SENTINEL, sha256: file().sha256 }];
  value.domains[0]!.files[0]!.groundedIn = [file()];
  check(() => assertMapEvidence(value, files, new Set([SENTINEL])), 'artifact.domains.0.files.0.groundedIn', 'at least 1 reference', '0 matching references');
  value.domains[0]!.files[0]!.groundedIn = files;
  value.directories[0]!.path = 'missing/' + SENTINEL;
  check(() => assertMapEvidence(value, files, new Set([SENTINEL])), 'artifact.directories.0.path', 'one directory or file', `string length ${value.directories[0]!.path.length}`);
  value.directories[0]!.path = SENTINEL;
  value.directories[0]!.groundedIn = [{ path: SENTINEL, sha256: 'b'.repeat(MAP_LIMITS.sha256) }];
  check(() => assertMapEvidence(value, files, new Set([SENTINEL])), 'artifact.directories.0.groundedIn.0', '1 grounding matching verified source', '0 verified matches');
  const after = structuredClone(value);
  after.domains[0]!.title = 'Changed';
  check(() => assertIncrementalMap(value, after, new Set()), 'artifact.domains.0', '0 changes', 'a changed or missing object');
  after.domains = value.domains;
  after.directories = [];
  check(() => assertIncrementalMap(value, after, new Set()), 'artifact.directories.0', '0 changes', 'a changed or missing object');
});

it('declares every artifact bound before a write', () => {
  for (const bound of [
    `at most ${MAX_MAP_BYTES} UTF-8 bytes`,
    `artifact.directories: 1..${MAP_LIMITS.directories}`, `artifact.domains: 1..${MAP_LIMITS.domains}`,
    `artifact.domains.<index>.files: 1..${MAP_LIMITS.files}`, `groundedIn: 1..${MAP_LIMITS.groundedIn}`,
    `path: 1..${MAP_LIMITS.path}`, `annotation: 1..${MAP_LIMITS.annotation}`,
    `title: 1..${MAP_LIMITS.title}`, `id: 1..${MAP_LIMITS.id}`,
    `groundedIn.<index>.sha256: exactly ${MAP_LIMITS.sha256} lowercase hexadecimal`,
  ]) expect(MAP_WRITE_BOUNDS).toContain(bound);
});
