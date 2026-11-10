/** One schema step: its version, its statements in order, what it drops without putting back as it was, and why it reaches tables it did not create. */
export interface SchemaStep {
  version: number;
  statements: readonly string[];
  /** What the step drops without putting back as it was, each with its reason. */
  retires?: readonly Retirement[];
  /** The tables earlier steps created that the step reaches, each with its reason. */
  reaches?: readonly Reach[];
  /** The indexes the step creates that lead with what a Deployment-wide read seeks by rather than with `project_id`. */
  deploymentIndexes?: readonly DeploymentIndex[];
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

/**
 * A table an earlier step created that this step builds on or changes, and why. A build is an index, trigger or search
 * over the table, or rebuilding one of its indexes or triggers; it needs the reach's `reason`. A change is an ALTER, a
 * row write (INSERT, UPDATE, DELETE) or dropping the table; it needs `changes` too, so a step that builds on a table
 * cannot change its rows or columns on the build's reason. A step from 100 that reaches a table it did not create
 * without the declaration it needs fails the schema step ownership test; dropping an object the step declares in `retires`
 * needs no reach.
 */
export interface Reach {
  readonly table: string;
  readonly reason: string;
  /** Why the step alters the table or writes its rows; required for a change, refused when the step makes none. */
  readonly changes?: string;
}

/** Declares each of `tables` built on by its step for the same reason. */
export function reaching(tables: readonly string[], reason: string): readonly Reach[] {
  return tables.map((table) => ({ table, reason }));
}

/** Declares each of `tables` changed by its step (altered or its rows written), and built on, for the same reason. */
export function changing(tables: readonly string[], reason: string): readonly Reach[] {
  return tables.map((table) => ({ table, reason, changes: reason }));
}

/** The table a `CREATE INDEX` or `CREATE TRIGGER` statement builds on, for steps built one statement at a time. */
export function builtOn(sql: string): string {
  const match = /^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b[^(]*?\bON\s+(\w+)/i.exec(sql);
  if (match === null) throw new Error(`not an index or trigger: ${sql.slice(0, 80)}`);
  return match[1]!;
}

/**
 * An index a step creates on a Project-scoped table that leads with what a Deployment-wide read seeks by rather than
 * with `project_id`, and the read it serves. Every other index on such a table leads with `project_id`.
 */
export interface DeploymentIndex {
  readonly index: string;
  readonly read: string;
}
