import type { BlobStore, PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';

export interface ContentUsage { statements: number; roundTrips: number; blobCalls: number }
export const CONTENT_STATEMENT_LIMIT = 120;
export const CONTENT_BLOB_LIMIT = 60;
export const CONTENT_WALL_MS = 2000;
export const CONTENT_PREPARATION_CALL_RESERVE = 40;
export const CONTENT_WAKE_JOB_RESERVE = 150;
interface BudgetScope { usage:ContentUsage;statements:number;blobCalls:number;deadline:number }
const scopes = new WeakMap<RelationalStore, BudgetScope[]>();

/** The remaining admission of a caller that owns a finite invocation budget. */
export function remainingInvocationBudget(db:RelationalStore):{statements:number;blobCalls:number;wallMs:number}|null {
  const held=scopes.get(db);
  if(held===undefined||held.length===0) return null;
  return {
    statements:Math.min(...held.map(scope=>Math.max(0,scope.statements-scope.usage.statements))),
    blobCalls:Math.min(...held.map(scope=>Math.max(0,scope.blobCalls-scope.usage.blobCalls))),
    wallMs:Math.min(...held.map(scope=>Math.max(0,scope.deadline-Date.now()))),
  };
}

/** Remaining admission from every enclosing invocation owner. */
export function remainingContentBudget(db:RelationalStore):{statements:number;blobCalls:number;wallMs:number} {
  const held=remainingInvocationBudget(db);
  return {
    statements:Math.min(CONTENT_STATEMENT_LIMIT,held?.statements??CONTENT_STATEMENT_LIMIT),
    blobCalls:Math.min(CONTENT_BLOB_LIMIT,held?.blobCalls??CONTENT_BLOB_LIMIT),
    wallMs:Math.min(CONTENT_WALL_MS,held?.wallMs??CONTENT_WALL_MS),
  };
}

/** Counts actual operations and refuses a new operation before it exceeds its admission. */
export function measuredContentEnv<T extends Pick<ServerEnv,'db'|'blobs'>>(env: T, limits?: { statements: number; blobCalls: number;wallMs?:number }): {
  env: T; usage: ContentUsage;
} {
  const usage: ContentUsage = { statements: 0, roundTrips: 0, blobCalls: 0 };
  const sql = (count: number) => {
    if (limits && usage.statements+count>limits.statements) throw new Error('content_statement_budget_exhausted');
    usage.statements+=count; usage.roundTrips++;
  };
  const blob = () => {
    if (limits && usage.blobCalls+1>limits.blobCalls) throw new Error('content_blob_budget_exhausted');
    usage.blobCalls++;
  };
  const statements = new WeakMap<PreparedStatement,PreparedStatement>();
  const wrap = (statement: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: async <R,>() => { sql(1); return statement.first<R>(); },
      all: async <R,>() => { sql(1); return statement.all<R>(); },
      run: async () => { sql(1); return statement.run(); },
    };
    statements.set(wrapped,statement);return wrapped;
  };
  const db: RelationalStore = {
    prepare: text => wrap(env.db.prepare(text)),
    batch: async selected => { sql(selected.length);return env.db.batch(selected.map(statement=>{
      const held=statements.get(statement);if(held===undefined) throw new Error('content batch statement belongs to another store');return held;
    })); },
  };
  scopes.set(db,[...(scopes.get(env.db)??[]),...(limits ? [{usage,statements:limits.statements,
    blobCalls:limits.blobCalls,deadline:limits.wallMs===undefined?Number.POSITIVE_INFINITY:Date.now()+limits.wallMs}] : [])]);
  const blobs: BlobStore = {
    head: async key => { blob();return env.blobs.head(key); },
    get: async (key,options) => { blob();return env.blobs.get(key,options); },
    put: async (key,value,options) => { blob();return env.blobs.put(key,value,options); },
    delete: async key => { blob();return Reflect.apply(env.blobs.delete,env.blobs,[key]); },
    ...(env.blobs.ensureDurable ? { ensureDurable: async (key:string) => { blob();return env.blobs.ensureDurable!(key); } } : {}),
  };
  return { env: { ...env,db,blobs },usage };
}
