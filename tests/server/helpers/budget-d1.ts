import { Database } from 'bun:sqlite';
import path from 'node:path';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { CommandResult } from '@myco/server/runner.js';
let image:Uint8Array|undefined;

export function budgetD1Database(file=':memory:'):Database {
  if(file===':memory:'&&image!==undefined)return Database.deserialize(image);
  const db=new Database(file);
  if(db.query("SELECT name FROM sqlite_master WHERE name='schema_meta'").get()===null) {
    for(const step of SCHEMA_STEPS)for(const sql of step.statements)db.exec(sql);
  }
  if(file===':memory:')image=db.serialize();
  return db;
}

/** Budget statements run against SQLite and use Wrangler's single-statement JSON envelope. */
export function budgetD1Reply(db:Database,sql:string):CommandResult|undefined {
  if(!/budget[._]|idx_attempts_claimed|idx_attempts_settled|idx_agent_runs_queue_head|SELECT COUNT\(\*\) AS n FROM agent_|origin IS NULL/.test(sql))return undefined;
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
