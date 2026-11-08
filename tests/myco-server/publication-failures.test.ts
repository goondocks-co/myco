import { expect, test } from 'bun:test';
import { withDocumentStores } from './helpers/document-stores.js';
import { publicationFailureHead, publicationFailureTotals } from '@myco-server-worker/db/documents/failure-head.js';

test('failure heads follow generation, tombstones, archive visibility and the newest remaining diagnostic', async () => {
  await withDocumentStores(async (db,target) => {
    await db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES('project','s','live',1,1)`).run();
    const fail=async(id:string,generation:number,at:number)=>db.prepare(`INSERT INTO transcript_publication
      (project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,state,failure,updated_at,diagnostic)
      VALUES('project',?,?,'s',0,'source-record-v1',6,'failed','event_refused',?,?)`).bind(id,generation,at,JSON.stringify({at})).run();
    await fail('a',1,10);await fail('b',1,20);await fail('a',2,30);
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:2,latest_at:20,failure:'event_refused'}});
    await db.prepare("UPDATE transcript_publication SET state='active' WHERE transcript_id='b'").run();
    expect(await publicationFailureTotals(db),target).toEqual({state:'ready',rows:[{project_id:'project',failure:'event_refused',transcripts:1,latest_at:10,diagnostic:'{"at":10}'}]});
    await db.prepare("UPDATE session_documents SET generation=2 WHERE session_id='s'").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:1,latest_at:30,failure:'event_refused'}});
    await db.prepare("UPDATE projects SET archived_at=1 WHERE project_id='project'").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:0,latest_at:null,failure:null}});
    await db.prepare("UPDATE projects SET archived_at=NULL WHERE project_id='project'").run();
    expect((await publicationFailureTotals(db)).state,target).toBe('ready');
    await db.prepare("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('project','s',50,'owner')").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:0,latest_at:null,failure:null}});
    await db.prepare("DELETE FROM session_tombstones WHERE project_id='project' AND session_id='s'").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:1,latest_at:30,failure:'event_refused'}});
    await db.prepare("UPDATE projection_catchup SET done=0 WHERE projection='publication_failures' AND phase='publicationFailures'").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'building'});
    expect(await publicationFailureTotals(db),target).toEqual({state:'building'});
    await db.prepare("UPDATE projection_catchup SET done=1 WHERE projection='publication_failures' AND phase='publicationFailures'").run();
    await db.prepare("DELETE FROM session_documents WHERE project_id='project' AND session_id='s'").run();
    expect(await publicationFailureHead(db),target).toEqual({state:'ready',head:{transcripts:0,latest_at:null,failure:null}});
  });
});
