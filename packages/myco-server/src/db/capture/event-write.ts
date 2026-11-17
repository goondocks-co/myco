/** The statements beside a captured event's raw insert: its byte charge, its session receipt, and the reads that decide the answer. */
import { TOKEN_LIVE } from '../identity/capture-credential.js';
import { read, write, type Bound } from '../index.js';
import { Slots } from './slots.js';
import { LIVE_CAPTURE_FIELDS, liveEvidenceAdvances, liveEvidenceMax } from './live.js';

/** The raw row this request wrote, named by its nonce: a duplicate or a conflict another request wrote never matches. */
export const storedByThisRequest = (project: string, event: string, nonce: string): string =>
  `EXISTS (SELECT 1 FROM events WHERE project_id = ${project} AND event_id = ${event} AND ingest_nonce = ${nonce})`;

const charge = write<[bytes: number, token: string]>({ name: 'capture.chargeBytes', sql:
  'UPDATE member_credentials SET bytes_written = bytes_written + (?1 * changes()) WHERE id = ?2' });
const uncharged = read<[], { uncharged: number }>({ name: 'capture.uncharged', sql: 'SELECT 1 AS uncharged' });

type Receipt = [project: string, session: string, machine: string, token: string, first: number, last: number, agent: string | null, event: string, nonce: string, liveAt: number | null, liveStartAt: number | null];
const RECEIPT_ROW = `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at, last_trust_start_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?11 WHERE ${storedByThisRequest('?1', '?8', '?9')}`;
const liveFields = LIVE_CAPTURE_FIELDS.map(column => `${column}=${liveEvidenceMax('sessions', column)}`).join(',');
const memberReceipt = write<Receipt>({ name: 'capture.memberReceipt', sql:
  `${RECEIPT_ROW} ON CONFLICT (project_id, session_id) DO UPDATE SET last_received_at = excluded.last_received_at,${liveFields}` });
const deploymentReceipt = write<Receipt>({ name: 'capture.deploymentReceipt', sql: `${RECEIPT_ROW} ON CONFLICT (project_id, session_id) DO UPDATE SET ${liveFields}
    WHERE ${LIVE_CAPTURE_FIELDS.map(column => liveEvidenceAdvances('sessions', column)).join(' OR ')}` });

const stored = read<[project: string, event: string, machine: string], { envelope_hash: string; ingest_nonce: string }>({ name: 'capture.storedEvent', sql:
  `SELECT ev.envelope_hash, ev.ingest_nonce FROM events ev JOIN sessions s ON s.project_id = ev.project_id AND s.session_id = ev.session_id
    WHERE ev.project_id = ?1 AND ev.event_id = ?2 AND s.machine_id IS ?3` });
const liveSlots = new Slots<'charged' | 'token'>();
const live = read<[charged: number, token: string], { live: number }>({ name: 'capture.credentialLive', sql:
  `SELECT CASE WHEN ${liveSlots.at('charged')} = 1 THEN ${liveSlots.place(TOKEN_LIVE, ['token'])} ELSE 1 = 1 END AS live` });

interface Writer { project: string; session: string; machine: string; token: string; event: string; nonce: string }

/** A member's stored bytes counted on its credential, by the rows the raw insert just wrote; a Deployment's own write is counted nothing. */
export const chargeStoredBytes = (charged: boolean, bytes: number, token: string): Bound => (charged ? charge.bind(bytes, token) : uncharged.bind());

/**
 * The stored event's session receipt. Member contact moves the receipt date; Deployment parsing retains it.
 * Live-channel receipts advance activity. Starts retain the earlier client or receipt clock independently of harness reports.
 */
export function sessionReceipt(w: Writer, receipt: { charged: boolean; now: number; createdAt: number; agent: string | null; live: boolean; start: boolean }): Bound {
  const at = receipt.charged ? receipt.now : receipt.createdAt;
  return (receipt.charged ? memberReceipt : deploymentReceipt).bind(w.project, w.session, w.machine, w.token, at, at, receipt.agent, w.event, w.nonce, receipt.live ? receipt.now : null, receipt.live && receipt.start ? Math.min(receipt.now, receipt.createdAt) : null);
}

/** The stored event as its session's machine sees it: the nonce, not a change count, says whether this request wrote it. */
export const storedEvent = (project: string, event: string, machine: string): Bound<{ envelope_hash: string; ingest_nonce: string }, 'read'> =>
  stored.bind(project, event, machine);

/** Whether the writing credential is still live, read in the same batch; a Deployment's own write reads as live. */
export const credentialStillLive = (charged: boolean, token: string): Bound<{ live: number }, 'read'> => live.bind(charged ? 1 : 0, token);
