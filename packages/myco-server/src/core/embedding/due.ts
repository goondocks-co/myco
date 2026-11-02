import type { RelationalStore } from '../adapters.js';
import { embeddingDueInsert } from '../../db/embedding-due.js';
import { WORK_SWEEP_PAGE } from './work-state.js';

/** Initializes one page of a model's due identities; subsequent mutations maintain them in their own transaction. */
export async function prepareEmbeddingDue(db: RelationalStore, projectId: string, model: string): Promise<{more:boolean;ready:boolean}> {
  await db.prepare(`INSERT INTO embedding_models(project_id,model_key) VALUES(?,?) ON CONFLICT DO NOTHING`).bind(projectId,model).run();
  const current = () => db.prepare('SELECT scan_type,scan_id,complete,active FROM embedding_models WHERE project_id=? AND model_key=?')
    .bind(projectId,model).first<{scan_type:string;scan_id:string;complete:number;active:number}>();
  let read = await current();
  if (read === null) throw new Error('embedding_model_absent');
  if (read.active === 0) {
    await db.batch([
      db.prepare(`DELETE FROM embedding_due WHERE rowid IN (SELECT rowid FROM embedding_due WHERE project_id=? AND model_key=? AND
        (SELECT active FROM embedding_models WHERE project_id=? AND model_key=?)=0 LIMIT ?)`)
        .bind(projectId,model,projectId,model,WORK_SWEEP_PAGE),
      db.prepare(`UPDATE embedding_models SET active=1,complete=0,scan_type='',scan_id='' WHERE project_id=? AND model_key=? AND active=0
        AND NOT EXISTS(SELECT 1 FROM embedding_due WHERE project_id=? AND model_key=?)`).bind(projectId,model,projectId,model),
    ]);
    read = await current();
    if (read === null) throw new Error('embedding_model_absent');
    if (read.active === 0) return {more:true,ready:false};
  }
  if (read.complete === 1) return {more:false,ready:true};
  const page = (await db.prepare(`SELECT type,record_id FROM embedding_versions WHERE project_id=? AND (type,record_id)>(?,?)
    ORDER BY type,record_id LIMIT ?`).bind(projectId,read.scan_type,read.scan_id,WORK_SWEEP_PAGE).all<{ type: string; record_id: string }>()).results;
  const last = page.at(-1);
  const guard = `EXISTS(SELECT 1 FROM embedding_models WHERE project_id=? AND model_key=? AND scan_type=? AND scan_id=? AND complete=0)`;
  await db.batch([
    db.prepare(embeddingDueInsert(`k.model_key=? AND v.project_id=? AND (v.type,v.record_id)>(?,?) AND (v.type,v.record_id)<=(?,?) AND ${guard}`))
      .bind(model,projectId,read.scan_type,read.scan_id,last?.type ?? '',last?.record_id ?? '',projectId,model,read.scan_type,read.scan_id),
    db.prepare(`UPDATE embedding_models SET scan_type=?,scan_id=?,complete=? WHERE project_id=? AND model_key=? AND scan_type=? AND scan_id=? AND complete=0`)
      .bind(last?.type ?? read.scan_type,last?.record_id ?? read.scan_id,page.length < WORK_SWEEP_PAGE ? 1 : 0,projectId,model,read.scan_type,read.scan_id),
  ]);
  return {more:page.length === WORK_SWEEP_PAGE,ready:true};
}

/** Inactive models receive no new due identities; reactivation resets their cache within the page budget. */
export async function retainEmbeddingModels(db:RelationalStore,projectId:string,models:readonly string[]):Promise<void> {
  await db.prepare(`UPDATE embedding_models SET active=0 WHERE project_id=? AND active=1 AND model_key NOT IN(SELECT value FROM json_each(?))`)
    .bind(projectId,JSON.stringify(models)).run();
}
