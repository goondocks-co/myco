import { wordVectorProvider } from '../embedding/word-vectors.ts';
import { revisionHeaders } from '../settings-revision.ts';
import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { allowWorkerClaims, endRun, mcp, owner, putSetting, runTool } from '../clients/requests.ts';
import { dispatch, takeRun } from '../clients/runs.ts';
import { withRecallSettings } from '../clients/capture.ts';
import { offerCurationGroup, curationMembers } from '../clients/curation.ts';

export const sporeCuration: ParityScenario = {
  name: 'spore curation: one checked answer previews and applies a split with complete lineage',
  dedicated: { cloudflare: { embeddingFixture: true }, sqliteVec: true, timeoutMs: 180_000 },
  async run(target) {
    const provider=target.name==='selfhosted'?wordVectorProvider():null;
    try { await withRecallSettings(target, async()=>{
      expect((await owner(target,'/api/embedding',{method:'PUT',headers:await revisionHeaders(target,'/api/embedding'),
        body:JSON.stringify(provider===null?{provider:'workers-ai',model:'@cf/baai/bge-m3'}:{provider:'ollama',model:'parity-words',endpoint:provider.origin})})).status).toBe(200);
      await allowWorkerClaims(target);
      expect((await putSetting(target,'agent.scheduled_tasks_enabled',false)).status).toBe(200);
      await offerCurationGroup(target);
      const queued=await dispatch(target,'curate-spores',{dryRun:true});
      const preview=await takeRun(target,queued.runId);
      expect(preview.task).toBe('curate-spores');
      const material=curationMembers(preview);
      const split=material.find(member=>member.content.split('\n').length>=2);
      if(split===undefined)throw new Error('The offered group has no multi-situation member');
      const sources=[split.id];
      const notes=split.content.split('\n').slice(-2).map(content=>({sources,observation_type:'gotcha',agent_line:content,content}));
      const answer={op:'answer',notes,keep:material.filter(member=>member.id!==split.id).map(member=>member.id),retire:[],reason:'Split the multi-situation member and retained the other guidance.'};
      expect(await runTool(target,preview,'myco_run_curation',answer)).toMatchObject({completed:true,applied:false});
      const path='/api/projects/'+target.projectId+'/curation/answers/';
      const checked=await owner(target,path+preview.id);
      expect(checked).toMatchObject({status:200,body:{applied:false,checked:{answer:{notes}}}});
      for(const id of sources)expect(await mcp(target,'myco_spores',{op:'get',id})).toMatchObject({status:'active',superseded_by:[]});
      expect(await endRun(target,preview)).toMatchObject({status:'completed'});
      const run=await takeRun(target);
      expect(await runTool(target,run,'myco_run_curation',{...answer,notes:[{...notes[0],sources:['missing-prefix']}]})).toMatchObject({ok:false});
      const result=await runTool<{notes:{id:string;observed:string}[]}>(target,run,'myco_run_curation',answer);
      expect(await endRun(target,run)).toMatchObject({status:'completed'});
      for(const id of sources){
        const read=await mcp(target,'myco_spores',{op:'get',id});
        expect(read.status).toBe('consolidated');
        expect((read.superseded_by as string[]).sort()).toEqual(result.notes.map(note=>note.id).sort());
        const page=await owner(target,'/api/projects/'+target.projectId+'/spores/'+id);
        expect(page.body.supersededBy.sort()).toEqual(result.notes.map(note=>note.id).sort());
      }
      expect((await owner(target,path+run.id)).body.applied).toBe(true);
      const undoPath='/api/projects/'+target.projectId+'/curation/'+run.id+'/undo';
      const undoPreview=await owner(target,'/api/projects/'+target.projectId+'/spores/'+result.notes[0]!.id+'/curation');
      expect(undoPreview).toMatchObject({status:200,body:{curation:{unit:{id:run.id},blocker:null}}});
      const denied=await fetch(target.url+undoPath,{method:'POST',headers:{...target.memberHeaders(),origin:target.url,'content-type':'application/json'},body:'{}'});
      expect(denied.status).toBe(401);
      expect(await owner(target,undoPath,{method:'POST',body:'{}'})).toMatchObject({status:200,body:{ok:true}});
      for(const id of sources)expect(await mcp(target,'myco_spores',{op:'get',id})).toMatchObject({status:'active',superseded_by:[],resolution:{action:'restore',reason:expect.stringContaining('Curation undone by')}});
      for(const {id} of result.notes)expect(await mcp(target,'myco_spores',{op:'get',id})).toMatchObject({status:'obsolete',predecessors:sources});
      expect(await owner(target,undoPath,{method:'POST',body:'{}'})).toMatchObject({status:409,body:{message:expect.stringContaining('already undone')}});
    }); } finally { provider?.stop(); }
  },
};
