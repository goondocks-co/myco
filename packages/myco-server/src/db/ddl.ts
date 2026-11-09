/** A trigger's identity beside its SQL: what a test uses to drop or restore it by name. */
export interface Trigger {
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

/** An `AFTER` trigger running `body` in order, restricted by `when` when one is given. */
export function trigger(name: string, table: string, event: string, body: string | readonly string[], when?: string | null): Trigger {
  const statements = typeof body === 'string' ? [body] : body;
  return { name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN ${statements.join('; ')}; END` };
}

/** True when this update changes any of `columns`. */
export const changed = (columns: readonly string[]): string => columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');

/** The columns of a key page carried as one JSON array of positional arrays in slot `?1`. */
export const jsonKeys = (columns: readonly string[]): string =>
  `SELECT ${columns.map((column, position) => `json_extract(value,'$[${position}]') AS ${column}`).join(',')} FROM json_each(?1)`;
