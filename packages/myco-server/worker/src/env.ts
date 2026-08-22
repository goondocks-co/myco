export interface D1RunResult {
  results: unknown[];
  meta: { changes: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
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

/** A stored object plus its bytes. A structural subset of R2's `R2ObjectBody`, so the compile-time proof in `platform/cloudflare.ts` still holds. */
export interface StoredObjectBodyLike extends StoredObjectLike {
  body: ReadableStream;
}

export interface BlobPutOptions {
  sha256?: string;
  httpMetadata?: { contentType?: string };
}

/** The blob store: content-addressed objects under project-prefixed keys. */
export interface BlobStoreLike {
  head(key: string): Promise<StoredObjectLike | null>;
  get(key: string): Promise<StoredObjectBodyLike | null>;
  put(key: string, value: ReadableStream | null, options?: BlobPutOptions): Promise<StoredObjectLike>;
  delete(key: string): Promise<void>;
}

export interface Env {
  MYCO_DB: D1Like;
  BUCKET: BlobStoreLike;
  SOURCE_LIMIT: RateLimiter;
  TOKEN_LIMIT: RateLimiter;
  /** The owner's numeric GitHub account id, supplied at deploy. Absent ⇒ no human route answers. */
  OWNER_GITHUB_ID?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}
