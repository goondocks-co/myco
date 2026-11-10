/** One schema step: its version, its statements in order, and what it drops without putting back as it was. */
export interface SchemaStep {
  version: number;
  statements: readonly string[];
  /** What the step drops without putting back as it was, each with its reason. */
  retires?: readonly Retirement[];
}

/**
 * A schema object a step drops without putting it back as it was, and why: a table, column or index it retires, or a
 * trigger it retires or rebuilds with a different body. A step that drops anything else contracts the schema without
 * saying so, and the migration tests refuse it.
 */
export interface Retirement {
  readonly kind: 'table' | 'column' | 'index' | 'trigger';
  /** The object's name; a column's is `table.column`. */
  readonly name: string;
  readonly reason: string;
}

/** Declares each of `names` retired by its step for the same reason. */
export function retiring(kind: Retirement['kind'], names: readonly string[], reason: string): readonly Retirement[] {
  return names.map((name) => ({ kind, name, reason }));
}
