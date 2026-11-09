import type { RelationalStore } from '../../core/adapters.js';
import { publicationPolicy } from '../../ingest/publication-policy.js';
import { assertion, commitNamed, first, read, readSet, refusalCode, refused, rows, write } from '../index.js';
import { reset, retainedStart } from './rebuild.js';

/** What an owner asked to read again: every transcript one agent's parser reads, or one session's in a Project. */
export type RereadSelector = { agent: string } | { projectId: string; sessionId: string };

export interface RereadJob {
  id: string;
  state: 'running' | 'complete';
  /** Transcripts the job has walked past so far. */
  walked: number;
  /** Transcripts it has sent back to the start of their parse so far. */
  rewound: number;
  createdAt: number;
  completedAt: number | null;
}

const JOB_COLUMNS = 'id,state,walked,rewound,created_at,completed_at,agent,project_id,session_id,after_project,after_transcript,revision';
interface JobRow { id: string; state: 'running' | 'complete'; walked: number; rewound: number; created_at: number; completed_at: number | null;
  agent: string | null; project_id: string | null; session_id: string | null; after_project: string; after_transcript: string; revision: number }

const toJob = (row: JobRow): RereadJob => ({ id: row.id, state: row.state, walked: row.walked, rewound: row.rewound, createdAt: row.created_at, completedAt: row.completed_at });

const openJob = write<[id: string, agent: string | null, project: string | null, session: string | null, by: string, at: number]>({ name: 'reread.open', sql:
  `INSERT INTO transcript_reread_jobs(id,agent,project_id,session_id,requested_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)
    ON CONFLICT(COALESCE(agent,''),COALESCE(project_id,''),COALESCE(session_id,'')) WHERE state='running' DO NOTHING` });
const jobById = read<[id: string], JobRow>({ name: 'reread.jobById', sql: `SELECT ${JOB_COLUMNS} FROM transcript_reread_jobs WHERE id=?1` });
const jobOfSelector = read<[agent: string | null, project: string | null, session: string | null], JobRow>({ name: 'reread.jobOfSelector', sql:
  `SELECT ${JOB_COLUMNS} FROM transcript_reread_jobs WHERE state='running' AND COALESCE(agent,'')=COALESCE(?1,'') AND COALESCE(project_id,'')=COALESCE(?2,'') AND COALESCE(session_id,'')=COALESCE(?3,'')` });

/** Accepts a reread: the one already running for this selector, or a new job. The work runs in the job, not this request. */
export async function requestReread(db: RelationalStore, selector: RereadSelector, by: string, now: number): Promise<RereadJob> {
  const agent = 'agent' in selector ? selector.agent : null;
  const project = 'agent' in selector ? null : selector.projectId;
  const session = 'agent' in selector ? null : selector.sessionId;
  const id = crypto.randomUUID();
  const { held } = await commitNamed(db, { open: openJob.bind(id, agent, project, session, by, now), held: jobOfSelector.bind(agent, project, session) });
  return toJob(held.results[0]!);
}

/** A reread job's progress, or null when no job has this id. */
export async function rereadJob(db: RelationalStore, id: string): Promise<RereadJob | null> {
  const row = await first(db, jobById.bind(id));
  return row === null ? null : toJob(row);
}

/** Transcripts one reread step walks. */
const REREAD_PAGE = 256;

const moved = refusalCode('transcript_reread_moved');
const unchanged = assertion<[id: string, revision: number]>({ name: 'reread.jobUnchanged', refusal: moved,
  when: "EXISTS(SELECT 1 FROM transcript_reread_jobs WHERE id=?1 AND revision=?2 AND state='running')" });

const KEYS = `(SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS transcript_id FROM json_each(?1))`;
const LIVE = `d.state='live' AND NOT EXISTS(SELECT 1 FROM session_tombstones z WHERE (z.project_id,z.session_id)=(d.project_id,d.session_id))`;
const SELECTED = `FROM ${KEYS} k JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)
  JOIN session_documents d ON (d.project_id,d.session_id)=(t.project_id,t.session_id) WHERE ${LIVE}`;
const policy = publicationPolicy('t.prompt_identity_scheme');

/** Owner-requested rereads retain the current document and replay the same pinned canonical identities. */
const replay = write<[keys: string]>({ name: 'reread.replay', sql:
  `INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,prompt_scheme,record_scheme,parser_version,updated_at)
    SELECT t.project_id,t.transcript_id,d.generation,t.session_id,${retainedStart('t')},${policy.prompt},${policy.record},0,0 ${SELECTED}
    ON CONFLICT(project_id,transcript_id,generation) DO UPDATE SET ${reset('transcript_publication','excluded.published_offset')},
      prompt_scheme=COALESCE(transcript_publication.prompt_scheme,excluded.prompt_scheme)` });
const arm = write<[keys: string]>({ name: 'reread.arm', sql:
  `UPDATE session_documents AS d SET due_at=0 WHERE ${LIVE}
    AND (d.project_id,d.session_id) IN (SELECT t.project_id,t.session_id FROM ${KEYS} k JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id))` });
const advance = write<[keys: string, walked: number, nextProject: string, nextTranscript: string, finished: number, at: number, id: string, revision: number]>({ name: 'reread.advance', sql:
  `UPDATE transcript_reread_jobs SET rewound=rewound+(SELECT COUNT(*) ${SELECTED}),walked=walked+?2,after_project=?3,after_transcript=?4,
      state=CASE WHEN ?5=1 THEN 'complete' ELSE state END,completed_at=CASE WHEN ?5=1 THEN ?6 ELSE completed_at END,updated_at=?6,revision=revision+1
    WHERE id=?7 AND revision=?8` });

type TranscriptKey = { project_id: string; transcript_id: string };
const agentPage = read<[afterProject: string, afterTranscript: string, limit: number], TranscriptKey & { agent: string | null }>({ name: 'reread.agentPage', sql:
  'SELECT project_id,transcript_id,agent FROM transcripts WHERE (project_id,transcript_id)>(?1,?2) ORDER BY project_id,transcript_id LIMIT ?3' });
const sessionPage = read<[project: string, session: string, after: string, limit: number], TranscriptKey>({ name: 'reread.sessionPage', sql:
  'SELECT project_id,transcript_id FROM transcripts WHERE project_id=?1 AND session_id=?2 AND transcript_id>?3 ORDER BY transcript_id LIMIT ?4' });

const runningJobs = read<[limit: number], JobRow>({ name: 'reread.runningJobs', sql:
  `SELECT ${JOB_COLUMNS} FROM transcript_reread_jobs INDEXED BY idx_transcript_reread_running WHERE state='running' ORDER BY created_at,id LIMIT ?1` });

/** Takes one bounded page of a reread job, walking transcripts in key order and committing the page and its advance together. */
async function stepReread(db: RelationalStore, job: JobRow, now: number): Promise<number> {
  const page = job.agent !== null
    ? await rows(db, agentPage.bind(job.after_project, job.after_transcript, REREAD_PAGE))
    : await rows(db, sessionPage.bind(job.project_id!, job.session_id!, job.after_transcript, REREAD_PAGE));
  const walked = page.at(-1);
  const finished = page.length < REREAD_PAGE ? 1 : 0;
  const selected = job.agent !== null ? (page as Array<TranscriptKey & { agent: string | null }>).filter(row => row.agent === job.agent) : page;
  const keys = JSON.stringify(selected.map(row => [row.project_id, row.transcript_id]));
  try {
    await commitNamed(db, {
      unchanged: unchanged.bind(job.id, job.revision),
      replay: replay.bind(keys),
      arm: arm.bind(keys),
      advance: advance.bind(keys, page.length, walked?.project_id ?? job.after_project, walked?.transcript_id ?? job.after_transcript, finished, now, job.id, job.revision),
    });
    return selected.length;
  } catch (error) {
    if (refused(error, moved)) return 0;
    throw error;
  }
}

const REREAD_STEPS_PER_WAKE = 4;

/** Advances running reread jobs by bounded pages, oldest first. Answers transcripts rewound and whether work remains. */
export async function advanceRereads(db: RelationalStore, now: number): Promise<{ changed: number; more: boolean }> {
  const jobs = await rows(db, runningJobs.bind(REREAD_STEPS_PER_WAKE));
  let changed = 0;
  for (const job of jobs) changed += await stepReread(db, job, now);
  const [left] = await readSet(db, runningJobs.bind(1));
  return { changed, more: left.length > 0 };
}
