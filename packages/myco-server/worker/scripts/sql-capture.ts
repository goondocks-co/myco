import type { RelationalStore } from '../src/core/adapters.ts';

const literal = (v: unknown): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/** A `RelationalStore` that executes nothing and renders each bound statement as literal SQL for `wrangler d1 execute`. */
export function sqlCapture(): { db: RelationalStore; statements: string[] } {
  const statements: string[] = [];
  const db: RelationalStore = {
    prepare: (text: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => { let i = 0; statements.push(text.replace(/\?/g, () => literal(values[i++]))); return { results: [], meta: { changes: 1 } }; },
        first: async () => null,
        all: async () => ({ results: [] }),
        bind: () => { throw new Error('rebind unsupported'); },
      }),
      run: async () => ({ results: [], meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    batch: async () => { throw new Error('batch unsupported'); },
  };
  return { db, statements };
}
