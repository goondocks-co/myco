/**
 * `myco_run_map`: a map run's prior map and its one write.
 *
 * `get` answers the map the Project holds, the commit this run's checkout is
 * pinned to, and whether that map already reflects this run's input — the
 * Deployment's answer to whether the pass owes anything. `write` stores the
 * artifact against the revision and source the run pinned with its commit
 * (`writeCanopyMap`), so a map written here is the map the close rule reads
 * back (`canopyMapWrittenBy`).
 *
 * Neither op takes a revision or a commit: both are the run's own pins, read
 * off its row, so there is nothing for a caller to get wrong.
 */
import { MapArtifactError } from '@goondocks/myco-shared/canopy';
import { mapInputUnchanged, readMapSettings, writeCanopyMap } from '../../core/canopy.js';
import { getRun, mapSourcePinOfRun, recordRunWrite, repositoryPinOfRun } from '../../core/runs.js';
import { MAP_WRITE_TOOL } from '../../core/tool-catalogue.js';
import { readCanopyMap } from '../../read/canopy.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

/** The refusal for a run whose checkout has not pinned its input. */
export const MAP_SOURCE_UNPINNED = 'this run holds no pinned source; its checkout has not been prepared';

export async function handleRunMap(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const principal = runOf(ctx, MAP_WRITE_TOOL);
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const run = await getRun(db, scope, principal.runId);
  if (run === null) return failure('this run is not one this Project holds');
  const source = mapSourcePinOfRun(run);
  const repository = repositoryPinOfRun(run);
  if (source === null || repository === null) return failure(MAP_SOURCE_UNPINNED);

  if (input.op === 'get') {
    const current = await readCanopyMap(db, scope);
    const settings = await readMapSettings(db);
    return {
      commit: repository.commit,
      unchanged: mapInputUnchanged(current, source),
      exclude: [...settings.defaultPatterns, ...settings.userPatterns],
      map: current === null ? null : {
        revision: current.revision,
        commit: current.repository.commit,
        generated_at: current.generatedAt,
        artifact: current.artifact,
      },
    };
  }

  let artifact: unknown = input.artifact;
  if (typeof artifact === 'string') {
    try { artifact = JSON.parse(artifact); } catch { return failure('artifact is not valid JSON'); }
  }
  try {
    const written = await writeCanopyMap(db, scope, run, artifact, ctx.now);
    if (!written) {
      const current = await readCanopyMap(db, scope);
      return failure(current?.sourceRunId === run.id
        ? 'this run already stored its map; a run writes one map'
        : 'the map was not stored: a newer map or a changed repository connection replaced this run\'s input');
    }
  } catch (error) {
    if (error instanceof MapArtifactError) return failure(error.message);
    throw error;
  }
  await recordRunWrite(db, scope, { runId: run.id, toolName: MAP_WRITE_TOOL, op: 'write', recordedAt: ctx.now });
  const stored = await readCanopyMap(db, scope);
  return { written: true, revision: stored?.revision ?? null, commit: repository.commit };
}
