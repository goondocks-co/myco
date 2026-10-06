import type { RepositoryPin } from './repository.js';

export const MAX_MAP_BYTES = 128 * 1024;
export const MAP_LIMITS = {
  directories: 32, domains: 8, files: 8, groundedIn: 16,
  path: 512, annotation: 500, id: 64, title: 100, sha256: 64, priorRevision: 64,
} as const;

/** Bounds for the map writer, schema and run instructions. */
export const MAP_WRITE_BOUNDS = [
  `artifact: one object, at most ${MAX_MAP_BYTES} UTF-8 bytes in the complete text representation of its accepted fields.`,
  `Diagnostic field paths use dot-separated numeric indices, starting at 0 (for example artifact.domains.${MAP_LIMITS.domains - 1}.files.${MAP_LIMITS.files - 1}.groundedIn.${MAP_LIMITS.groundedIn - 1}.sha256).`,
  `artifact.directories: 1..${MAP_LIMITS.directories} entries with unique paths. artifact.domains: 1..${MAP_LIMITS.domains} entries with unique ids.`,
  `artifact.domains.<index>.files: 1..${MAP_LIMITS.files} entries. Each annotation's groundedIn: 1..${MAP_LIMITS.groundedIn} objects.`,
  `Each path: 1..${MAP_LIMITS.path} characters, relative to the checkout root; no leading slash, backslash, empty, dot, parent or .git segments.`,
  `Each annotation: 1..${MAP_LIMITS.annotation} characters. Each domain title: 1..${MAP_LIMITS.title} characters.`,
  `Each domain id: 1..${MAP_LIMITS.id} characters, lowercase letters, digits and hyphens, starting with a letter or digit.`,
  'All text must be nonblank single lines without control characters; character lengths use JavaScript string length (UTF-16 code units).',
  `Each groundedIn.<index>.sha256: exactly ${MAP_LIMITS.sha256} lowercase hexadecimal characters (0-9, a-f), taken from the digest listing.`,
].join(' ');
export const MAP_ACTION = 'canopy_map';
export const MAP_UNCHANGED_ACTION = 'canopy_map_unchanged';
export const MAP_TASK = 'canopy-map';

export interface SourceGrounding { path: string; sha256: string }
export interface MapAnnotation { path: string; annotation: string; groundedIn: SourceGrounding[] }
export interface MapDomain { id: string; title: string; files: MapAnnotation[] }
export interface MapArtifact { directories: MapAnnotation[]; domains: MapDomain[] }
export interface MapSourcePin { inputHash: string; priorRevision: string | null }

export class MapArtifactError extends Error {}

export const mapReceived = (value: unknown): string => {
  if (typeof value === 'string') return `string length ${value.length}`;
  if (Array.isArray(value)) return `array length ${value.length}`;
  return value === null ? 'null' : typeof value;
};
function refuse(path: string, bound: string, value: unknown): never {
  throw new MapArtifactError(`${path}: expected ${bound}; received ${mapReceived(value)}.`);
}
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(path, 'one object', value);
  return value as Record<string, unknown>;
};
const line = (value: unknown, max: number, path: string): string => {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) refuse(path, `a nonblank single line of 1..${max} characters without control characters`, value);
  return value;
};
const list = <T>(value: unknown, max: number, path: string, parse: (item: unknown, path: string) => T): T[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) refuse(path, `an array of 1..${max} entries`, value);
  return value.map((item, index) => parse(item, `${path}.${index}`));
};

export function mapSourcePath(value: unknown, field = 'path'): string {
  const path = line(value, MAP_LIMITS.path, field);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    refuse(field, `a relative source path of 1..${MAP_LIMITS.path} characters with no leading slash, backslash, empty, dot, parent or .git segments`, value);
  }
  return path;
}

const digest = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length !== MAP_LIMITS.sha256 || !/^[a-f0-9]+$/.test(value)) {
    refuse(path, `exactly ${MAP_LIMITS.sha256} lowercase hex characters (0-9, a-f) for a SHA-256 digest`, value);
  }
  return value;
};
const grounding = (value: unknown, path: string): SourceGrounding => {
  const item = record(value, path);
  return { path: mapSourcePath(item.path, `${path}.path`), sha256: digest(item.sha256, `${path}.sha256`) };
};

export function parseMapSourcePin(value: unknown): MapSourcePin {
  const item = record(value, 'source');
  const inputHash = digest(item.inputHash, 'source.inputHash');
  const priorRevision = item.priorRevision;
  if (!(priorRevision === null || (typeof priorRevision === 'string' && priorRevision.length >= 1 && priorRevision.length <= MAP_LIMITS.priorRevision && /^[A-Za-z0-9-]+$/.test(priorRevision)))) {
    refuse('source.priorRevision', `null or a prior map revision of 1..${MAP_LIMITS.priorRevision} letters, digits or hyphens`, priorRevision);
  }
  return { inputHash, priorRevision };
}

const annotation = (value: unknown, path: string): MapAnnotation => {
  const item = record(value, path);
  return { path: mapSourcePath(item.path, `${path}.path`), annotation: line(item.annotation, MAP_LIMITS.annotation, `${path}.annotation`), groundedIn: list(item.groundedIn, MAP_LIMITS.groundedIn, `${path}.groundedIn`, grounding) };
};

/** Validate the stored shape independently of the model and renderer. */
export function parseMapArtifact(value: unknown): MapArtifact {
  const item = record(value, 'artifact');
  const artifact = {
    directories: list(item.directories, MAP_LIMITS.directories, 'artifact.directories', annotation),
    domains: list(item.domains, MAP_LIMITS.domains, 'artifact.domains', (value, path): MapDomain => {
      const domain = record(value, path);
      const id = line(domain.id, MAP_LIMITS.id, `${path}.id`);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) refuse(`${path}.id`, `1..${MAP_LIMITS.id} lowercase letters, digits or hyphens, starting with a letter or digit`, domain.id);
      return { id, title: line(domain.title, MAP_LIMITS.title, `${path}.title`), files: list(domain.files, MAP_LIMITS.files, `${path}.files`, annotation) };
    }),
  };
  const unique = (values: string[], path: string, field: string, max: number) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) throw new MapArtifactError(`${path}.${index}.${field}: expected unique values in 1..${max} entries; received ${values.length} entries with ${new Set(values).size} unique values.`);
      seen.add(value);
    }
  };
  unique(artifact.domains.map((domain) => domain.id), 'artifact.domains', 'id', MAP_LIMITS.domains);
  unique(artifact.directories.map((directory) => directory.path), 'artifact.directories', 'path', MAP_LIMITS.directories);
  const bytes = new TextEncoder().encode(JSON.stringify(artifact)).byteLength;
  if (bytes > MAX_MAP_BYTES) throw new MapArtifactError(`artifact: expected at most ${MAX_MAP_BYTES} UTF-8 bytes; received ${bytes} bytes.`);
  return artifact;
}

/** Every annotation's evidence, without inventing an annotation for a directory name. */
export function mapGrounding(artifact: MapArtifact): SourceGrounding[] {
  return [...artifact.directories, ...artifact.domains.flatMap((domain) => domain.files)].flatMap((item) => item.groundedIn);
}

/** Source files and the directories that contain them. */
export function admittedSourcePaths(files: readonly SourceGrounding[]): ReadonlySet<string> {
  const paths = new Set(['']);
  for (const file of files) {
    const segments = file.path.split('/');
    for (let length = 1; length <= segments.length; length++) paths.add(segments.slice(0, length).join('/'));
  }
  return paths;
}

/** New annotations require source reads; unchanged prior annotations require matching current hashes. */
export function assertMapEvidence(artifact: MapArtifact, files: readonly SourceGrounding[], readPaths: ReadonlySet<string>, prior?: MapArtifact): void {
  const hashes = new Map(files.map((file) => [file.path, file.sha256]));
  const annotations = (map: MapArtifact) => [...map.directories, ...map.domains.flatMap((domain) => domain.files)];
  const existing = new Set(prior ? annotations(prior).map((item) => JSON.stringify(item)) : []);
  const reused = (item: MapAnnotation) => existing.has(JSON.stringify(item));
  const located = artifact.domains.flatMap((domain, d) => domain.files.map((item, f) => ({ item, path: `artifact.domains.${d}.files.${f}` })));
  for (const { item, path } of located) {
    if (!hashes.has(item.path) || (!reused(item) && !readPaths.has(item.path))) refuse(`${path}.path`, 'one admitted source file read before describing it', item.path);
    if (!item.groundedIn.some((file) => file.path === item.path)) throw new MapArtifactError(`${path}.groundedIn: expected at least 1 reference to the annotated file; received 0 matching references.`);
  }
  const paths = admittedSourcePaths(files);
  const directories = artifact.directories.map((item, d) => ({ item, path: `artifact.directories.${d}` }));
  for (const { item, path } of directories) {
    if (!paths.has(item.path)) refuse(`${path}.path`, 'one directory or file containing admitted source', item.path);
  }
  for (const { item, path } of [...directories, ...located]) {
    for (const [index, file] of item.groundedIn.entries()) {
      if (hashes.get(file.path) !== file.sha256 || (!reused(item) && !readPaths.has(file.path))) throw new MapArtifactError(`${path}.groundedIn.${index}: expected 1 grounding matching verified source; received 0 verified matches.`);
    }
  }
}

/** Incremental passes preserve domains whose grounding did not change and gained no changed source. */
export function assertIncrementalMap(before: MapArtifact, after: MapArtifact, changedPaths: ReadonlySet<string>): void {
  const preserve = (prior: unknown, next: unknown, evidence: SourceGrounding[], label: string) => {
    if (!evidence.some((file) => changedPaths.has(file.path)) && JSON.stringify(prior) !== JSON.stringify(next)) {
      throw new MapArtifactError(`Preserve the unchanged ${label}`);
    }
  };
  for (const [index, domain] of before.domains.entries()) {
    const next = after.domains.find((item) => item.id === domain.id);
    const evidence = [...domain.files, ...(next?.files ?? [])].flatMap((item) => item.groundedIn);
    preserve(domain, next, evidence, `artifact.domains.${index}: expected 0 changes to an unchanged domain; received a changed or missing object.`);
  }
  for (const [index, directory] of before.directories.entries()) {
    const next = after.directories.find((item) => item.path === directory.path);
    preserve(directory, next, [...directory.groundedIn, ...(next?.groundedIn ?? [])], `artifact.directories.${index}: expected 0 changes to an unchanged directory; received a changed or missing object.`);
  }
}

const prose = (text: string) => text.replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&');
const code = (text: string) => {
  const ticks = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((match) => match.length)) + 1);
  return `${ticks} ${text} ${ticks}`;
};

/** One markdown representation for the dashboard, MCP and exported map. */
export function renderMap(artifact: MapArtifact, repository: RepositoryPin): string {
  const bullet = (item: MapAnnotation) => `- ${code(item.path)} — ${prose(item.annotation)}`;
  const provenance = JSON.stringify({ repository, directories: artifact.directories.map(({ path, groundedIn }) => ({ path, groundedIn })),
    domains: artifact.domains.map(({ id, files }) => ({ id, annotations: files.map(({ path, groundedIn }) => ({ path, groundedIn })) })) }).replace(/>/g, '\\u003e');
  return ['## Directory skeleton', '', ...artifact.directories.map(bullet), '', '## Key files / golden paths', '',
    ...artifact.domains.flatMap((domain) => [`### ${prose(domain.title)}`, '', ...domain.files.map(bullet), '']),
    '<!-- Map Provenance', provenance, '-->', ''].join('\n');
}

export const CANOPY_DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // Source control + filesystem noise
  '.git',
  '.DS_Store',
  // Dependency trees
  'node_modules',
  // Python: bytecode, venvs, test/lint caches
  '__pycache__',
  '.venv', 'venv', 'env', 'ENV',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox',
  // Build/output dirs (JS, Rust, Java)
  'dist', 'build', 'target', '.gradle', '.cache',
  // Framework caches
  '.next', '.nuxt', '.turbo', '.svelte-kit',
  // Dependency lockfiles
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];


export interface MapSettings { defaultPatterns: string[]; userPatterns: string[] }
export interface StoredMap { revision: string; artifact: MapArtifact; content: string; inputHash: string; repository: RepositoryPin; sourceRunId: string; generatedAt: number }
