import { THIN_LEARNING_ADMISSION_SQL } from '@myco-server-worker/db/thin-learning-admission.js';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult } from '@myco/server/runner.js';
import { schemaSqlite } from '../../myco-server/helpers/schema-template.js';

/** The fake D1's database: a private copy of the current schema in memory, or a file that holds one from its first use on. */
export function budgetD1Database(file=':memory:'):Database {
  if(file===':memory:')return schemaSqlite({foreignKeys:false});
  const db=new Database(file);
  if(db.query("SELECT name FROM sqlite_master WHERE name='schema_meta'").get()!==null)return db;
  db.close();
  const current=schemaSqlite({foreignKeys:false});
  try {fs.writeFileSync(file,current.serialize());}finally{current.close();}
  return new Database(file);
}

/** Admission and budget statements run against SQLite and use Wrangler's single-statement JSON envelope. */
export function budgetD1Reply(db:Database,sql:string):CommandResult|undefined {
  if(sql!==THIN_LEARNING_ADMISSION_SQL&&!/budget[._]|idx_attempts_claimed|idx_attempts_settled|idx_agent_runs_queue_head|SELECT COUNT\(\*\) AS n FROM agent_|origin IS NULL/.test(sql))return undefined;
  const results=db.query(sql).all();
  return {code:0,stdout:JSON.stringify([{results,success:true,meta:{duration:0}}]),stderr:''};
}

if(import.meta.main) {
  const sql=process.argv[process.argv.indexOf('--command')+1] ?? '';
  const home=process.env.MYCO_HOME;
  if(home===undefined)throw new Error('The fake D1 requires an isolated home');
  const db=budgetD1Database(path.join(home,'fixture-budget.sqlite'));
  try {console.log((budgetD1Reply(db,sql)??{stdout:JSON.stringify([{results:[],success:true}])}).stdout);}
  finally {db.close();}
}
