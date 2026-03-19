import { formatSporeBody } from '../obsidian/formatter.js';
import { sessionNoteId } from './session-id.js';
import { indexNote } from '../index/rebuild.js';
import type { Observation } from '../daemon/processor.js';
import type { VaultWriter } from './writer.js';
import type { MycoIndex } from '../index/sqlite.js';

export interface WrittenNote {
  id: string;
  path: string;
  observation: Observation;
}

export function writeObservationNotes(
  observations: Observation[],
  sessionId: string,
  writer: VaultWriter,
  index: MycoIndex,
  vaultDir: string,
): WrittenNote[] {
  const results: WrittenNote[] = [];

  for (const obs of observations) {
    const obsId = `${obs.type}-${sessionId.slice(-6)}-${Date.now()}`;
    const body = formatSporeBody({
      title: obs.title,
      observationType: obs.type,
      content: obs.content,
      sessionId,
      root_cause: obs.root_cause,
      fix: obs.fix,
      rationale: obs.rationale,
      alternatives_rejected: obs.alternatives_rejected,
      gained: obs.gained,
      sacrificed: obs.sacrificed,
      tags: obs.tags,
    });
    const relativePath = writer.writeSpore({
      id: obsId,
      observation_type: obs.type,
      session: sessionNoteId(sessionId),
      tags: obs.tags,
      content: body,
    });
    indexNote(index, vaultDir, relativePath);
    results.push({ id: obsId, path: relativePath, observation: obs });
  }

  return results;
}
