import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { readCurationAnswer, readCurationCoverage, recordCurationConsidered } from '@myco-server-worker/db/spores/curation-answer.js';
import { answerSporeCuration } from '@myco-server-worker/core/spore-curation.js';
import { readCurationSeeds } from '@myco-server-worker/db/spores/curation-discovery.js';
import { listSupersedingSporeIds } from '@myco-server-worker/db/spores/edges.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase } from './helpers/two-scale.js';

const project = 'proj_a';
async function setup(db: RelationalStore): Promise<void> {
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_a','A',1)").run();
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('curator','Curator','built-in',1,1)").run();
  for (const key of ['0','1']) {
    await db.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('proj_a',?1,'curator','curate-spores','running',1)").bind(key).run();
    const members=[{id:'source-'+key,revision:0}];
    await db.prepare("INSERT INTO spores(project_id,id,agent_id,observation_type,content,created_at) VALUES('proj_a',?1,'curator','gotcha','Source',1)").bind(members[0]!.id).run();
    await db.prepare("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at,run_id) VALUES('proj_a',?1,?2,1,?1)").bind(key,JSON.stringify(members)).run();
  }
}
const grow = (db: RelationalStore, from: number, to: number) => eachUnit(db,from,to,
  "INSERT INTO spores(project_id,id,agent_id,observation_type,content,created_at) SELECT 'proj_a','noise-'||i,'curator','gotcha','Unrelated history',10+i FROM n");
const cases: CostCase[] = [
  {name:'unconsidered coverage', run:async db=>expect((await readCurationCoverage(db,project)).unconsidered).toBeGreaterThan(0)},
  {name:'the changed-seed page', run:async db=>expect((await readCurationSeeds(db,project,{after_at:0,after_id:'',priority_at:0,history_at:0,history_id:''},8)).length).toBeGreaterThan(0)},
  {name:'a no-group consideration',run:async(db,{scale})=>recordCurationConsidered(db,{project,members:[{id:'noise-'+scale,revision:0}],outcome:'no_group',at:2})},
  {name:'one checked split and all its receipts',run:async(db,{scale})=>{
    const key=String(scale), id='source-'+key;
    const notes=[0,1].map(part=>({sources:[id],observation_type:'gotcha',agent_line:'When changing delivery, retain pending work.',content:'One situation '+part+'.'}));
    const result=await answerSporeCuration({op:'answer',notes,keep:[],retire:[],reason:'Two situations.'},
      {db,projectId:project,runId:key,agentId:'curator',now:2,runContext:JSON.stringify({curation:{kind:'curation',key,members:[{id,revision:0}]}})}) as {completed:boolean;notes:{id:string}[]};
    expect(result.completed).toBe(true);
    expect((await listSupersedingSporeIds(db,{projectId:project},id)).sort()).toEqual(result.notes.map(note=>note.id).sort());
    expect((await readCurationAnswer(db,project,key))!.applied).toBe(1);
  }},
];
it('curation reads and writes D1 independently of the corpus size',async()=>{
  expectTwoScale(await d1TwoScale({sizes:[200,2000],setup,grow,cases}));
},300_000);
