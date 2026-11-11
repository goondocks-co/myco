import type { RelationalStore } from '../core/adapters.js';
import { read, readSet, type BindValue, type Statement } from './index.js';

/** A read whose SQL names its inputs as `{slot}` markers; each slot becomes a numbered bind in order of first use. */
export interface SlottedRead<Row> {
  readonly statement: Statement<BindValue[], Row, 'read'>;
  readonly slots: readonly string[];
}

/** Defines the read; its SQL is fixed here, and the markers decide only which numbered binds it holds. */
export function slottedRead<Row>(name: string, template: string): SlottedRead<Row> {
  const slots: string[] = [];
  const sql = template.replace(/\{([A-Za-z0-9]+)\}/g, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  return { statement: read<BindValue[], Row>({ name, sql }), slots };
}

/** Runs the read with each slot bound to its value; a slot the values do not name is an error. */
export async function readSlotted<Row>(db: RelationalStore, variant: SlottedRead<Row>, values: Readonly<Record<string, BindValue>>): Promise<Row[]> {
  const bound = variant.slots.map(slot => {
    const value = values[slot];
    if (value === undefined) throw new Error(`${variant.statement.name}: no value for slot ${slot}`);
    return value;
  });
  const [rows] = await readSet(db, variant.statement.bind(...bound));
  return rows;
}
