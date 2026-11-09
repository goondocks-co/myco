import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { isSelectStatement } from '../../core/sql-statements.js';
import { checkLikePattern, checkStatement } from './limits.js';
import { abortSql, type RefusalCode } from './refusal.js';

export type BindValue = string | number | null | Uint8Array;
type StatementKind = 'read' | 'write' | 'assertion';
declare const boundType: unique symbol;

/** Store-free bindings; preparation always uses the decorated store supplied to execution. */
export interface Bound<Row = unknown, Kind extends StatementKind = StatementKind> {
  readonly name: string;
  readonly kind: Kind;
  readonly [boundType]: Row;
}

interface StatementOptions {
  readonly name: string;
  readonly sql: string;
  /** One-based slots containing final escaped, wildcard-wrapped LIKE patterns. */
  readonly like?: readonly number[];
}

export interface Statement<Params extends readonly unknown[], Row, Kind extends StatementKind> {
  readonly name: string;
  readonly kind: Kind;
  bind(...values: Params): Bound<Row, Kind>;
}

const definitions = new Map<string, string>();
const bindings = new WeakMap<Bound, { sql: string; values: readonly BindValue[] }>();

function define<Params extends readonly unknown[], Row, Kind extends StatementKind>(
  kind: Kind, options: StatementOptions,
): Statement<Params, Row, Kind> {
  const { name, sql } = options;
  if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(name)) throw new Error('statement name must be a fixed family.operation identifier');
  if (definitions.has(name)) throw new Error(`duplicate statement name: ${name}`);
  const like = [...(options.like ?? [])];
  const validate = (text: string) => {
    const slots = checkStatement(text);
    if (kind !== 'assertion' && isSelectStatement(text) !== (kind === 'read')) throw new Error(`${name}: SQL does not match ${kind} kind`);
    if (like.some(slot => !Number.isSafeInteger(slot) || slot < 1 || slot > slots)) throw new Error(`${name}: LIKE slot is outside the statement's bind slots`);
    return slots;
  };
  if (typeof sql !== 'string') throw new Error(`${name}: statement SQL must be fixed at definition`);
  const slots = validate(sql);
  definitions.set(name, sql);
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

/** The SQL of every statement defined so far, by name: what the schema gate prepares against the final schema. */
export const definedStatements = (): ReadonlyMap<string, string> => definitions;

export const read = <Params extends readonly unknown[], Row>(options: StatementOptions): Statement<Params, Row, 'read'> => define('read', options);
export const write = <Params extends readonly unknown[], Row = never>(options: StatementOptions): Statement<Params, Row, 'write'> => define('write', options);

interface RefusalOptions {
  readonly name: string;
  /** SQL that is true while the batch may proceed. */
  readonly when: string;
  readonly refusal: RefusalCode;
  /** SQL reported with the refusal and read back through `refusalDetail`. */
  readonly detail?: string;
  /** A leading `WITH` clause and the row source it feeds, for a predicate over shared inputs. A source with no rows refuses. Use numbered slots: `from` is read twice. */
  readonly with?: string;
  readonly from?: string;
}

const refusalSql = ({ when, refusal, detail, with: inputs, from }: RefusalOptions): string =>
  `${inputs === undefined ? '' : `${inputs} `}SELECT CASE WHEN ${when} THEN 1 ELSE ${abortSql(refusal, detail)} END AS admitted${from === undefined ? ''
    : ` FROM ${from} UNION ALL SELECT ${abortSql(refusal)} WHERE NOT EXISTS(SELECT 1 FROM ${from})`}`;

/** Stops the whole batch with a named refusal unless `when` holds; callers identify it with `refused`. */
export const assertion = <Params extends readonly unknown[]>(options: StatementOptions | RefusalOptions): Statement<Params, unknown, 'assertion'> =>
  define('assertion', 'sql' in options ? options : { name: options.name, sql: refusalSql(options) });

/** Internal compilation keeps prepared-statement identity within the supplied store's decorators. */
export function prepareBound(db: RelationalStore, bound: Bound): PreparedStatement {
  const held = bindings.get(bound);
  if (held === undefined) throw new Error('execution requires a Bound created by a statement definition');
  return db.prepare(held.sql).bind(...held.values.map(value => value instanceof Uint8Array ? new Uint8Array(value) : value));
}
