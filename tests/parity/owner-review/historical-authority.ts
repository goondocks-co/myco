import { lit, type ParityTarget } from '../harness.ts';

/**
 * Raw history no current client can write: capture whose credential no longer exists, rows older builds left with a
 * missing or another runtime's token, and a provenance backfill that has not run yet. Every write a parity scenario
 * cannot make through a route lives here, and nowhere else.
 */
export interface MissingProvenance {
  projects: readonly string[];
  session: string;
  oldest: number;
  newest: number;
  /** Blobs a member uploaded that history must hold as unattributed. */
  unknown: ReadonlyArray<{ projectId: string; key: string }>;
  /** The member and machine whose transcripts a claim must keep apart. */
  owner: { tokenId: string; machine: string };
  other: { tokenId: string; machine: string };
  /** The blob a partial transcript's segment names. */
  segmentBlob: string;
}

/** The credential id history names but no Deployment holds. */
export const MISSING_CREDENTIAL = 'credential_missing_claim_history';

async function write(target: ParityTarget, statements: string[]): Promise<void> {
  if (target.name === 'cloudflare') await target.sql(statements.join(';\n') + ';');
  else for (const statement of statements) await target.sql(statement);
}

/** Seeds missing-provenance history and rewinds the provenance backfill so the next wakes classify it. */
export async function seedMissingProvenance(target: ParityTarget, seed: MissingProvenance): Promise<void> {
  const { projects, session, oldest, newest, owner, other } = seed;
  const missing = MISSING_CREDENTIAL;
  await write(target, [
    ...projects.map((projectId) => `INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES (${lit(projectId)},${lit(session)},'machine_missing_claim_history',${lit(missing)},${oldest},${newest})`),
    ...seed.unknown.flatMap((blob) => [
      `UPDATE blobs SET token_id = ${lit(missing)}, received_at = ${oldest} WHERE project_id = ${lit(blob.projectId)} AND key = ${lit(blob.key)}`,
      `DELETE FROM raw_resources WHERE project_id = ${lit(blob.projectId)} AND kind = 'blob' AND resource_id = ${lit(blob.key)}`,
    ]),
    ...projects.map((projectId) => `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
      VALUES (${lit(projectId)},'unknown_transcript',${lit(session)},'machine_missing_claim_history',0,0,${oldest},${newest},${lit(missing)})`),
    `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
      VALUES (${lit(projects[0]!)},'known_transcript',${lit(session)},${lit(other.machine)},0,0,${oldest},${newest},${lit(other.tokenId)}),
      (${lit(projects[0]!)},'ambiguous_transcript',${lit(session)},${lit(other.machine)},0,0,${oldest},${newest},${lit(owner.tokenId)})`,
    ...[{ id: 'own_partial', machine: owner.machine }, { id: 'foreign_partial', machine: other.machine }].flatMap((transcript) => [
      `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
        VALUES (${lit(projects[0]!)},${lit(transcript.id)},${lit(session)},${lit(transcript.machine)},1,1,${newest},${newest},'missing_header_claim')`,
      `INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
        VALUES (${lit(projects[0]!)},${lit(transcript.id)},0,1,${lit(seed.segmentBlob)},${lit(`${transcript.id}_segment`)},${newest},${newest},${lit(missing)})`,
    ]),
    ...[
      { projectId: projects[0]!, id: 'unknown_event_old', tokenId: missing, at: oldest },
      { projectId: projects[0]!, id: 'unknown_event_new', tokenId: missing, at: newest },
      { projectId: projects[1]!, id: 'unknown_event_b', tokenId: missing, at: newest },
      { projectId: projects[0]!, id: 'known_event', tokenId: other.tokenId, at: newest },
    ].map((event) => unknownEvent(event.projectId, event.id, session, event.tokenId, event.at)),
    `UPDATE raw_provenance_backfill SET source = 0,cursor_project = '',cursor_id = '',complete = 0,updated_at = 0 WHERE id = 1`,
  ]);
}

/** One more unattributed event in history, arriving after a claim was made. */
export async function seedUnknownEvent(target: ParityTarget, projectId: string, session: string, at: number): Promise<void> {
  await target.sql(unknownEvent(projectId, 'unknown_after_claim', session, MISSING_CREDENTIAL, at));
}

const unknownEvent = (projectId: string, id: string, session: string, tokenId: string, at: number): string =>
  `INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    VALUES (${lit(projectId)},${lit(id)},${lit(session)},${lit(tokenId)},'notification','cli',${lit(JSON.stringify({ message: id }))},'claim fixture',${at},${at})`;
