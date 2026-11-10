import { expect, it } from 'bun:test';
import { tombstoneSession } from './helpers/session-deletion.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const PROJECT = 'snapshot-budget';
/** Plans served from each tombstoned source session. */
const SOURCE_SNAPSHOTS = 200;
/** Receipts of other sources, two served plans each. */
const SIZES = [2_000, 10_000] as const;

it('D1 source tombstones cost the same as other sources\' served snapshots grow, and clear only their own', async () => {
  const costs = await d1TwoScale({
    sizes: SIZES,
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,'Snapshots',1)").bind(PROJECT).run();
      for (const session of ['source-0', 'source-1', 'source-other', 'receiver']) {
        await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
          VALUES(?,?,'machine','fixture',1,1)`).bind(PROJECT, session).run();
      }
    },
    // Each unit is one receipt served two plans of another source session.
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,plan_ids,created_at)
        SELECT ?3,'receiver',printf('00000000-0000-4000-8000-%012d',i),printf('00000000-0000-7000-8000-%012d',i),'prompt-hash-'||i,'[]',
          json_array('plan-'||(i*2),'plan-'||(i*2+1)),i FROM n`, PROJECT);
      await eachUnit(db, from * 2, to * 2, `INSERT INTO injection_served_items(project_id,receipt_id,kind,item_id,title,session_id,content_hash,unavailable)
        SELECT ?3,printf('00000000-0000-4000-8000-%012d',i/2),'plan','plan-'||i,'Served plan '||i,'source-other','content-hash-'||i,0 FROM n`, PROJECT);
    },
    cases: [{
      name: 'source tombstone',
      run: async (db, { scale, store }) => {
        const source = `source-${scale}`;
        // The source's own snapshots sit on receipts the corpus already holds.
        await eachUnit(store, 0, SOURCE_SNAPSHOTS, `INSERT INTO injection_served_items(project_id,receipt_id,kind,item_id,title,session_id,content_hash,unavailable)
          SELECT ?3,printf('00000000-0000-4000-8000-%012d',i),'plan',?4||'-plan-'||i,'Served plan '||i,?4,'content-hash-'||i,0 FROM n`, PROJECT, source);
        const other = (await store.prepare("SELECT COUNT(*) AS n FROM injection_served_items WHERE session_id='source-other' AND unavailable=0").first<{ n: number }>())!.n;
        expect((await tombstoneSession({ db }, { projectId: PROJECT }, source, 'fixture', 10_001)).applied).toBe(true);
        expect(await store.prepare(`SELECT COUNT(*) AS n FROM injection_served_items
          WHERE item_id LIKE ? AND session_id IS NULL AND title IS NULL AND content_hash IS NULL AND unavailable=1`).bind(`${source}-plan-%`).first()).toEqual({ n: SOURCE_SNAPSHOTS });
        expect(await store.prepare("SELECT COUNT(*) AS n FROM injection_served_items WHERE session_id='source-other' AND title IS NOT NULL AND unavailable=0").first())
          .toEqual({ n: other });
        // Every receipt that served the deleted source's plans is kept.
        expect(await store.prepare("SELECT COUNT(*) AS n FROM spore_injections WHERE project_id=? AND session_id='receiver'").bind(PROJECT).first()).toEqual({ n: scale === 1 ? SIZES[1] : SIZES[0] });
      },
    }],
  });
  expectTwoScale(costs);
}, 120_000);
