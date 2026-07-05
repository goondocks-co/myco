import type { SporeRow } from '@myco/db/queries/spores.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import { deriveConceptId, conceptPathForId } from '../paths.js';
import { escapeLinkLabel, relativeConceptHref } from '../serialize.js';
import { mycoProjectRef } from '../privacy.js';
import {
  OKF_PROJECTION_VERSION,
  type OkfBundleMode,
  type OkfConcept,
  type OkfFrontmatter,
  type OkfMaintainWarning,
} from '../types.js';

/**
 * Deterministic projection of vault spores into OKF concepts at
 * `spores/<plural-type>/<id>`. Takes already-fetched rows — no DB access.
 *
 * Relationship and citation sections are rendered directly into the body
 * (per the spec's "Spore body format"); `links` stays empty because
 * `renderConcept` would otherwise render a duplicate "## Related" section.
 */

const PLURAL_TYPES: Record<string, string> = {
  decision: 'decisions',
  gotcha: 'gotchas',
  bug_fix: 'bug-fixes',
  discovery: 'discoveries',
  trade_off: 'trade-offs',
  'cross-cutting': 'cross-cutting',
  wisdom: 'wisdom',
};

/** Deterministic plural directory name for an observation type. */
export function pluralTypeDir(observationType: string): string {
  const known = PLURAL_TYPES[observationType];
  if (known) return known;
  const slug = observationType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'unknown'}s`;
}

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstSentence(content: string): string {
  const stripped = content
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^(.*?[.!?])(\s|$)/.exec(stripped);
  return (match ? match[1] : stripped).trim();
}

function deriveTitle(spore: SporeRow): string {
  for (const line of spore.content.split('\n')) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (heading) return truncate(heading[1].trim(), 80);
  }
  const sentence = firstSentence(spore.content);
  return sentence !== '' ? truncate(sentence, 80) : `Myco spore ${spore.id}`;
}

function deriveDescription(spore: SporeRow): string {
  const sentence = firstSentence(spore.content);
  return sentence !== '' ? truncate(sentence, 200) : `Myco ${spore.observation_type} spore.`;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export interface SporeProjectionInput {
  spores: SporeRow[];
  resolutionEdges: Array<{ spore_id: string; new_spore_id: string | null; action: string }>;
  /** spore id -> release state, only for rows that exist — never fabricated. */
  releaseStates: Map<string, string>;
  projectId: string;
  mode: OkfBundleMode;
  /** Ids (spore ids) present in this export, for excluded-target link handling. */
  includedIds: Set<string>;
  /** spore.file_path -> included canopy concept id (link reason 'file_path'). */
  canopyConceptIdByRepoPath: Map<string, string>;
}

export function projectSpores(input: SporeProjectionInput): {
  concepts: OkfConcept[];
  warnings: OkfMaintainWarning[];
} {
  const warnings: OkfMaintainWarning[] = [];
  const concepts: OkfConcept[] = [];

  const conceptIdBySporeId = new Map<string, string>();
  for (const spore of input.spores) {
    conceptIdBySporeId.set(spore.id, deriveConceptId(['spores', pluralTypeDir(spore.observation_type), spore.id]));
  }

  for (const spore of input.spores) {
    const id = conceptIdBySporeId.get(spore.id)!;
    const path = conceptPathForId(id);
    const timestamp = epochToIso(spore.updated_at ?? spore.created_at);

    const tags: string[] = [];
    for (const tag of ['myco', 'spore', spore.observation_type, ...(spore.tags ? spore.tags.split(', ') : [])]) {
      const trimmed = tag.trim();
      if (trimmed !== '' && !tags.includes(trimmed)) tags.push(trimmed);
    }

    const frontmatter: OkfFrontmatter = {
      type: 'Myco Spore',
      title: deriveTitle(spore),
      description: deriveDescription(spore),
      resource: `myco://spores/${spore.id}`,
      tags,
      timestamp,
      observation_type: spore.observation_type,
      status: spore.status,
      myco_project_ref: mycoProjectRef(input.projectId),
      source_hash: spore.content_hash ?? sha256Hex(spore.content),
      source_updated_at: timestamp,
      projection_version: OKF_PROJECTION_VERSION,
    };
    const releaseState = input.releaseStates.get(spore.id);
    if (releaseState !== undefined) frontmatter.release_state = releaseState;
    if (input.mode === 'local') {
      frontmatter.myco_machine_id = spore.machine_id;
      if (spore.session_id != null) frontmatter.myco_session_id = spore.session_id;
    }

    // --- Metadata table ---
    const metadataRows: Array<[string, string]> = [
      ['Observation type', spore.observation_type],
      ['Status', spore.status],
      ['Importance', String(spore.importance)],
      ['Created', epochToIso(spore.created_at)],
    ];
    if (spore.updated_at != null) metadataRows.push(['Updated', epochToIso(spore.updated_at)]);
    if (spore.file_path != null) metadataRows.push(['File path', spore.file_path]);

    // --- Relationships (only rows that exist) ---
    const relationshipLines: string[] = [];
    const edges = input.resolutionEdges
      .filter((edge) => edge.spore_id === spore.id || edge.new_spore_id === spore.id)
      .slice()
      .sort((a, b) => {
        const ka = `${a.action}:${a.spore_id}:${a.new_spore_id ?? ''}`;
        const kb = `${b.action}:${b.spore_id}:${b.new_spore_id ?? ''}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    for (const edge of edges) {
      const outgoing = edge.spore_id === spore.id;
      const counterpartId = outgoing ? edge.new_spore_id : edge.spore_id;
      if (counterpartId == null) continue; // obsolete edges have no counterpart; status covers them
      const verb =
        edge.action === 'consolidate'
          ? outgoing
            ? 'Consolidated into'
            : 'Consolidates'
          : outgoing
            ? 'Superseded by'
            : 'Supersedes';
      if (input.includedIds.has(counterpartId)) {
        const counterpartConceptId = conceptIdBySporeId.get(counterpartId);
        if (counterpartConceptId) {
          relationshipLines.push(
            `- ${verb} [${escapeLinkLabel(counterpartId)}](${relativeConceptHref(path, counterpartConceptId)})`,
          );
          continue;
        }
      }
      relationshipLines.push(`- ${verb} ${counterpartId}. Replacement spore ${counterpartId} was not included in this export.`);
      warnings.push({
        code: 'relationship_target_excluded',
        message: `Spore ${spore.id}: relationship target ${counterpartId} is not included in this export.`,
        path,
      });
    }
    if (spore.file_path != null) {
      const canopyConceptId = input.canopyConceptIdByRepoPath.get(spore.file_path);
      if (canopyConceptId) {
        relationshipLines.push(
          `- Discussed file: [${escapeLinkLabel(spore.file_path)}](${relativeConceptHref(path, canopyConceptId)})`,
        );
      } else {
        relationshipLines.push(`- Discussed file: ${spore.file_path}`);
      }
    }

    const bodyParts: string[] = [spore.content.trim()];
    bodyParts.push(
      '# Myco Metadata',
      ['| Field | Value |', '| --- | --- |', ...metadataRows.map(([k, v]) => `| ${k} | ${tableCell(v)} |`)].join('\n'),
    );
    if (relationshipLines.length > 0) {
      bodyParts.push('# Relationships', relationshipLines.join('\n'));
    }
    bodyParts.push('# Citations', `- Source: myco://spores/${spore.id}`);

    concepts.push({
      id,
      path,
      frontmatter,
      body: bodyParts.join('\n\n'),
      source: {
        sourceKind: 'spore',
        id: spore.id,
        projectId: input.mode === 'local' ? input.projectId : null,
      },
      links: [],
    });
  }

  return { concepts, warnings };
}
