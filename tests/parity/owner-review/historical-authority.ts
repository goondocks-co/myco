import { sha256Hex } from '@myco-server-worker/hash.js';
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

/** A raw-privacy actor: a member's account, machine and credential. */
export interface RawViewer { id: string; sub: string; machine: string; token: string; tokenId: string; headers: Record<string, string> }

/** How a raw-privacy run enrolls its three people and later stops the uploader's credential and membership. */
export interface RawActors {
  enroll(): Promise<RawViewer[]>;
  stopCredential(viewer: RawViewer): Promise<void>;
  stopMember(viewer: RawViewer): Promise<void>;
}

/**
 * The raw-privacy people as rows, for a store served without a selected owner, where no invitation can make an admin.
 * The parity scenario enrolls them through routes instead.
 */
export function rawFixtureActors(target: ParityTarget, sessionCookie: (sub: string, login: string) => Promise<string>): RawActors {
  const now = Date.now();
  return {
    async enroll() {
      const viewers: RawViewer[] = [];
      for (const [label, role, sub] of [['uploader', 'member', '991001'], ['other', 'member', '991002'], ['admin', 'admin', '991003']] as const) {
        const id = `mem_raw_${label}`;
        const machine = `machine_raw_${label}`;
        const token = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
        const tokenId = `mt_raw_${label}`;
        await target.sql(`INSERT INTO members (id, label, created_at, role, github_id) VALUES (${lit(id)}, ${lit(label)}, ${now}, ${lit(role)}, ${lit(sub)})`);
        await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(machine)}, ${lit(id)}, ${now})`);
        await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
          VALUES (${lit(tokenId)}, ${lit(id)}, ${lit(machine)}, ${lit(await sha256Hex(token))}, ${now}, ${now + 3_600_000}, 0, ${lit(tokenId)}, ${now})`);
        viewers.push({ id, sub, machine, token, tokenId, headers: { cookie: await sessionCookie(sub, label), 'cf-connecting-ip': '1.2.3.4' } });
      }
      return viewers;
    },
    async stopCredential(viewer) { await target.sql(`UPDATE member_credentials SET expires_at = ${now - 1}, revoked_at = ${now} WHERE id = ${lit(viewer.tokenId)}`); },
    async stopMember(viewer) { await target.sql(`UPDATE members SET revoked_at = ${now} WHERE id = ${lit(viewer.id)}`); },
  };
}

/** Another member's transcript in a session whose capture belongs to a different machine, as older builds recorded it. */
export async function seedSiblingTranscript(target: ParityTarget, row: { projectId: string; transcriptId: string; session: string; machine: string; tokenId: string; size: number; blobKey: string; at: number }): Promise<void> {
  await target.sql(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role, prompt_identity_scheme)
    VALUES (${lit(row.projectId)}, ${lit(row.transcriptId)}, ${lit(row.session)}, ${lit(row.machine)}, 'claude-code', ${row.size}, 1, ${row.at}, ${row.at}, ${lit(row.tokenId)}, 'subagent', 'claude-v1')`);
  await target.sql(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    VALUES (${lit(row.projectId)}, ${lit(row.transcriptId)}, 0, ${row.size}, ${lit(row.blobKey)}, ${lit(crypto.randomUUID())}, ${row.at}, ${row.at}, ${lit(row.tokenId)})`);
}

/** A blob and a transcript whose uploading credential no Deployment holds. */
export async function seedUnattributedRaw(target: ParityTarget, row: { projectId: string; key: string; session: string; at: number }): Promise<void> {
  await target.sql(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
    VALUES (${lit(row.projectId)}, ${lit(row.key)}, 36, 'text/plain', 'unknown_token', ${row.at}, ${lit(crypto.randomUUID())})`);
  await target.sql(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, segment_count, first_received_at, last_received_at, token_id)
    VALUES (${lit(row.projectId)}, 'tx_00000000000000000000000000000000', ${lit(row.session)}, 'unknown_machine', 0, 0, ${row.at}, ${row.at}, 'unknown_token')`);
}

/** The removed uploader's GitHub account rejoined as a new membership: no client unlinks an account from a member. */
export async function rejoinAccount(target: ParityTarget, memberId: string, sub: string, at: number): Promise<void> {
  await target.sql(`UPDATE members SET github_id = NULL WHERE id = ${lit(memberId)}`);
  await target.sql(`INSERT INTO members (id, label, created_at, role, github_id) VALUES ('mem_raw_rejoined', 'new membership', ${at}, 'member', ${lit(sub)})`);
}
