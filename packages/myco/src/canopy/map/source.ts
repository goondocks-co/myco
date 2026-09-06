import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLayeredExcludeMatcher, type ExcludeMatcherConfig } from '@myco/canopy/exclude.js';
import { walkProject } from '@myco/canopy/scanner/walk.js';
import { admittedSourcePaths, type SourceGrounding } from '@goondocks/myco-shared/canopy';

const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const RULES_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/** An ephemeral inventory of admitted committed source; no purpose descriptions. */
export interface MapSource {
  files: SourceGrounding[];
  rules: SourceGrounding[];
  inputHash: string;
  skipped: { binary: number; tooLarge: number };
}

/** Hash the complete admitted source set; an incomplete walk cannot become current map input. */
export async function gatherMapSource(config: ExcludeMatcherConfig, signal: AbortSignal): Promise<MapSource> {
  const isExcluded = createLayeredExcludeMatcher(config);
  const files: SourceGrounding[] = [];
  const rules: SourceGrounding[] = [];
  const skipped = { binary: 0, tooLarge: 0 };
  for (const path of walkProject({
    projectRoot: config.projectRoot, isExcluded, strict: true,
    onLimitHit: (kind, limit) => { throw new Error(`Repository map traversal exceeded ${kind} (${limit}).`); },
  })) {
    signal.throwIfAborted();
    const absolute = join(config.projectRoot, path);
    if ((await stat(absolute)).size > MAX_SOURCE_FILE_BYTES) { skipped.tooLarge++; continue; }
    const body = await readFile(absolute);
    if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) { skipped.binary++; continue; }
    const file = { path, sha256: createHash('sha256').update(body).digest('hex') };
    files.push(file);
    if (RULES_FILES.has(path.split('/').at(-1)!)) rules.push(file);
  }
  const byPath = (a: SourceGrounding, b: SourceGrounding) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  files.sort(byPath);
  rules.sort(byPath);
  const inputHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { files, rules, inputHash, skipped };
}

/** Changed and removed grounding paths, plus additions needing domain discovery. */
export function changedSourcePaths(before: readonly SourceGrounding[], after: readonly SourceGrounding[]): string[] {
  const old = new Map(before.map((file) => [file.path, file.sha256]));
  const current = new Map(after.map((file) => [file.path, file.sha256]));
  return [...new Set([...old.keys(), ...current.keys()])].filter((path) => old.get(path) !== current.get(path)).sort();
}

/** Admit source files and only the directories that contain them. */
export function mapSourceAdmission(source: MapSource): (path: string) => boolean {
  const paths = admittedSourcePaths(source.files);
  return (path) => paths.has(path);
}
