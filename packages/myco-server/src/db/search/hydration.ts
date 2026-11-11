import type { RelationalStore } from '../../core/adapters.js';
import { occurredAt, presentedStatus } from '../session-dates.js';
import { read, readSet } from '../index.js';
import { planOutcomeLineSql, planResolvedSql } from '../plans/resolution.js';

/**
 * A page's documents read back with the records they stand for, keeping only those a reader may list now: in a Project
 * the reader reaches, not of a deleted session, and meeting every filter the full-text window could not apply (agent,
 * branch, a session's state, a plan chunk's plan, time). A chunk of a stored body reads back once for every live plan
 * whose proved body it is part of. Text is read only when asked for, around the first place the word appears.
 */

/** The filters a page applies in SQL; an absent one admits every document. */
export interface HydrationFilters {
  projects: readonly string[];
  agent?: string; branch?: string; status?: string; session?: string;
  /** Epoch milliseconds, inclusive. */
  sinceMs?: number; untilMs?: number;
}

/** How much of a record's text to read, and the word to read it around; no text when `chars` is 0. */
export interface TextRead { chars: number; word: string | null }

/** A document read back with its record. A chunk names the plan it reads back for. */
export interface HydratedDocument {
  doc_id: number;
  kind: 'session' | 'plan' | 'spore' | 'card' | 'chunk';
  project_id: string;
  id: string;
  /** For a plan or chunk: the plan, as `[project, plan_key]`. */
  plan: string | null;
  title: string | null;
  line: string | null;
  text: string | null;
  /** Where in the record's text `text` starts, from 1. */
  text_start: number | null;
  status: string | null;
  observation_type: string | null;
  session_id: string | null;
  prompt_id: string | null;
  created_at: number;
  agent: string | null;
  /** A card hit's turn. */
  turn_id: string | null;
  turn_preview: string | null;
  turn_chars: number | null;
}

type Slots = [ids: string, projects: string, agent: string | null, branch: string | null, status: string | null, session: string | null,
  since: number | null, until: number | null, chars: number, word: string | null];

const IDS = 'json_each(?1) j CROSS JOIN search_documents d ON d.doc_id = j.value';
const sessionOf = (session: string) => `LEFT JOIN sessions se ON se.project_id = d.project_id AND se.session_id = ${session}`;
const live = (session: string) => `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = d.project_id AND t.session_id = ${session})`;
/** The record's text from about the first place the word appears, or from its start; none when no text is asked for. */
const textOf = (column: string) => `CASE WHEN ?9 > 0 THEN substr(${column}, MAX(1, instr(lower(${column}), COALESCE(?10, '')) - 150), ?9) END AS text,
  CASE WHEN ?9 > 0 THEN MAX(1, instr(lower(${column}), COALESCE(?10, '')) - 150) END AS text_start`;

interface Admission { agent: string; branch: string; status: string; session: string; created: string; liveSession: string | null }
const admitted = (a: Admission) => [
  'd.project_id IN (SELECT value FROM json_each(?2))',
  `(?3 IS NULL OR ${a.agent} = ?3)`, `(?4 IS NULL OR ${a.branch} = ?4)`, `(?5 IS NULL OR ${a.status} = ?5)`, `(?6 IS NULL OR ${a.session} = ?6)`,
  `(?7 IS NULL OR ${a.created} >= ?7)`, `(?8 IS NULL OR ${a.created} <= ?8)`,
  ...(a.liveSession === null ? [] : [live(a.liveSession)]),
].join(' AND ');

const NO_TURN = 'NULL AS turn_id, NULL AS turn_preview, NULL AS turn_chars';
/** A past plan's outcome as its hit reads: how and when it was resolved, then its resolution note. */
const PLAN_LINE = `CASE WHEN ${planResolvedSql('p')} THEN ${planOutcomeLineSql('p')} END AS line`;

const HYDRATE = [
  read<Slots, HydratedDocument>({ name: 'searchHydration.sessions', sql:
    `SELECT d.doc_id, 'session' AS kind, d.project_id, s.session_id AS id, NULL AS plan, s.title, NULL AS line, ${textOf('s.summary')},
      ${presentedStatus('s.')} AS status, NULL AS observation_type, s.session_id, NULL AS prompt_id, ${occurredAt('s.')} AS created_at, s.agent, ${NO_TURN}
    FROM ${IDS} CROSS JOIN sessions s ON s.project_id = d.project_id AND s.session_id = d.source_key
    WHERE d.kind = 'session' AND ${admitted({ agent: 's.agent', branch: 's.branch', status: presentedStatus('s.'), session: 's.session_id', created: occurredAt('s.'), liveSession: 's.session_id' })}` }),
  read<Slots, HydratedDocument>({ name: 'searchHydration.spores', sql:
    `SELECT d.doc_id, 'spore' AS kind, d.project_id, s.id, NULL AS plan, s.observation_type AS title, s.agent_line AS line, ${textOf('s.content')},
      s.status, s.observation_type, s.session_id, s.prompt_id, s.created_at, se.agent, ${NO_TURN}
    FROM ${IDS} CROSS JOIN spores s ON s.project_id = d.project_id AND s.id = d.source_key ${sessionOf('s.session_id')}
    WHERE d.kind = 'spore' AND ${admitted({ agent: 'se.agent', branch: 'se.branch', status: 's.status', session: 's.session_id', created: 's.created_at', liveSession: null })}` }),
  read<Slots, HydratedDocument>({ name: 'searchHydration.plans', sql:
    `SELECT d.doc_id, 'plan' AS kind, d.project_id, p.plan_key AS id, json_array(p.project_id, p.plan_key) AS plan, p.title, ${PLAN_LINE}, ${textOf('p.content')},
      p.status, NULL AS observation_type, p.session_id, p.prompt_id, p.created_at, se.agent, ${NO_TURN}
    FROM ${IDS} CROSS JOIN plans p ON p.project_id = d.project_id AND p.plan_key = d.source_key ${sessionOf('p.session_id')}
    WHERE d.kind = 'plan' AND ${admitted({ agent: 'se.agent', branch: 'se.branch', status: 'p.status', session: 'p.session_id', created: 'p.created_at', liveSession: 'p.session_id' })}` }),
  read<Slots, HydratedDocument>({ name: 'searchHydration.chunks', sql:
    `SELECT d.doc_id, 'chunk' AS kind, d.project_id, p.plan_key AS id, json_array(p.project_id, p.plan_key) AS plan, p.title, ${PLAN_LINE}, ${textOf('d.body')},
      p.status, NULL AS observation_type, p.session_id, p.prompt_id, p.created_at, se.agent, ${NO_TURN}
    FROM ${IDS} CROSS JOIN search_blob_refs r ON r.project_id = d.project_id AND r.blob_key = d.blob_key
      CROSS JOIN plans p ON p.project_id = r.project_id AND p.plan_key = r.plan_key ${sessionOf('p.session_id')}
    WHERE d.kind = 'chunk' AND ${admitted({ agent: 'se.agent', branch: 'se.branch', status: 'p.status', session: 'p.session_id', created: 'p.created_at', liveSession: 'p.session_id' })}` }),
  read<Slots, HydratedDocument>({ name: 'searchHydration.cards', sql:
    `SELECT d.doc_id, 'card' AS kind, d.project_id, c.turn_key AS id, NULL AS plan, c.headline AS title, NULL AS line, ${textOf('c.card')},
      NULL AS status, NULL AS observation_type, c.session_id, c.turn_key AS prompt_id, c.created_at, se.agent,
      tp.prompt_id AS turn_id, tp.preview AS turn_preview, tp.text_chars AS turn_chars
    FROM ${IDS} CROSS JOIN turn_cards c ON c.project_id = d.project_id AND c.session_id = d.session_id AND c.turn_key = json_extract(d.source_key, '$[1]')
      ${sessionOf('c.session_id')}
      LEFT JOIN session_documents td ON td.project_id = c.project_id AND td.session_id = c.session_id AND td.state = 'live'
      LEFT JOIN session_prompts tp ON tp.project_id = td.project_id AND tp.session_id = td.session_id AND tp.generation = td.generation
        AND tp.prompt_id = c.turn_key AND tp.turn_key = tp.prompt_id
    WHERE d.kind = 'card' AND ${admitted({ agent: 'se.agent', branch: 'se.branch', status: 'NULL', session: 'c.session_id', created: 'c.created_at', liveSession: 'c.session_id' })}` }),
] as const;

/** The admitted documents of `ids`, each with its rows (a chunk has one per plan it reads back for), in one read set. */
export async function hydrateDocuments(db: RelationalStore, ids: readonly number[], filters: HydrationFilters, text: TextRead): Promise<Map<number, HydratedDocument[]>> {
  const found = new Map<number, HydratedDocument[]>();
  if (ids.length === 0) return found;
  const slots: Slots = [JSON.stringify(ids), JSON.stringify(filters.projects), filters.agent ?? null, filters.branch ?? null, filters.status ?? null,
    filters.session ?? null, filters.sinceMs ?? null, filters.untilMs ?? null, text.chars, text.word];
  const rows = await readSet(db, ...HYDRATE.map((statement) => statement.bind(...slots)));
  for (const row of rows.flat()) {
    const id = Number(row.doc_id);
    found.set(id, [...(found.get(id) ?? []), { ...row, doc_id: id, created_at: Number(row.created_at) }]);
  }
  return found;
}
