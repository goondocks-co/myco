import fs from 'node:fs';
import { Database } from 'bun:sqlite';

const MAX_STATEMENT_CHARACTERS = 16 * 1024 * 1024;

/** Stream ordinary-table D1 exports; triggers are supplied separately as complete schema objects. */
export async function importTableDump(db: Database, file: string): Promise<void> {
  let statement = '';
  let quote = '';
  let literalStart = -1;
  let literalHasNul = false;
  let comment: 'line' | 'block' | '' = '';
  let pending = '';
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  for await (const chunk of input) {
    const text = pending + chunk;
    let offset = 0;
    for (; offset < text.length - 1; offset += 1) {
      const char = text[offset]!;
      const next = text[offset + 1]!;
      statement += char;
      if (statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('D1 export statement exceeds the recovery import limit');
      if (char === '\0') {
        if (quote !== "'") throw new Error('D1 export contains a NUL outside a text literal');
        literalHasNul = true;
        continue;
      }
      if (comment === 'line') { if (char === '\n') comment = ''; continue; }
      if (comment === 'block') {
        if (char === '*' && next === '/') { statement += next; offset += 1; comment = ''; }
        continue;
      }
      if (quote !== '') {
        if (char === quote) {
          if (next === quote && quote !== ']') { statement += next; offset += 1; }
          else {
            if (quote === "'" && literalHasNul) {
              const value = statement.slice(literalStart + 1, -1).replaceAll("''", "'");
              statement = statement.slice(0, literalStart) + `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
              if (statement.length > MAX_STATEMENT_CHARACTERS) throw new Error('D1 export statement exceeds the recovery import limit');
            }
            quote = '';
          }
        }
        continue;
      }
      if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
        comment = char === '-' ? 'line' : 'block'; statement += next; offset += 1;
      } else if (char === "'" || char === '"' || char === '`' || char === '[') {
        quote = char === '[' ? ']' : char;
        if (quote === "'") { literalStart = statement.length - 1; literalHasNul = false; }
      } else if (char === ';') {
        db.exec(statement);
        statement = '';
      }
    }
    pending = text.slice(offset);
  }
  statement += pending;
  if (quote !== '' || comment === 'block') throw new Error('D1 export ends inside a quoted value or comment');
  if (statement.trim() !== '') db.exec(statement);
}
