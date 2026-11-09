import { describe, expect, it } from 'bun:test';
import { commit } from '@myco-server-worker/db/index.js';
import { knowledgeInputForExecution } from '@myco-server-worker/core/knowledge-execution.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { uuid } from './helpers/fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { NOW, DAY, capture, EMPTY_CARD, cardRun, learningRun, plainTurns } from './helpers/learning-stages.ts';

it('learning receives and pins the optional repository before validating new knowledge against code', async () => {
  await withDocumentStores(async db => {
    const run = await learningRun(db, plainTurns(1), 'low', undefined, null, true);
    expect(run.claimed.repository).toEqual({url:'https://example.test/team/repo',branch:'main',historyDepth:1});
    expect(run.claimed.instruction).toContain('Check claims against this code before saving');
    expect(run.claimed.instructions).toContain('validate new guidance against the code now');
    expect(run.claimed.instructions).toContain('Obsolete an existing spore the code contradicts');
    const cursor=await knowledgeInputForExecution(run.env,'project','extract-curate',{
      instruction:run.claimed.instruction!,repository:run.claimed.repository,inputHash:'fixture',counts:{},
    },'cursor',WORKER_CAPABILITIES);
    expect(cursor.repository).toBeUndefined();
    expect(cursor.instruction).toContain('No usable repository checkout is available');
    expect(await prepareWorkerRepository(run.env,{worker:run.principal,clock:()=>NOW+DAY+2},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,
      body:{url:'https://example.test/team/repo',branch:'main',commit:'b'.repeat(40)},
    })).toMatchObject({held:true,pin:{commit:'b'.repeat(40)}});
    await run.readAll();
    const saved=await run.save('Shared counters: increment atomically.') as {id:string};
    expect(await db.prepare('SELECT file_path FROM spores WHERE id=?').bind(saved.id).first()).toEqual({file_path:null});
  });
});

describe('learning without a repository checkout', () => {
  const check = async (scenario: { connected: boolean; harness: string; capabilities: readonly string[]; queued: boolean; unreadable?: boolean }) => {
    await withDocumentStores(async db => {
      const run=await learningRun(db,plainTurns(1),'low',undefined,null,scenario.connected,scenario);
      expect(run.claimed.harness).toBe(scenario.harness);
      expect(run.claimed).not.toHaveProperty('repository');
      expect(run.claimed.instruction).toContain('No usable repository checkout is available');
      expect(run.claimed.instruction).not.toContain('is pinned at its current commit');
      await run.readAll();
      expect(await run.save('Shared counters: increment atomically.')).toHaveProperty('id');
    });
  };

  it('claims learning without code on disconnected Codex', async () => {
    await check({connected:false,harness:'codex',capabilities:[],queued:false});
  });
  it('claims queued learning without code on Codex without checkout capability', async () => {
    await check({connected:true,harness:'codex',capabilities:[],queued:true});
  });
  it('claims learning without code on Claude Code without checkout capability', async () => {
    await check({connected:true,harness:'claude-code',capabilities:[],queued:false});
  });
  it('claims learning without code from an unreadable repository', async () => {
    await check({connected:true,harness:'claude-code',capabilities:WORKER_CAPABILITIES,unreadable:true,queued:false});
  });
});

it('continues a learning attempt after unavailable source, preserving material and recording the reason once', async () => {
  await withDocumentStores(async db => {
    const run=await learningRun(db,plainTurns(1),'low',undefined,null,true);
    const report=()=>prepareWorkerRepository(run.env,{worker:run.principal,clock:()=>NOW+DAY+2},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,body:{unavailable:{code:'submodules'}},
    });
    expect(await report()).toMatchObject({held:true});
    expect(await report()).toMatchObject({held:true});
    const source=await db.prepare('SELECT instruction,run_context FROM agent_runs WHERE id=?').bind(run.claimed.id).first<{instruction:string;run_context:string}>();
    expect(source!.instruction).toContain('No usable repository checkout is available');
    expect(JSON.parse(source!.run_context)).not.toHaveProperty('checkout');
    expect((await db.prepare("SELECT payload FROM agent_run_events WHERE run_id=? AND tool_name='worker_repository'").bind(run.claimed.id).all()).results)
      .toEqual([{payload:JSON.stringify({op:'unavailable',code:'submodules'})}]);
    await run.readAll();
    expect(await run.save('Shared counters: increment atomically.')).toHaveProperty('id');
    expect(await run.complete('')).toMatchObject({completed:true});
    expect(await run.call('myco_run',{op:'report',action:'extract',summary:'Learned from the session.',audit:RUN_AUDIT})).toMatchObject({recorded:true});
    expect(await endLeasedRun(run.env,{principal:run.principal,now:NOW+DAY+3},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,status:'completed',
    })).toMatchObject({status:'completed'});
  });
});

it('repairs card refusals through the next named call without losing assigned turns', async () => {
  await withDocumentStores(async db => {
    const keys = [uuid(1301),uuid(1302)];
    const run = await cardRun(db,keys.map((id,index) => ({id,text:'Repair capture delivery '+index,at:10+index})));
    const unread = JSON.parse((await run.raw({op:'write',cards:[]})).content[0]!.text) as {error:string};
    expect(unread.error).toContain('Next call: myco_run_cards {"op":"material","page":1');
    const material = await run.material();
    const check = async (cards: unknown, detail: string) => {
      const result = JSON.parse((await run.raw({op:'write',revision:material.revision,cards})).content[0]!.text) as {ok:boolean;error:string};
      expect(result.ok).toBe(false);
      expect(result.error).toContain(detail);
      expect(result.error).toContain('Next call: myco_run_cards {"op":"write"');
      expect(await db.prepare("SELECT COUNT(*) AS n FROM turn_cards WHERE state='carded'").first()).toEqual({n:0});
    };
    await check([],keys[0]!);
    await check([{signal:'high',card:EMPTY_CARD}],'cards[0].turns');
    await check([{turns:[keys[0],keys[0]],signal:'high',card:EMPTY_CARD}],keys[0]!);
    await check([{turns:[keys[0]],signal:'high',card:{...EMPTY_CARD,corrections:null}}],'corrections');
    await check([{turns:[keys[0]],signal:'high',card:{...EMPTY_CARD,outcome:[]}}],'expected a string');
    const past = await run.material({page:material.page+1,revision:material.revision});
    expect(past.error).toContain('the last valid page is');
    expect(past.error).toContain('Next call: myco_run_cards {"op":"write"');
    const good = JSON.parse((await run.raw({op:'write',revision:material.revision,cards:keys.map(key => ({turns:[key],signal:'high',card:EMPTY_CARD}))})).content[0]!.text);
    expect(good).toMatchObject({written:2});
  });
});
