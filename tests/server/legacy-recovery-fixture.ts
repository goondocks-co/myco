import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { SCHEMA_STEPS } from '../../packages/myco-server/src/db/schema.js';

/** Copies the common persisted fields into the exact numbered historical schema. */
export function asHistoricalSchema(file: string, version: number): void {
  const source = new Database(file, { readonly:true });
  const target = new Database(':memory:');
  let image: Uint8Array;
  try {
    for(const step of SCHEMA_STEPS.filter(step=>step.version<=version))for(const sql of step.statements)target.exec(sql);
    const triggers=target.query<{name:string;sql:string},[]>("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    for(const trigger of triggers)target.exec(`DROP TRIGGER "${trigger.name}"`);
    const tables=target.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY rowid").all();
    for(const {name}of tables){
      if(source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)===null)continue;
      const sourceColumns=new Set(source.query(`PRAGMA table_info("${name}")`).all().map(row=>(row as {name:string}).name));
      const columns=target.query<{name:string},[]>(`PRAGMA table_info("${name}")`).all().map(row=>row.name).filter(name=>sourceColumns.has(name));
      const quoted=columns.map(name=>`"${name}"`).join(',');
      const insert=target.query(`INSERT OR REPLACE INTO "${name}" (${quoted}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const row of source.query<Record<string,unknown>,[]>(`SELECT ${quoted} FROM "${name}"`).all())insert.run(...columns.map(name=>row[name]) as (string|number|null|Uint8Array)[]);
    }
    for(const trigger of triggers)target.exec(trigger.sql);
    for(const {name}of target.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'").all())target.exec(`INSERT INTO "${name}" ("${name}") VALUES ('rebuild')`);
    target.run("UPDATE schema_meta SET value=? WHERE key='version'",[String(version)]);
    image=target.serialize();
  }finally{source.close();target.close();}
  fs.writeFileSync(file,image);
}

export const asSchema41 = (file:string):void => asHistoricalSchema(file,41);
