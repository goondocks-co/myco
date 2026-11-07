import { read, type BindValue, type Statement } from '../index.js';

/** One read statement per composed shape, named by its family and a digest of its SQL, so each shape keeps one fixed name. */
const composed = new Map<string, Statement<BindValue[], unknown, 'read'>>();

const digest = (text: string): string => {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(text.length - 1 - i), 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

/** The read for a list page its family composed from bound filters; the same SQL always yields the same statement. */
export function composedRead<Row>(family: string, sql: string): Statement<BindValue[], Row, 'read'> {
  let statement = composed.get(sql);
  if (statement === undefined) {
    statement = read<BindValue[], unknown>({ name: `${family}.page${digest(sql)}`, sql });
    composed.set(sql, statement);
  }
  return statement as Statement<BindValue[], Row, 'read'>;
}
