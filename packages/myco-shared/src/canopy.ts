import type { RepositoryPin } from './repository.js';

export const MAX_MAP_BYTES = 128 * 1024;
export const MAP_ACTION = 'canopy_map';
export const MAP_UNCHANGED_ACTION = 'canopy_map_unchanged';
export const MAP_TASK = 'canopy-map';

export interface SourceGrounding { path: string; sha256: string }
export interface MapAnnotation { path: string; annotation: string; groundedIn: SourceGrounding[] }
export interface MapDomain { id: string; title: string; files: MapAnnotation[] }
export interface MapArtifact { directories: MapAnnotation[]; domains: MapDomain[] }
export interface MapSourcePin { inputHash: string; priorRevision: string | null }

export class MapArtifactError extends Error {}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MapArtifactError('Map value must be an object.');
  return value as Record<string, unknown>;
};
const line = (value: unknown, max: number): string => {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new MapArtifactError('Map text must be a bounded nonempty line.');
  return value;
};
const list = <T>(value: unknown, max: number, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new MapArtifactError('Map list is empty or exceeds its limit.');
  return value.map(parse);
};

export function mapSourcePath(value: unknown): string {
  const path = line(value, 512);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new MapArtifactError('Map paths must name relative source files or directories.');
  }
  return path;
}

const grounding = (value: unknown): SourceGrounding => {
  const item = record(value);
  const sha256 = line(item.sha256, 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MapArtifactError('Map grounding requires a SHA-256 digest.');
  return { path: mapSourcePath(item.path), sha256 };
};

export function parseMapSourcePin(value: unknown): MapSourcePin {
  const item = record(value);
  const inputHash = line(item.inputHash, 64);
  if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new MapArtifactError('Map source requires a SHA-256 digest.');
  const priorRevision = item.priorRevision;
  if (!(priorRevision === null || (typeof priorRevision === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(priorRevision)))) {
    throw new MapArtifactError('Map source requires the prior map revision or null.');
  }
  return { inputHash, priorRevision };
}

const annotation = (value: unknown): MapAnnotation => {
  const item = record(value);
  return { path: mapSourcePath(item.path), annotation: line(item.annotation, 500), groundedIn: list(item.groundedIn, 16, grounding) };
};

/** Validate the stored shape independently of the model and renderer. */
export function parseMapArtifact(value: unknown): MapArtifact {
  const item = record(value);
  const artifact = {
    directories: list(item.directories, 32, annotation),
    domains: list(item.domains, 8, (value): MapDomain => {
      const domain = record(value);
      const id = line(domain.id, 64);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new MapArtifactError('Map domains require stable lowercase identifiers.');
      return { id, title: line(domain.title, 100), files: list(domain.files, 8, annotation) };
    }),
  };
  if (new Set(artifact.domains.map((domain) => domain.id)).size !== artifact.domains.length) throw new MapArtifactError('Map domain identifiers must be unique.');
  if (new Set(artifact.directories.map((directory) => directory.path)).size !== artifact.directories.length) throw new MapArtifactError('Map skeleton paths must be unique.');
  if (new TextEncoder().encode(JSON.stringify(artifact)).byteLength > MAX_MAP_BYTES) throw new MapArtifactError('Map artifact exceeds its size limit.');
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
  for (const item of artifact.domains.flatMap((domain) => domain.files)) {
    if (!hashes.has(item.path) || (!reused(item) && !readPaths.has(item.path))) throw new MapArtifactError(`Read the annotated source before describing it: ${item.path}`);
    if (!item.groundedIn.some((file) => file.path === item.path)) throw new MapArtifactError(`Include the annotated file in its grounding: ${item.path}`);
  }
  const paths = admittedSourcePaths(files);
  for (const item of artifact.directories) {
    if (!paths.has(item.path)) throw new MapArtifactError(`Map directory has no admitted source: ${item.path}`);
  }
  for (const item of annotations(artifact)) {
    for (const file of item.groundedIn) {
      if (hashes.get(file.path) !== file.sha256 || (!reused(item) && !readPaths.has(file.path))) throw new MapArtifactError(`Map grounding does not match verified source: ${file.path}`);
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
  for (const domain of before.domains) {
    const next = after.domains.find((item) => item.id === domain.id);
    const evidence = [...domain.files, ...(next?.files ?? [])].flatMap((item) => item.groundedIn);
    preserve(domain, next, evidence, `domain: ${domain.title}`);
  }
  for (const directory of before.directories) {
    const next = after.directories.find((item) => item.path === directory.path);
    preserve(directory, next, [...directory.groundedIn, ...(next?.groundedIn ?? [])], `directory: ${directory.path}`);
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
