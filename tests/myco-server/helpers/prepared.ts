import type { PrepareOutcome, PreparedDispatch } from '@myco-server-worker/core/harness.js';

/**
 * The dispatch a prepare produced, narrowed through the outcome's own
 * discriminant. A refusal throws with the refusal in the message, so a test
 * that expected a prepared dispatch names what it got instead.
 */
export function prepared(outcome: PrepareOutcome): PreparedDispatch {
  if (!outcome.ok) {
    throw new Error(`prepareDispatch refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.prepared;
}

export async function explainReadPlan(db: import('@myco-server-worker/core/adapters.js').RelationalStore, query: {sql:string;binds:readonly unknown[]}): Promise<{id:number;parent:number;detail:string}[]> {
  return (await db.prepare('EXPLAIN QUERY PLAN '+query.sql).bind(...query.binds).all<{id:number;parent:number;detail:string}>()).results;
}

export function beforeWriteBatch(db: import('@myco-server-worker/core/adapters.js').RelationalStore, matches:(sql:string)=>boolean, before:()=>Promise<void>, once=false) {
  const statements=new WeakMap<import('@myco-server-worker/core/adapters.js').PreparedStatement,{raw:import('@myco-server-worker/core/adapters.js').PreparedStatement;sql:string}>();
  let armed=true;
  const wrap=(raw:import('@myco-server-worker/core/adapters.js').PreparedStatement,sql:string):import('@myco-server-worker/core/adapters.js').PreparedStatement=>{
    const statement={bind:(...values:unknown[])=>wrap(raw.bind(...values),sql),first:<T>()=>raw.first<T>(),all:<T>()=>raw.all<T>(),run:()=>raw.run()};
    statements.set(statement,{raw,sql});return statement;
  };
  return {prepare:(sql:string)=>wrap(db.prepare(sql),sql),batch:async(selected:import('@myco-server-worker/core/adapters.js').PreparedStatement[])=>{
    const held=selected.map(statement=>{const value=statements.get(statement);if(!value)throw new Error('fixture statement belongs to another store');return value;});
    if(armed&&held.some(value=>matches(value.sql))){if(once)armed=false;await before();}
    return db.batch(held.map(value=>value.raw));
  }};
}
