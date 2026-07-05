import type { CanopyEntry } from '@myco/db/schema.js';
import type { CanopyMapRow } from '@myco/canopy/map/store.js';
import { deriveConceptId, conceptPathForId } from '../paths.js';
import { escapeLinkLabel, relativeConceptHref } from '../serialize.js';
import { mycoProjectRef, runRef } from '../privacy.js';
import {
  OKF_PROJECTION_VERSION,
  type OkfBundleMode,
  type OkfConcept,
  type OkfFrontmatter,
  type OkfMaintainWarning,
} from '../types.js';

/**
 * Deterministic projection of Canopy data into OKF concepts:
 * file entries at `canopy/files/<repo-path>` and the project map at
 * `canopy/map`. Takes already-fetched rows plus an exclusion adapter over the
 * SAME layered matcher Canopy itself uses — patterns are never re-implemented
 * here.
 */

const UNDESCRIBED_FALLBACK = 'No LLM description has been generated for this file.';

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Fence a block so embedded backtick runs cannot terminate it early. */
function fenced(text: string): string {
  const longestRun = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function parseJsonList(
  raw: string | null,
  path: string,
  field: string,
  warnings: OkfMaintainWarning[],
): string[] {
  if (raw == null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.map((entry) => String(entry));
  } catch {
    warnings.push({
      code: 'canopy_json_malformed',
      message: `Canopy entry ${path}: ${field} is not a valid JSON array; rendered as empty.`,
      path,
    });
    return [];
  }
}

function listSection(items: string[]): string {
  return items.length === 0 ? 'None recorded.' : items.map((item) => `- ${tableCell(item)}`).join('\n');
}

export interface CanopyProjectionInput {
  entries: CanopyEntry[];
  map: CanopyMapRow | null;
  projectId: string;
  /** Adapter over the layered matcher: (p) => matcher(p, false). */
  isExcluded: (relPath: string) => boolean;
  includeUndescribed: boolean;
  mode: OkfBundleMode;
}

export function projectCanopy(input: CanopyProjectionInput): {
  concepts: OkfConcept[];
  warnings: OkfMaintainWarning[];
} {
  const warnings: OkfMaintainWarning[] = [];
  const concepts: OkfConcept[] = [];
  let undescribedSkipped = 0;

  const includedByRepoPath = new Map<string, string>();

  for (const entry of input.entries) {
    if (input.isExcluded(entry.path)) continue;
    if (entry.llm_description == null && !input.includeUndescribed) {
      undescribedSkipped += 1;
      continue;
    }

    const id = deriveConceptId(['canopy', 'files', entry.path]);
    const path = conceptPathForId(id);
    includedByRepoPath.set(entry.path, id);
    const timestamp = epochToIso(entry.llm_updated_at ?? entry.mechanical_updated_at);

    const tags = ['myco', 'canopy', 'source-file'];
    if (entry.language != null && entry.language !== '' && !tags.includes(entry.language)) tags.push(entry.language);

    const frontmatter: OkfFrontmatter = {
      type: 'Source File',
      title: entry.path,
      description:
        entry.llm_description != null ? firstLine(entry.llm_description) : UNDESCRIBED_FALLBACK,
      resource: `repo://${entry.path}`,
      tags,
      timestamp,
      myco_path: entry.path,
      myco_project_ref: mycoProjectRef(input.projectId),
      source_hash: entry.content_hash,
      language: entry.language ?? undefined,
      token_estimate: entry.token_estimate,
      line_count: entry.line_count,
      projection_version: OKF_PROJECTION_VERSION,
    };

    const exports = parseJsonList(entry.exports_json, path, 'exports_json', warnings);
    const imports = parseJsonList(entry.imports_json, path, 'imports_json', warnings);

    const anatomyRows: Array<[string, string]> = [
      ['Size', `${entry.size_bytes} bytes`],
      ['Tokens (est.)', String(entry.token_estimate)],
      ['Lines', String(entry.line_count)],
      ['Language', entry.language ?? 'unknown'],
      ['Content hash', entry.content_hash],
    ];

    const body = [
      '# Summary',
      entry.llm_description?.trim() || UNDESCRIBED_FALLBACK,
      '# File Anatomy',
      ['| Field | Value |', '| --- | --- |', ...anatomyRows.map(([k, v]) => `| ${k} | ${tableCell(v)} |`)].join('\n'),
      '# Exports',
      listSection(exports),
      '# Imports',
      listSection(imports),
      '# Top Comment',
      entry.top_comment != null && entry.top_comment.trim() !== '' ? fenced(entry.top_comment) : 'None recorded.',
      '# Citations',
      `- repo://${entry.path}`,
    ].join('\n\n');

    concepts.push({
      id,
      path,
      frontmatter,
      body,
      source: {
        sourceKind: 'canopy_entry',
        id: entry.path,
        projectId: input.mode === 'local' ? input.projectId : null,
      },
      links: [],
    });
  }

  if (undescribedSkipped > 0) {
    warnings.push({
      code: 'canopy_entry_undescribed',
      message: `${undescribedSkipped} Canopy entr${undescribedSkipped === 1 ? 'y has' : 'ies have'} no LLM description and were skipped (pass includeUndescribedCanopy to include them).`,
    });
  }

  if (input.map == null) {
    warnings.push({ code: 'canopy_map_missing', message: 'No Canopy map exists for this project; canopy/map was not generated.' });
  } else {
    const id = 'canopy/map';
    const path = conceptPathForId(id);
    const frontmatter: OkfFrontmatter = {
      type: 'Project Map',
      title: 'Project Map',
      description: 'Rendered Canopy map of the project layout.',
      resource: 'myco://canopy/map',
      tags: ['myco', 'canopy', 'map'],
      timestamp: epochToIso(input.map.generated_at),
      myco_project_ref: mycoProjectRef(input.projectId),
      source_hash: input.map.inputs_hash,
      projection_version: OKF_PROJECTION_VERSION,
    };

    // Exact-path resolver only: link a repo path when its literal text appears
    // in the map content AND it projects to an included concept. Never fuzzy.
    const referencedLines: string[] = [];
    for (const repoPath of [...includedByRepoPath.keys()].sort()) {
      if (!input.map.content.includes(repoPath)) continue;
      referencedLines.push(
        `- [${escapeLinkLabel(repoPath)}](${relativeConceptHref(path, includedByRepoPath.get(repoPath)!)})`,
      );
    }

    const bodyParts = [input.map.content.trimEnd()];
    if (referencedLines.length > 0) {
      bodyParts.push('# Referenced Files', referencedLines.join('\n'));
    }

    concepts.push({
      id,
      path,
      frontmatter,
      body: bodyParts.join('\n\n'),
      source: {
        sourceKind: 'canopy_map',
        id,
        projectId: input.mode === 'local' ? input.projectId : null,
        generatedByRunId:
          input.mode === 'local' ? input.map.generated_by_run_id : runRef(input.map.generated_by_run_id) ?? null,
      },
      links: [],
    });
  }

  return { concepts, warnings };
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length <= 200 ? line : `${line.slice(0, 199).trimEnd()}…`;
}
