import { expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { readBundleEntry } from '@myco-server-worker/core/archive-bundle.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

it.each([true,false])('releases an oversized input that an existing tool row does not adopt (success=%s)',async(success)=>{
  const rig=sqliteEnv();
  try {
    const now=Date.now();
    const issued=await issueMemberToken(rig.db,{memberId:'mem_machine_1',machineId:'machine_1'},now);
    const toolId=uuid(800);
    const ctx={projectId:'proj_1',machineId:'machine_1',tokenId:issued.tokenId,bodyBytes:0,now};
    const original={text:'original é🦋'.repeat(500)};
    const first=envelope({eventId:uuid(801),kind:'tool.use',payload:{toolCallId:toolId,toolName:'Read',input:original,success}});
    expect(await ingestEvent(rig.db,ctx,first,rig.serverEnv)).toMatchObject({persisted:true,projected:true});
    const adoptedObjects=[...rig.bucket.objects.keys()];
    expect(adoptedObjects).toHaveLength(2);
    const second=envelope({eventId:uuid(802),kind:'tool.use',payload:{toolCallId:toolId,toolName:'Read',
      input:{text:'different'.repeat(1000)},success:true}});
    expect(await ingestEvent(rig.db,ctx,second,rig.serverEnv)).toMatchObject(success
      ?{persisted:true,projected:false,code:'projection_conflict'}:{persisted:true,projected:true});
    expect(await ingestEvent(rig.db,ctx,first,rig.serverEnv)).toMatchObject({persisted:true,duplicate:true});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:0});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:1});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM registered_content_proofs').get()).toEqual({n:2});
    for(let pass=0;pass<8;pass++)await drainObjectReleases(rig.serverEnv,now);
    expect([...rig.bucket.objects.keys()].sort()).toEqual(adoptedObjects.sort());
    const row=rig.sqlite.query('SELECT input_bundle_id,input_bundle_entry FROM tool_calls WHERE project_id=? AND tool_call_id=?')
      .get('proj_1',toolId) as {input_bundle_id:number;input_bundle_entry:number};
    expect(await readBundleEntry(rig.serverEnv,{projectId:'proj_1',bundleId:row.input_bundle_id,
      entry:row.input_bundle_entry,kind:'tool-input',resourceId:toolId,tokenId:issued.tokenId})).toBe(JSON.stringify(original));
  } finally {rig.sqlite.close();}
});
