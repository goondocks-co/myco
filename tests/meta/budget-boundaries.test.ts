import {expect,it} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

const root=join(import.meta.dir,'../..');
const source=(path:string)=>readFileSync(join(root,path),'utf8');
it('every production schema applier or recovery reaches operator budget completion',()=>{
  const native=source('packages/myco-server/src/platform/bun/server-main.ts');
  const hosted=source('packages/myco/src/server/cloudflare-schema.ts');
  expect(native).toContain('budgetMigration(Date.now())');
  expect(hosted).toContain('budgetMigration(Date.now())');
  for(const file of ['local-recovery.ts','cloudflare-recovery.ts'])expect(source(`packages/myco/src/server/${file}`)).toMatch(/migrateOnly\([^;]+\)/);
  expect(source('packages/myco/src/server/cloudflare-recovery-database.ts')).toContain('await applyCloudflareSchema(');
  const emitters=new Set(['cloudflare-stage.ts','cloudflare-recovery-database.ts','cloudflare-schema.ts']);
  for(const name of readdirSync(join(root,'packages/myco/src/server')).filter(name=>name.endsWith('.ts'))) {
    const body=source(`packages/myco/src/server/${name}`);
    if (/SCHEMA_STEPS|['"]migrations['"]\s*,\s*['"]apply['"]/.test(body))expect(emitters.has(name)).toBe(true);
  }
});

it('attempt prices have one writer and no facade can introduce a second',()=>{
  const dir=join(root,'packages/myco-server/src');
  const allowed=new Set(['core/attempt-accounting.ts']);
  const files=(base:string):string[]=>readdirSync(join(dir,base),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(base,entry.name)):[join(base,entry.name)]);
  const violations:string[]=[];
  for(const file of files('').filter(file=>file.endsWith('.ts')&&!file.startsWith('db/'))) {
    const body=readFileSync(join(dir,file),'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'');
    if (/\b(?:INSERT INTO|UPDATE)\s+agent_run_attempts[\s\S]*?\b(?:estimate_usd|cost_usd|cost_source|profile_json)\b/i.test(body)&&!allowed.has(file)) violations.push(file);
  }
  expect(violations).toEqual([]);
});
