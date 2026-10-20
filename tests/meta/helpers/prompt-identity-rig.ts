/**
 * An in-process member and Deployment whose prompt-time recall serves real spores: the worker the member tests drive,
 * with a Workers AI binding that embeds by keyword and a vector index fixture, a Project admitted to recall, and
 * spores written and embedded through the Deployment's own reconcile. A prompt naming `RELEVANT_WORD` is served the
 * relevant spores; the background spores calibrate the selector and are never relevant.
 */
import { declaredScheme } from '@myco-server-worker/ingest/prompt-scheme.js';
import { registerBlob } from '../../myco-server/helpers/d1.js';
import { indexFixture } from '../../myco-server/helpers/vector-index.js';
import { turnOnGatedCapabilities } from '../../myco-server/helpers/fixtures.js';
import { memberRig, tempMycoHome, TEST_PROJECT_ID, type MemberRig } from '../../member/helpers/server.js';
import { recordingFetch, registerTestMember } from '../../member/helpers/hooks.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { parseTranscripts, TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';

export const RELEVANT_WORD = 'retention';
const DIMENSIONS = 8;

/** A unit vector on the relevant axis for text naming the word, and on another axis per text otherwise. */
function vectorFor(text: string): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0);
  if (text.toLowerCase().includes(RELEVANT_WORD)) values[0] = 1;
  else values[1 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % (DIMENSIONS - 1))] = 1;
  return values;
}

export interface IdentityRig {
  rig: MemberRig;
  mycoHome: string;
  fetch: ReturnType<typeof recordingFetch>;
  /** Run the Deployment's parse over every transcript it holds until nothing changes, now and once it has gone idle. */
  parse(): Promise<void>;
  /** Store bytes as a transcript's only segment, as a member's shipped transcript lands. */
  storeTranscript(opts: { transcriptId: string; sessionId: string; agent: string; text: string; role?: 'primary' | 'subagent' }): Promise<void>;
  /** Store bytes as the next segment of a transcript already stored, as a member's next shipment lands. */
  appendTranscript(opts: { transcriptId: string; text: string }): Promise<void>;
  rows(sql: string, ...params: unknown[]): Record<string, unknown>[];
}

/** The rig, with `relevant` spores about the relevant word and `background` others, embedded. */
export async function identityRig(opts: { relevant?: number; background?: number } = {}): Promise<IdentityRig> {
  const mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  const rig = await memberRig();
  const bindings = rig.env.env as Record<string, unknown>;
  bindings.AI = { run: async (_model: string, input: { text: string[] }) => ({ data: [vectorFor(input.text[0]!)] }) };
  bindings.VECTORIZE = indexFixture();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: TEST_PROJECT_ID, expiresAt: rig.expiresAt });
  const { sqlite } = rig.env;
  turnOnGatedCapabilities(sqlite, [TEST_PROJECT_ID]);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`);
  const spore = (id: string, content: string) => sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, importance, created_at, embedded)
    VALUES (?, ?, 'agent_1', 'decision', 'active', ?, 5, 1, 0)`, [TEST_PROJECT_ID, id, content]);
  for (let i = 0; i < (opts.relevant ?? 2); i++) spore(`relevant-${i}`, `The ${RELEVANT_WORD} window keeps thirty days of records (${i}).`);
  for (let i = 0; i < (opts.background ?? 24); i++) spore(`background-${i}`, `Unrelated background observation number ${i}.`);
  const env = rig.env.serverEnv;
  const provider = await env.embeddingProvider!();
  if (provider === null || env.vectors === undefined) throw new Error('the identity rig resolved no embedding provider');
  for (let pass = 0; pass < 200; pass++) {
    await reconcileEmbedding({ db: env.db, blobs: env.blobs, vectors: env.vectors, provider }, TEST_PROJECT_ID, Date.now());
    const left = (sqlite.query(`SELECT COUNT(*) AS n FROM embedding_sources s WHERE s.project_id = ? AND s.type = 'spore'
      AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.record_id = s.record_id AND r.ready = 1)`).get(TEST_PROJECT_ID) as { n: number }).n;
    if (left === 0) break;
  }
  sqlite.run(`UPDATE embedding_receipts SET neighbor_mean = 0.5, neighbor_std = 0.1 WHERE project_id = ?`, [TEST_PROJECT_ID]);

  return {
    rig, mycoHome, fetch: recordingFetch(rig.fetch),
    async parse() {
      // Then once more after the transcript has gone idle, which ends the reply a turn was still writing.
      for (const at of [Date.now(), Date.now() + TRANSCRIPT_IDLE_MS + 1]) {
        for (let pass = 0; pass < 20; pass += 1) {
          if ((await parseTranscripts(rig.env.serverEnv, at)).changed === 0) break;
        }
      }
    },
    async storeTranscript({ transcriptId, sessionId, agent, text, role = 'primary' }) {
      const bytes = utf8(text);
      const key = await sha256HexOf(bytes);
      const now = Date.now();
      const objectKey = registerBlob(sqlite, { projectId: TEST_PROJECT_ID, key, size: bytes.length, tokenId: rig.tokenId, receivedAt: now });
      await rig.env.bucket.put(objectKey, new Blob([bytes]).stream());
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role, prompt_identity_scheme)
        VALUES (?, ?, ?, 'machine_1', ?, ?, 1, ?, ?, ?, ?, ?)`, [TEST_PROJECT_ID, transcriptId, sessionId, agent, bytes.length, now, now, rig.tokenId, role, declaredScheme(agent)]);
      sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`, [TEST_PROJECT_ID, transcriptId, bytes.length, key, `seg-${transcriptId}`, now, now, rig.tokenId]);
    },
    async appendTranscript({ transcriptId, text }) {
      const bytes = utf8(text);
      const key = await sha256HexOf(bytes);
      const now = Date.now();
      const { size } = sqlite.query(`SELECT size FROM transcripts WHERE project_id = ? AND transcript_id = ?`).get(TEST_PROJECT_ID, transcriptId) as { size: number };
      const objectKey = registerBlob(sqlite, { projectId: TEST_PROJECT_ID, key, size: bytes.length, tokenId: rig.tokenId, receivedAt: now });
      await rig.env.bucket.put(objectKey, new Blob([bytes]).stream());
      sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [TEST_PROJECT_ID, transcriptId, size, bytes.length, key, `seg-${transcriptId}-${size}`, now, now, rig.tokenId]);
      sqlite.run(`UPDATE transcripts SET size = size + ?, segment_count = segment_count + 1, last_received_at = ? WHERE project_id = ? AND transcript_id = ?`,
        [bytes.length, now, TEST_PROJECT_ID, transcriptId]);
    },
    rows: (sql, ...params) => sqlite.query(sql).all(...(params as never[])) as Record<string, unknown>[],
  };
}
