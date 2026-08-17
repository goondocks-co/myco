export interface D1RunResult {
  results: unknown[];
  meta: { changes: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1RunResult[]>;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  MYCO_DB: D1Like;
  SOURCE_LIMIT: RateLimiter;
  TOKEN_LIMIT: RateLimiter;
}
