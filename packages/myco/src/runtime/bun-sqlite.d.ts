/**
 * Module augmentation to loosen bun:sqlite's Statement parameter typing.
 *
 * better-sqlite3 accepted `unknown[]` for bind parameters at the call site
 * (runtime checks only). bun:sqlite types the variadic params as the strict
 * `SQLQueryBindings[]` union, which doesn't accept values the compiler sees
 * as `unknown` even if they're fine at runtime.
 *
 * Rather than sprinkling casts across ~25 query-file call sites, loosen the
 * type surface here. Runtime behavior is unchanged — bun:sqlite still throws
 * at bind time if a value is actually invalid.
 */

declare module 'bun:sqlite' {
  interface Statement<ReturnType = unknown, ParamsType = unknown[]> {
    all(...params: unknown[]): ReturnType[];
    get(...params: unknown[]): ReturnType | undefined;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    values(...params: unknown[]): unknown[][];
    iterate(...params: unknown[]): IterableIterator<ReturnType>;
  }
}

export {};
