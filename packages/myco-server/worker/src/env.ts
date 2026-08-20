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

export interface StoredObjectLike {
  size: number;
}

export interface BlobPutOptions {
  sha256?: string;
  httpMetadata?: { contentType?: string };
}

/** The blob store: content-addressed objects under project-prefixed keys. */
export interface BlobStoreLike {
  head(key: string): Promise<StoredObjectLike | null>;
  put(key: string, value: ReadableStream | null, options?: BlobPutOptions): Promise<StoredObjectLike>;
  delete(key: string): Promise<void>;
}

export interface Env {
  MYCO_DB: D1Like;
  BUCKET: BlobStoreLike;
  SOURCE_LIMIT: RateLimiter;
  TOKEN_LIMIT: RateLimiter;
}
