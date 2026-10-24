import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type { Database } from 'bun:sqlite';

export interface MeterStatement {sql:string;params:unknown[]}
/** SQLite loop visits are read from the actual prepared statement with scanstatus enabled. */
export function sqliteBudgetMeter() {
  const dir=fs.mkdtempSync(join(tmpdir(),'budget-meter-'));
  const vendor=resolve(import.meta.dir,'../../../packages/myco/vendor-src/libsqlite3');
  const source=fs.readdirSync(vendor).find(name=>name.startsWith('sqlite-amalgamation-'));
  if(source===undefined)throw new Error('Build the repository native SQLite before measuring budget reads');
  const executable=join(dir,'meter');
  const build=Bun.spawnSync(['cc','-O0','-DSQLITE_ENABLE_STMT_SCANSTATUS','-DSQLITE_ENABLE_FTS5','-I',join(vendor,source),
    join(import.meta.dir,'budget-meter.c'),join(vendor,source,'sqlite3.c'),'-lm','-lpthread','-ldl','-o',executable],{stdout:'pipe',stderr:'pipe'});
  if(build.exitCode!==0)throw new Error(new TextDecoder().decode(build.stderr));
  return {
    reads(db:Database,entry:MeterStatement):number {
      const file=join(dir,'sample.sqlite');fs.writeFileSync(file,db.serialize());
      let position=0,quoted=false;
      let sql='';
      for(let i=0;i<entry.sql.length;i++) {
        const char=entry.sql[i]!;
        if(char==="'") { sql+=char;if(quoted&&entry.sql[i+1]==="'"){sql+="'";i++;}else quoted=!quoted;continue; }
        if(char!=='?'||quoted){sql+=char;continue;}
        const value=entry.params[position++];
        if(value===null)sql+='NULL';else if(typeof value==='number')sql+=String(value);
        else if(typeof value==='string')sql+=`'${value.replaceAll("'","''")}'`;else throw new Error('Unsupported meter binding');
      }
      if(position!==entry.params.length)throw new Error('Meter binding count mismatch');
      const result=Bun.spawnSync([executable,file,sql],{stdout:'pipe',stderr:'pipe'});
      if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
      const reads=Number(new TextDecoder().decode(result.stdout).trim());
      if(!Number.isSafeInteger(reads))throw new Error('No SQLite scanstatus result');
      return reads;
    },
    close:()=>fs.rmSync(dir,{recursive:true,force:true}),
  };
}
