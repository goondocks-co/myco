import { expect, test } from 'bun:test';
import {preparationSealEnvelope,classifySourceSealChange} from '../../scripts/view-read-seal.js';
import {preparationOrigins,assertPreparationRelationsExtend,refreshPreparationRelations,mergeSourceExceptions} from '../helpers/view-read-policy.js';
import legacy from '../myco-server/fixtures/view-read-legacy.json';
import fs, { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import ts from 'typescript-v6';
import classes from '../myco-server/fixtures/material-write-classes.json';
import { materialWriteInventory } from '../helpers/material-write-inventory.js';
import {
  materialWriteBoundary,
  materialWriteMode,
  MATERIAL_TABLES,
  DYNAMIC_MATERIAL_TARGET,
  PHYSICAL_MATERIAL_RESTORES,
} from '../helpers/material-write-classification.js';

const sources = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(root + '/' + entry.name)
      : entry.name.endsWith('.ts')
        ? [root + '/' + entry.name]
        : [],
  );
const anchor = (row: { file: string; owner: string; expression: string; table: string; operation: string }) =>
  JSON.stringify([row.file, row.owner, row.expression, row.table, row.operation]);
const testNames = (file: string) => {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
    names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      /^(?:it|test)(?:\.|$)/.test(node.expression.getText(tree)) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
};

test('every literal and generated material insert/update has one exact classification and a registered behavioral witness', () => {
  const inventory = sources('packages/myco-server/src').flatMap((file) =>
    materialWriteInventory(file, readFileSync(file, 'utf8')),
  );
  expect(classes.map(anchor).sort()).toEqual(inventory.map(anchor).sort());
  expect(new Set(classes.map(anchor)).size).toBe(classes.length);
  const covered = new Set<string>();
  for (const entry of classes) {
    expect(testNames(entry.witness.file), entry.file + '#' + entry.owner).toContain(entry.witness.test);
    expect(entry.fields.length).toBeGreaterThan(0);
    materialWriteMode(entry.mode);
    if (entry.mode === 'schema') {
      expect(entry.file).toContain('/db/');
      continue;
    }
    if (entry.mode === 'out-of-scope') {
      expect(entry.targets).toEqual([]);
      expect(entry.table).toBe(DYNAMIC_MATERIAL_TARGET);
      continue;
    }
    expect(entry.targets.length).toBeGreaterThan(0);
    for (const target of entry.targets) {
      expect(new Set<string>(MATERIAL_TABLES).has(target)).toBe(true);
      covered.add(target);
    }
    if (entry.table !== DYNAMIC_MATERIAL_TARGET) expect(entry.targets).toContain(entry.table);
    if (entry.mode === 'versioned') expect(entry.adapter).toBeString();
  }
  expect([...covered].sort()).toEqual([...MATERIAL_TABLES].sort());
});

test('an unclassified plain update, stale witness and generated material target each fail the classification boundary', () => {
  const entry = classes.find((row) => row.owner==='toolResultReplay')!;
  const boundary = materialWriteBoundary(classes.map((row) => ({ ...row, mode: materialWriteMode(row.mode) })));
  const origin = {
    kind: 'exception' as const,
    id: 'control',
    file: entry.file,
    owner: entry.owner,
    expression: entry.expression,
    phase: 'W' as const,
  };
  const event = {
    kind: 'prepare' as const,
    statementId: 'probe',
    sql: 'UPDATE main."tool_calls" SET success=?',
    binds: [],
    operation: 'control',
    phase: 'W',
    origin,
  };
  expect(() => boundary.check(event)).not.toThrow();
  expect(() => boundary.check({ ...event, origin: { ...origin, expression: 'unclassified' } })).toThrow(
    'material_write_unclassified',
  );
  expect(boundary.violations).toHaveLength(1);
  const unknown = "function other(db){db.prepare('UPDATE plans SET status=?')}";
  expect(materialWriteInventory('packages/myco-server/src/other.ts', unknown).map(anchor)).not.toEqual(
    classes.map(anchor),
  );
  expect(testNames(entry.witness.file)).not.toContain('unregistered behavior');
  const nonmaterial = classes.find((row) => row.mode === 'out-of-scope' && row.operation === 'UPDATE')!;
  expect(() =>
    boundary.check({
      ...event,
      origin: { ...origin, file: nonmaterial.file, owner: nonmaterial.owner, expression: nonmaterial.expression },
    }),
  ).toThrow('material_write_unclassified');
});

test('physical material imports require their exact maintenance preparation and insert operation', () => {
  const boundary = materialWriteBoundary([]);
  for (const entry of PHYSICAL_MATERIAL_RESTORES) {
    expect(testNames(entry.witness.file)).toContain(entry.witness.test);
    expect(readFileSync(entry.file, 'utf8')).toContain('const prepared = db.prepare(sql)');
    const origin = {
      kind: 'exception' as const,
      id: 'probe',
      file: entry.file,
      owner: entry.owner,
      expression: entry.expression,
      phase: 'P' as const,
    };
    const event = {
      kind: 'prepare' as const,
      statementId: 'probe',
      sql: 'INSERT INTO events(project_id) VALUES(?)',
      binds: [],
      operation: 'restore',
      phase: 'P',
      origin,
    };
    expect(() => boundary.check(event)).not.toThrow();
    expect(() =>
      boundary.check({
        ...event,
        sql: 'CREATE TRIGGER mirror AFTER INSERT ON source BEGIN INSERT INTO events(project_id) VALUES(1); END',
      }),
    ).not.toThrow();
    expect(() =>
      boundary.check({
        ...event,
        sql: 'EXPLAIN QUERY PLAN INSERT INTO events(project_id) VALUES(?)',
      }),
    ).not.toThrow();
    expect(() => boundary.check({ ...event, sql: 'UPDATE events SET payload=?' })).toThrow(
      'material_write_unclassified',
    );
    expect(() => boundary.check({ ...event, origin: { ...origin, owner: 'unknown' } })).toThrow(
      'material_write_unclassified',
    );
    expect(() => boundary.check({ ...event, origin: { ...origin, phase: 'W' as const } })).toThrow(
      'material_write_unclassified',
    );
  }
});

test('runtime schema and plan preparations cannot borrow the maintenance material exemption', () => {
  const boundary = materialWriteBoundary([]);
  const maintenance = {
    kind: 'exception' as const,
    id: 'control',
    file: 'operator.ts',
    owner: 'restore',
    expression: 'sql',
    phase: 'P' as const,
  };
  const event = { kind: 'prepare' as const, statementId: 'probe', binds: [], operation: 'runtime', phase: 'read' };
  for (const sql of [
    'CREATE TRIGGER mirror AFTER INSERT ON source BEGIN INSERT INTO events(project_id) VALUES(1); END',
  ]) {
    for (const phase of ['H', 'P'] as const)
      expect(() => boundary.check({ ...event, sql, origin: { ...maintenance, phase } })).not.toThrow();
    for (const origin of [undefined, { kind: 'module' as const }, { ...maintenance, phase: 'W' as const }])
      expect(() => boundary.check({ ...event, sql, origin })).toThrow('material_write_unclassified');
  }
  expect(boundary.violations).toHaveLength(3);
  for(const origin of [undefined,{kind:'module' as const},maintenance])expect(()=>boundary.check({...event,sql:'EXPLAIN QUERY PLAN INSERT INTO events(project_id) VALUES(?)',origin})).not.toThrow();
});

test('the production generic restore retains its frozen statement without material admission or eager preparation', () => {
  const source = readFileSync('packages/myco-server/src/core/backup.ts', 'utf8');
  const tree = ts.createSourceFile('backup.ts', source, ts.ScriptTarget.Latest, true),
    expressions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'db.prepare' && node.arguments[0])
      expressions.push(node.arguments[0].getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(expressions).toContain(
    "`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}${guard} RETURNING rowid`",
  );
  expect(source).not.toContain('prepareMaterialRestore');
  expect(source).not.toContain('material_integer_invalid');
});

test('the tracked writer reseal generator reproduces its catalogues from the sealed graph without mutating them', async () => {
  const files=['tests/myco-server/fixtures/view-read-preparations.json','tests/helpers/view-read-operations.ts','tests/myco-server/fixtures/material-write-classes.json'];
  const before=files.map(file=>readFileSync(file));
  const child=Bun.spawn([process.execPath, 'scripts/reseal-view-writer-preparations.ts', '--check-catalogues'], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  });
  const [stderr,,exitCode]=await Promise.all([new Response(child.stderr).text(),new Response(child.stdout).text(),child.exited]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(files.map(file=>readFileSync(file))).toEqual(before);
});


test('module material writes require their declared operation and target',()=>{
 const row=classes.find(row=>row.owner==='planStatusStatement');
 if(!row)throw new Error('Missing plan-status declaration');
 const boundary=materialWriteBoundary([{...row,mode:materialWriteMode(row.mode)}]);
 const event={kind:'prepare' as const,statementId:'module',sql:'/*vs:M10:plans_planInSession:0*/UPDATE plans SET status=?',binds:[],operation:'module',phase:'fact-write',origin:{kind:'module' as const}};
 expect(()=>boundary.check(event)).not.toThrow();
 expect(()=>boundary.check({...event,origin:{kind:'exception',id:'forged',phase:'W',file:row.file,owner:row.owner,expression:row.expression}})).toThrow('material_write_unclassified');
 for(const sql of ['/*vs:M01:turns_listTurns:0*/UPDATE plans SET status=?','/*vs:M10:plans_planInSession:0*/UPDATE events SET payload=?','UPDATE plans SET status=?'])expect(()=>boundary.check({...event,sql})).toThrow('material_write_unclassified');
});


test('an added production SQL tuple requires a named class',()=>{
 const row={file:'packages/myco-server/src/core/unclassified.ts',owner:'write',expression:'sql',parameters:[],dependencies:[],unresolved:[]};
 expect(()=>classifySourceSealChange({tupleId:'unclassified',change:'added'},row,[])).toThrow('Classify tuple');
 for(const [file,owner] of [['packages/myco-server/src/ingest/parse.ts','parseOnce'],['packages/myco-server/src/core/backup.ts','restoreArtifact']]){
  expect(()=>classifySourceSealChange({tupleId:'unclassified-under-known-owner',change:'added'},{...row,file,owner},[])).toThrow('Classify tuple');
 }
});

test('writer overrides preserve declaration fields and only add sealed preparation relations',()=>{
 const held=legacy.sourceExceptions.find(row=>row.dependencies?.length)!;
 const row={...held,dependencies:[]};
 expect(mergeSourceExceptions([held],[row])).toEqual([row]);
 expect(()=>assertPreparationRelationsExtend(['plans'],['plans','learning_sessions'])).not.toThrow();
 expect(()=>assertPreparationRelationsExtend(['plans'],['learning_sessions'])).toThrow('removes sealed relations');
 for(const key of ['phase','expression','file','owner','callers'] as const){
  const changed={...row,[key]:key==='callers'?['forged']:String(row[key as keyof typeof row])+'-forged'};
  expect(()=>mergeSourceExceptions([held],[changed])).toThrow('dependencies only');
 }
});


test('partial preparation observation refreshes preserve every sealed relation',()=>{
 const sealed=['processed_resources','prompt_batches','responses','tool_calls'];
 const partial=[{relations:['prompt_batches','responses','tool_calls']}];
 expect(refreshPreparationRelations(sealed,partial)).toEqual(sealed);
 expect(refreshPreparationRelations(sealed,[])).toEqual(sealed);
 const extended=refreshPreparationRelations(sealed,[...partial,{relations:['plans','responses']}]);
 expect(extended).toEqual(['plans',...sealed]);
 expect(refreshPreparationRelations(extended,partial)).toEqual(extended);
 expect(sealed).toEqual(['processed_resources','prompt_batches','responses','tool_calls']);
});


test('the tracked resealer preserves sealed production relations during a partial observation refresh',async()=>{
 const origin=preparationOrigins.find(row=>row.id==='pr5-b65633b9142d6820');
 if(!origin)throw new Error('Missing plan event preparation origin');
 expect(origin.relations).toContain('processed_resources');
 const files=['tests/myco-server/fixtures/view-read-preparations.json','tests/helpers/view-read-operations.ts','tests/myco-server/fixtures/material-write-classes.json'];
 const before=files.map(file=>readFileSync(file));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myco-partial-observations-'));
 try{
  const observations=path.join(root,'observations.jsonl');
  fs.writeFileSync(observations,JSON.stringify({origin,callers:[],relations:['responses']})+'\n');
  const child=Bun.spawn([process.execPath,'scripts/reseal-view-writer-preparations.ts','--check','--observations',observations],{env:process.env,stdout:'pipe',stderr:'pipe'});
  const [stderr,,status]=await Promise.all([new Response(child.stderr).text(),new Response(child.stdout).text(),child.exited]);
  expect(stderr).toBe('');
  expect(status).toBe(0);
  expect(files.map(file=>readFileSync(file))).toEqual(before);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
},90000);


test('unchanged preparation payloads retain any valid gzip representation and reject a forged envelope',()=>{
 const raw=JSON.stringify({rows:['processed_resources','plans']});
 const previous={encoding:'gzip-base64-json',sha256:createHash('sha256').update(raw).digest('hex'),data:gzipSync(raw,{level:0}).toString('base64')};
 expect(preparationSealEnvelope(raw,previous)).toEqual(previous);
 const next=preparationSealEnvelope(raw+' ',previous);
 expect(next.sha256).not.toBe(previous.sha256);
 expect(gunzipSync(Buffer.from(next.data,'base64')).toString()).toBe(raw+' ');
 expect(()=>preparationSealEnvelope(raw,{...previous,data:gzipSync('forged').toString('base64')})).toThrow('Invalid sealed preparation envelope');
});
