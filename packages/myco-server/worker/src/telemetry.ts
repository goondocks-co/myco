export type ErrorClass = 'parse' | 'quota' | 'schema' | 'db' | 'unknown';

/** Raised when the database reports a schema version other than this build's. */
export class SchemaMismatchError extends Error {
  constructor(readonly expected: number, readonly found: string | null) {
    super('schema version mismatch');
    this.name = 'SchemaMismatchError';
  }
}

export function classify(err: unknown): ErrorClass {
  if (err instanceof SyntaxError || err instanceof RangeError) return 'parse';
  if (err instanceof SchemaMismatchError) return 'schema';
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('member_tokens_quota')) return 'quota';
  if (message.startsWith('D1_ERROR')) return 'db';
  return 'unknown';
}

/** Emits a structured event. Values must be classifiers or server-issued identifiers, never request content. */
export function emit(event: { kind: string; [key: string]: unknown }): void {
  console.log(JSON.stringify(event));
}
