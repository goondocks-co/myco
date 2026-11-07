import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { isSelectStatement } from '../../core/sql-statements.js';
import { checkLikePattern, checkStatement } from './limits.js';

export type BindValue = string | number | null | Uint8Array;
export type StatementKind = 'read' | 'write' | 'assertion';
declare const boundType: unique symbol;

/** Store-free bindings; preparation always uses the decorated store supplied to execution. */
export interface Bound<Row = unknown, Kind extends StatementKind = StatementKind> {
  readonly name: string;
  readonly kind: Kind;
  readonly [boundType]: Row;
}

export interface StatementOptions {
  readonly name: string;
  readonly sql: string;
  /** One-based slots containing final escaped, wildcard-wrapped LIKE patterns. */
  readonly like?: readonly number[];
}

export interface Statement<Params extends readonly BindValue[], Row, Kind extends StatementKind> {
  readonly name: string;
  readonly kind: Kind;
  bind(...values: Params): Bound<Row, Kind>;
}

const names = new Set<string>();
const bindings = new WeakMap<Bound, { sql: string; values: readonly BindValue[] }>();

function define<Params extends readonly BindValue[], Row, Kind extends StatementKind>(
  kind: Kind, options: StatementOptions,
): Statement<Params, Row, Kind> {
  const { name, sql } = options;
  if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(name)) throw new Error('statement name must be a fixed family.operation identifier');
  if (names.has(name)) throw new Error(`duplicate statement name: ${name}`);
  const slots = checkStatement(sql);
  if (kind !== 'assertion' && isSelectStatement(sql) !== (kind === 'read')) throw new Error(`${name}: SQL does not match ${kind} kind`);
  const like = [...(options.like ?? [])];
  if (like.some(slot => !Number.isSafeInteger(slot) || slot < 1 || slot > slots)) throw new Error(`${name}: LIKE slot is outside the statement's bind slots`);
  names.add(name);
  return Object.freeze({
    name, kind,
    bind(...values: Params): Bound<Row, Kind> {
      if (values.length !== slots) throw new Error(`${name}: received ${values.length} bindings; expected ${slots} slots`);
      const captured = values.map(value => {
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
        if (value instanceof Uint8Array) return new Uint8Array(value);
        throw new Error(`${name}: bindings must be strings, finite numbers, null or Uint8Array`);
      });
      for (const slot of like) checkLikePattern(captured[slot - 1], slot);
      const bound = Object.freeze({ name, kind }) as Bound<Row, Kind>;
      bindings.set(bound, { sql, values: captured });
      return bound;
    },
  });
}

export const read = <Params extends readonly BindValue[], Row>(options: StatementOptions): Statement<Params, Row, 'read'> => define('read', options);
export const write = <Params extends readonly BindValue[], Row = never>(options: StatementOptions): Statement<Params, Row, 'write'> => define('write', options);

/** Families define aborting SQL once; callers compose only its validated Bound values. */
export const assertion = <Params extends readonly BindValue[]>(options: StatementOptions): Statement<Params, unknown, 'assertion'> => define('assertion', options);

/** Internal compilation keeps prepared-statement identity within the supplied store's decorators. */
export function prepareBound(db: RelationalStore, bound: Bound): PreparedStatement {
  const held = bindings.get(bound);
  if (held === undefined) throw new Error('execution requires a Bound created by a statement definition');
  return db.prepare(held.sql).bind(...held.values.map(value => value instanceof Uint8Array ? new Uint8Array(value) : value));
}
