/**
 * A session's publication facts as its transcript grows and its frontier moves: the facts the writes leave, and the
 * rows each write costs however many other sessions the Project holds.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { publicationStatement } from '@myco-server-worker/db/documents/frontiers.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const P = 'proj_1';
type D1 = Awaited<ReturnType<Miniflare['getD1Database']>>;
const frontier = (transcript: string, offset: number) => ({ t: transcript, o: offset, l: 1, p: null, u: 0, r: 0, a: null, ps: null, rs: 'source-record-v1', v: 1, s: 'active', f: null, w: null });

/** A D1 store whose Project holds `others` published sessions beside `busy`, each with one transcript and its frontier. */
async function store<T>(others: number, analyzed: boolean, use: (d1: D1) => Promise<T>): Promise<T> {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const d1 = await mf.getD1Database('DB');
    const ids = JSON.stringify(['busy', ...Array.from({ length: others }, (_, n) => `s${n}`)]);
    await d1.batch([
      d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?1,'p',1)").bind(P),
      d1.prepare("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) SELECT ?1,value,'m','t',1,1 FROM json_each(?2)").bind(P, ids),
      d1.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) SELECT ?1,value,'live',1,1 FROM json_each(?2)").bind(P, ids),
      d1.prepare("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) SELECT ?1,'t_'||value,value,'m',100,1,1,'t' FROM json_each(?2)").bind(P, ids),
      d1.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,session_id,generation,published_offset,record_scheme,parser_version,updated_at)
        SELECT ?1,'t_'||value,value,1,100,'source-record-v1',1,1 FROM json_each(?2)`).bind(P, ids),
    ]);
    if (analyzed) await d1.prepare('ANALYZE').run();
    return await use(d1);
  } finally { await mf.dispose(); }
}

/** Grows `busy`'s transcript, moves its frontier part of the way, then registers a second transcript and its frontier. */
async function writes(measured: ReturnType<typeof measuredStore>): Promise<Record<string, number>> {
  const reads: Record<string, number> = {};
  const measure = async (name: string, write: () => Promise<unknown>) => { measured.reset(); await write(); reads[name] = measured.reads(); };
  await measure('growth', () => measured.db.prepare("UPDATE transcripts SET size=160,last_received_at=2 WHERE project_id=?1 AND transcript_id='t_busy'").bind(P).run());
  await measure('progress', () => publicationStatement(measured.db, P, 'busy', 1, 3, [frontier('t_busy', 130)]).run());
  await measure('arrival', () => measured.db.prepare("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) VALUES(?1,'t_busy_2','busy','m',40,4,4,'t')").bind(P).run());
  await measure('newFrontier', () => publicationStatement(measured.db, P, 'busy', 1, 5, [frontier('t_busy_2', 10)]).run());
  return reads;
}

describe('publication facts', () => {
  it('count what the session still has to publish as its transcripts grow and its frontiers move', async () => {
    const facts = await store(20, false, async (d1) => {
      await writes(measuredStore(d1));
      return d1.prepare("SELECT transcripts,bytes FROM document_publication_facts WHERE project_id=?1 AND session_id='busy'").bind(P).first();
    });
    expect(facts).toEqual({ transcripts: 2, bytes: 60 });
  }, 120_000);

  for (const analyzed of [false, true]) {
    it(`cost the same rows beside 200 and 2,000 other sessions ${analyzed ? 'with' : 'without'} planner statistics`, async () => {
      const at = (others: number) => store(others, analyzed, (d1) => writes(measuredStore(d1)));
      expect(await at(2_000)).toEqual(await at(200));
    }, 240_000);
  }
});
