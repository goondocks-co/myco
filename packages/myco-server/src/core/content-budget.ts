import type { BlobStore, PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';

export interface ContentUsage {
  statements: number;
  roundTrips: number;
  blobCalls: number;
}
export const CONTENT_STATEMENT_LIMIT = 120;
export const CONTENT_BLOB_LIMIT = 60;
export const CONTENT_WALL_MS = 2000;
export const CONTENT_PREPARATION_CALL_RESERVE = 40;
export const CONTENT_WAKE_JOB_RESERVE = 150;
interface BudgetScope {
  usage: ContentUsage;
  statements: number;
  blobCalls: number;
  deadline: number;
}
const scopes = new WeakMap<RelationalStore, BudgetScope[]>();

/** The remaining admission of a caller that owns a finite invocation budget. */
export function remainingInvocationBudget(
  db: RelationalStore,
): { statements: number; blobCalls: number; wallMs: number } | null {
  const held = scopes.get(db);
  if (held === undefined || held.length === 0) return null;
  return {
    statements: Math.min(...held.map((scope) => Math.max(0, scope.statements - scope.usage.statements))),
    blobCalls: Math.min(...held.map((scope) => Math.max(0, scope.blobCalls - scope.usage.blobCalls))),
    wallMs: Math.min(...held.map((scope) => Math.max(0, scope.deadline - Date.now()))),
  };
}

/** Remaining admission from every enclosing invocation owner. */
export function remainingContentBudget(db: RelationalStore): { statements: number; blobCalls: number; wallMs: number } {
  const held = remainingInvocationBudget(db);
  return {
    statements: Math.min(CONTENT_STATEMENT_LIMIT, held?.statements ?? CONTENT_STATEMENT_LIMIT),
    blobCalls: Math.min(CONTENT_BLOB_LIMIT, held?.blobCalls ?? CONTENT_BLOB_LIMIT),
    wallMs: Math.min(CONTENT_WALL_MS, held?.wallMs ?? CONTENT_WALL_MS),
  };
}

/** Counts actual operations and refuses a new operation before it exceeds its admission. */
export function measuredContentEnv<T extends { db: RelationalStore; blobs?: BlobStore }>(
  env: T,
  limits?: { statements: number; blobCalls: number; wallMs?: number; calls?: number; enforceWall?: boolean; ownWall?: boolean },
): {
  env: T;
  usage: ContentUsage;
  batch: RelationalStore['batch'];
} {
  const usage: ContentUsage = { statements: 0, roundTrips: 0, blobCalls: 0 };
  const deadline = limits?.wallMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + limits.wallMs;
  const call = () => {
    if (limits?.enforceWall === true && Date.now() >= deadline) throw new Error('content_wall_budget_exhausted');
    if (limits?.calls !== undefined && usage.roundTrips + usage.blobCalls + 1 > limits.calls)
      throw new Error('content_call_budget_exhausted');
  };
  const sql = (count: number) => {
    call();
    if (limits && usage.statements + count > limits.statements) throw new Error('content_statement_budget_exhausted');
    usage.statements += count;
    usage.roundTrips++;
  };
  const blob = () => {
    call();
    if (limits && usage.blobCalls + 1 > limits.blobCalls) throw new Error('content_blob_budget_exhausted');
    usage.blobCalls++;
  };
  const statements = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: async <R>() => {
        sql(1);
        return statement.first<R>();
      },
      all: async <R>() => {
        sql(1);
        return statement.all<R>();
      },
      run: async () => {
        sql(1);
        return statement.run();
      },
    };
    statements.set(wrapped, statement);
    return wrapped;
  };
  const db: RelationalStore = {
    prepare: (text) => wrap(env.db.prepare(text)),
    batch: async (selected) => {
      sql(selected.length);
      return env.db.batch(
        selected.map((statement) => {
          const held = statements.get(statement);
          if (held === undefined) throw new Error('content batch statement belongs to another store');
          return held;
        }),
      );
    },
  };
  // An own wall replaces the enclosing owners' deadlines; their statement and blob admission still holds.
  scopes.set(db, [
    ...(scopes.get(env.db) ?? []).map((scope) => (limits?.ownWall === true ? { ...scope, deadline: Number.POSITIVE_INFINITY } : scope)),
    ...(limits ? [{ usage, statements: limits.statements, blobCalls: limits.blobCalls, deadline }] : []),
  ]);
  const original = env.blobs;
  const blobs: BlobStore | undefined =
    original === undefined
      ? undefined
      : {
          head: async (key) => {
            blob();
            return original.head(key);
          },
          get: async (key, options) => {
            blob();
            return original.get(key, options);
          },
          put: async (key, value, options) => {
            blob();
            return original.put(key, value, options);
          },
          delete: async (key) => {
            blob();
            return Reflect.apply(original.delete, original, [key]);
          },
          ...(original.ensureDurable
            ? {
                ensureDurable: async (key: string) => {
                  blob();
                  return original.ensureDurable!(key);
                },
              }
            : {}),
        };
  return {
    env: { ...env, db, ...(blobs === undefined ? {} : { blobs }) },
    usage,
    batch: async (selected) => {
      sql(selected.length);
      return env.db.batch(selected);
    },
  };
}
