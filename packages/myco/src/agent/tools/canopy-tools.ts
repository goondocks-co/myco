/**
 * Canopy describe vault tools.
 *
 * 2 tools used by the canopy-describe harness task:
 *   - canopy_describe_next: returns up to N pending canopy_entries rows
 *     (llm_description NULL or stale relative to mechanical_updated_at).
 *   - canopy_describe_write: applies the post-process gate and persists
 *     the description on accept.
 *
 * Harness-internal: not exposed via the public MCP server (no entry in
 * mcp/tool-definitions.ts), no Cortex guidance, no priority boost.
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { epochSeconds } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { postProcess } from '@myco/canopy/describe/post-process.js';
import { isCanopySensitivePath } from '@myco/canopy/sensitive-paths.js';
import { textResult, type VaultToolDeps } from './types.js';

// Number of leading file lines included in the per-row payload. Local
// models do better with the head than with sampled middle slices for
// one-sentence summaries; a tighter window also keeps the batch payload
// from blowing out the model's context.
const FIRST_LINES = 60;

// 10 is the largest value that has been observed to drain reliably on
// 26B-class local models — see canopy-describe.yaml for the per-turn
// tool-emission ceiling that bounds this. The MAX is generous so a
// frontier-routed run can pull more in one shot.
const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 100;

// Cap on the post-processed description length, mirroring the prior
// cortex.canopy.llm.max_description_chars default. Centralised here so
// the harness reads it without round-tripping through MycoConfig.
const MAX_DESCRIPTION_CHARS = 180;

const SELECT_PENDING_SQL = `
  SELECT *
  FROM canopy_entries
  WHERE project_id = ?
    AND (
      llm_updated_at IS NULL
      OR llm_updated_at < mechanical_updated_at
    )
  ORDER BY (llm_updated_at IS NULL) DESC, mechanical_updated_at ASC
  LIMIT ?
`;

const UPDATE_DESCRIPTION_SQL = `
  UPDATE canopy_entries
  SET llm_description = ?,
      llm_updated_at  = ?,
      embedded        = 0
  WHERE project_id = ? AND path = ?
`;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function readFirstLines(absolutePath: string, limit: number): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(absolutePath, 'utf-8');
  } catch {
    return '';
  }
  return content.split(/\r?\n/).slice(0, limit).join('\n');
}

function resolveProjectId(deps: VaultToolDeps): string | null {
  if (deps.vaultDir) return resolveCanopyProjectId(deps.vaultDir);
  return deps.projectRoot ?? null;
}

function resolveProjectRoot(deps: VaultToolDeps): string | null {
  if (deps.projectRoot) return deps.projectRoot;
  if (deps.vaultDir) return path.dirname(deps.vaultDir);
  return null;
}

export function createCanopyTools(deps: VaultToolDeps) {
  const canopyDescribeNext = tool(
    'canopy_describe_next',
    'Return up to `limit` canopy_entries rows that need an llm_description (NULL or stale relative to mechanical_updated_at). Returns an empty entries array when the queue is drained — that is the signal to stop.',
    {
      limit: z.number().int().positive().optional().describe(`Max rows to return (default ${DEFAULT_BATCH_LIMIT}, ceiling ${MAX_BATCH_LIMIT}).`),
    },
    async (args) => {
      // No project_id override knob — projectId/projectRoot must move
      // together (path.dirname(vaultDir) is both), and exposing one without
      // the other lets a caller select rows from one project but read
      // first_lines under another. Daemon serves one vault → one project.
      const projectId = resolveProjectId(deps);
      if (!projectId) {
        return textResult({ error: 'canopy_describe_next: project_id unavailable (no vaultDir/projectRoot on tool deps)' });
      }
      const projectRoot = resolveProjectRoot(deps);
      if (!projectRoot) {
        return textResult({ error: 'canopy_describe_next: projectRoot unavailable (no vaultDir/projectRoot on tool deps)' });
      }

      const requested = args.limit ?? DEFAULT_BATCH_LIMIT;
      const limit = Math.min(Math.max(1, requested), MAX_BATCH_LIMIT);

      const rows = getDatabase().prepare(SELECT_PENDING_SQL).all(projectId, limit) as CanopyEntry[];
      const safeRows = rows.filter((row) => !isCanopySensitivePath(row.path));

      const entries = await Promise.all(safeRows.map(async (row) => ({
        path: row.path,
        language: row.language ?? 'unknown',
        exports: parseJsonArray(row.exports_json),
        imports: parseJsonArray(row.imports_json),
        top_comment: row.top_comment?.trim() || null,
        first_lines: await readFirstLines(path.join(projectRoot, row.path), FIRST_LINES),
      })));

      return textResult({ entries });
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } },
  );

  const canopyDescribeWrite = tool(
    'canopy_describe_write',
    'Persist a one-sentence description for a canopy_entries row. Runs the post-process gate (boilerplate strip, refusal/verbatim/empty rejection, length cap) and only writes on accept. Returns {ok:true} on success or {ok:false, reason} when the description is rejected.',
    {
      path: z.string().describe('Repo-relative path of the canopy_entries row.'),
      description: z.string().describe('Raw one-sentence description from the model.'),
    },
    async (args) => {
      const projectId = resolveProjectId(deps);
      if (!projectId) {
        return textResult({ ok: false, reason: 'project_id unavailable' });
      }

      const row = getDatabase()
        .prepare('SELECT exports_json FROM canopy_entries WHERE project_id = ? AND path = ?')
        .get(projectId, args.path) as { exports_json: string | null } | undefined;
      if (!row) {
        return textResult({ ok: false, reason: 'unknown_path' });
      }

      const exportsList = parseJsonArray(row.exports_json);
      const trimmed = args.description.trim();
      if (!trimmed) {
        return textResult({ ok: false, reason: 'empty' });
      }

      const cleaned = postProcess(trimmed, MAX_DESCRIPTION_CHARS, exportsList);
      if (!cleaned) {
        const reason = classifyRejection(trimmed, exportsList);
        return textResult({ ok: false, reason });
      }

      const now = epochSeconds();
      getDatabase().prepare(UPDATE_DESCRIPTION_SQL).run(cleaned, now, projectId, args.path);

      return textResult({ ok: true, description: cleaned });
    },
    { annotations: {} },
  );

  return [canopyDescribeNext, canopyDescribeWrite];
}

// Categorise post-process rejections so the agent can react (retry vs.
// move on). Mirrors the pattern set in postProcess() — kept in this
// module because the rejection labels are part of the tool contract,
// not the post-processor's contract.
function classifyRejection(raw: string, exportsList: readonly string[]): 'boilerplate' | 'refusal' | 'verbatim_export' | 'empty' | 'too_long' {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'empty';
  // Length first — a wall of text isn't a one-sentence summary even if it
  // happens to contain a refusal phrase. Keep this gate above the pattern
  // checks so the classifier reflects the most actionable reason.
  if (collapsed.length > MAX_DESCRIPTION_CHARS * 4) return 'too_long';
  if (/i cannot|i('| a)m sorry|as an ai/i.test(collapsed)) return 'refusal';
  for (const exportName of exportsList) {
    if (collapsed === exportName) return 'verbatim_export';
  }
  return 'boilerplate';
}
