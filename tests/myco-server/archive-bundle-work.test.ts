import { expect,it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';



import { storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';



import { sqliteEnv } from './helpers/fixtures.js';

type Captured={sql:string;params:unknown[]};
const PROJECT='proj_1';









function plan(sqlite:Database,entry:Captured):string {
  return (sqlite.query(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.params as never[]) as {detail:string}[])
    .map(row=>row.detail).join('\n');
}

function sqlLiteral(value:unknown):string {
  if(value===null)return 'NULL';
  if(typeof value==='number')return String(value);
  if(typeof value==='string')return `'${value.replaceAll("'","''")}'`;
  throw new Error('unsupported test parameter');
}

async function vmSteps(sqlite:Database,entry:Captured):Promise<number> {
  const executable=process.env.MYCO_SQLITE_VM_PYTHON==='1'?null:
    existsSync('/usr/bin/sqlite3')?'/usr/bin/sqlite3':Bun.which('sqlite3');
  const dir=await mkdtemp(join(tmpdir(),'myco-bundle-work-'));
  try {
    const file=join(dir,'work.sqlite');
    await writeFile(file,sqlite.serialize());
    let index=0;
    const sql=entry.sql.replaceAll('?',()=>sqlLiteral(entry.params[index++]));
    expect(index).toBe(entry.params.length);
    if(executable){
      const result=Bun.spawnSync([executable,'-cmd','.stats on',file,sql],{stdout:'pipe',stderr:'pipe'});
      if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
      const steps=/Virtual Machine Steps:\s+(\d+)/.exec(new TextDecoder().decode(result.stdout));
      if(!steps)throw new Error('sqlite3 VM statistics unavailable');
      return Number(steps[1]);
    }
    const python=Bun.which('python3')??Bun.which('python');
    if(!python)throw new Error('SQLite VM work reader unavailable');
    const script=`import sqlite3, sys
from pathlib import Path
db = sqlite3.connect(':memory:')
db.deserialize(Path(sys.argv[1]).read_bytes())
db.execute('SELECT 1').fetchone()
steps = 0
def progress():
    global steps
    steps += 1
    return 0
db.set_progress_handler(progress, 1)
db.execute(sys.argv[2])
print(steps)`;
    const result=Bun.spawnSync([python,'-c',script,file,sql],{stdout:'pipe',stderr:'pipe'});
    if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
    const steps=Number(new TextDecoder().decode(result.stdout).trim());
    if(!Number.isSafeInteger(steps))throw new Error('Python SQLite VM statistics unavailable');
    return steps;
  } finally { await rm(dir,{recursive:true,force:true}); }
}

it('deletes cleanup queue identities by key even with unrelated queued history',async()=>{
  const rig=sqliteEnv();
  try {
    await storageCleanup(rig.serverEnv,1000);
    const sql=rig.executed.find(text=>text.startsWith('DELETE FROM storage_cleanup_queue WHERE rowid IN'));
    expect(sql).toBeDefined();
    rig.sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<30000)
      INSERT INTO storage_cleanup_queue(project_id,resource_kind,resource_id,session_id)
      SELECT '${PROJECT}','event','noise-'||x,'sess' FROM n`);
    rig.sqlite.exec('ANALYZE');
    const entries=Array.from({length:20},(_,i)=>({project_id:PROJECT,resource_kind:'event',resource_id:`old-${i}`}));
    const empty={sql:sql!,params:['[]']};
    const twenty={sql:sql!,params:[JSON.stringify(entries)]};
    expect(plan(rig.sqlite,twenty)).toMatch(/SEARCH q USING COVERING INDEX sqlite_autoindex_storage_cleanup_queue_1 \(project_id=\? AND resource_kind=\? AND resource_id=\?\)/);
    const steps=await Promise.all([empty,twenty].map(entry=>vmSteps(rig.sqlite,entry)));
    expect(steps[0]).toBeLessThan(500);
    expect(steps[1]).toBeLessThan(5_000);
  } finally {rig.sqlite.close();}
});
