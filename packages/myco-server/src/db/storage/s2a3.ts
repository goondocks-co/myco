import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

const archive = write<[number,string,string],{project_id:string}>({name:'storage.archiveProject',sql:
  'UPDATE projects SET archived_at=?,archived_by=? WHERE project_id=? AND archived_at IS NULL RETURNING project_id'});
const rename = write<[string,string],{project_id:string}>({name:'storage.renameProject',sql:
  'UPDATE projects SET name=? WHERE project_id=? RETURNING project_id'});
const exists = read<[string],{project_id:string}>({name:'storage.projectForArchive',sql:'SELECT project_id FROM projects WHERE project_id=?'});
export async function archiveProject(db:RelationalStore,projectId:string,by:string,nowMs:number):Promise<'archived'|'already_archived'|'absent'> {
  const [result]=await commit(db,archive.bind(nowMs,by,projectId));
  if(result.results.length>0)return 'archived';
  const [rows]=await readSet(db,exists.bind(projectId));
  return rows.length>0?'already_archived':'absent';
}
export async function renameProject(db:RelationalStore,projectId:string,name:string):Promise<'renamed'|'absent'> {
  const [result]=await commit(db,rename.bind(name,projectId));
  return result.results.length>0?'renamed':'absent';
}
