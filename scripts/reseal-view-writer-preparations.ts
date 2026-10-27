import legacy from '../tests/myco-server/fixtures/view-read-legacy.json';
import {preparationSourceInventory,preparationSourceExceptions,preparationFoundationImports,preparationSourcePins} from '../tests/helpers/view-read-policy.js';
import ts from 'typescript-v6';
import {sealViewReadSource} from './view-read-seal.js';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { preparationOwner, isSqlPreparation, protectedRelations } from '../tests/helpers/statement-recorder.js';
import { sourceBoundary, type ExceptionClosure, type ParameterCaller } from '../tests/helpers/view-read-contract.js';
import sources from '../tests/helpers/view-writer-preparation-sources.json';
import { materialWriteInventory } from '../tests/helpers/material-write-inventory.js';

const cataloguesOnly=process.argv.includes('--check-catalogues');
const check=cataloguesOnly||process.argv.includes('--check');
if(cataloguesOnly&&process.argv.includes('--observations'))throw new Error('Catalogue checks cannot refresh observations');
const fixture = 'tests/myco-server/fixtures/view-read-preparations.json';
const catalogue = 'tests/helpers/view-read-operations.ts';
const data = JSON.parse(readFileSync(fixture, 'utf8'));
type Metadata = {nonSql?:boolean;callerKeys?:string[];callerRelations?:{callers:string[];relations:string[]}[]};
type Origin = [string, string, string, string, string, string[]?, Metadata?];
const previous: Origin[] = JSON.parse(gunzipSync(Buffer.from(data.writer.preparationOrigins.data, 'base64')).toString());
const base:Origin[]=JSON.parse(gunzipSync(Buffer.from(data.data,'base64')).toString());
const additions: Origin[] = [];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const known = new Set((JSON.parse(gunzipSync(Buffer.from(data.data, 'base64')).toString()) as Origin[]).map((row) => JSON.stringify(row.slice(1, 4))));

for (const [file, owners] of Object.entries(sources)) {
  const text = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isSqlPreparation(ts, node, tree) &&
      ['prepare', 'query', 'exec'].includes(node.expression.name.text) &&
      node.arguments[0]
    ) {
      const expression = node.arguments[0].getText(tree),
        owner = preparationOwner(ts, node, tree);
      const key = JSON.stringify([file, owner, expression]);
      if (!known.has(key)) {
        const phase = Object.entries(owners).find(([name]) => name === owner)?.[1];
        if (!phase)
          throw new Error('Classify preparation owner in view-writer-preparation-sources.json: ' + file + '#' + owner);
        const id = 'pr5-' + digest(file + '#' + owner + '#' + expression).slice(0, 16);
        additions.push([id, file, owner, expression, phase]);
        known.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
additions.sort((a, b) => compare(JSON.stringify(a.slice(1)), JSON.stringify(b.slice(1))));
const originTuple=(row:Origin)=>JSON.stringify(row.slice(0,5));
const previousByTuple=new Map(previous.map(row=>[originTuple(row),row]));
const rows:Origin[] = [...base.map(row=>structuredClone(previousByTuple.get(originTuple(row))??row)), ...additions];
const walk = (root:string):string[] => readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(root+'/'+entry.name):/\.tsx?$/.test(entry.name)?[root+'/'+entry.name]:[]);
const inputSources = new Map(preparationSourceInventory(process.cwd()).map(file=>[file,readFileSync(file,'utf8')]));

const closures:ExceptionClosure[]=[], callers:ParameterCaller[]=[];
const relations=new Map<string,readonly string[]>(), nonSql=new Set<string>();
const siteKey=(site:{file:string;owner:string;expression:string})=>JSON.stringify([site.file,site.owner,site.expression]);
const exceptions=[...preparationSourceExceptions.filter((row:{id:string})=>!row.id.startsWith('pr5-')),...additions.map(([id,file,owner,expression,phase])=>({...data.writer.sourceExceptions.find((row:{id:string})=>row.id===id),id,file,owner,expression,phase}))].map(row=>structuredClone(row));
const errors=cataloguesOnly?[]:sourceBoundary(inputSources,exceptions,preparationFoundationImports,{validateBoundaries:false,captureClosure:row=>closures.push(row),captureCaller:row=>callers.push(row),captureDependencies:(row,dependencies)=>{row.dependencies=dependencies;},capturePreparation:(site,found)=>relations.set(siteKey(site),found),captureNonSql:site=>nonSql.add(siteKey(site))});
const unexpected=errors.filter(error=>error.startsWith('packages/')&&!/SQL closure differs|missing frozen SQL closure|SQL exception dependencies differ|unpinned SQL sink argument|SQL sink argument dependencies differ|unpinned open SQL callback|open SQL callback dependencies differ/.test(error));
if(unexpected.length)throw new Error('SQL source boundary refuses reseal:\n'+unexpected.join('\n'));

if(cataloguesOnly){
 closures.push(...preparationSourcePins.closures);callers.push(...preparationSourcePins.callers);
 for(const row of rows)if(!previousByTuple.has(originTuple(row))&&!base.some(held=>originTuple(held)===originTuple(row)))throw new Error('Fresh source derivation required: '+row[0]);
}

const observationsAt=process.argv.indexOf('--observations');
const observations: {origin:{id:string;file:string;owner:string;expression:string;phase:string};callers:string[];relations:string[]}[] = observationsAt<0?[]:readFileSync(process.argv[observationsAt+1]!, 'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const originTuples=new Set(rows.map(row=>JSON.stringify(row.slice(0,5))));
const originsByTuple=new Map([...base,...previous].map(row=>[originTuple(row),row]));
const baseByTuple=new Map(base.map(row=>[originTuple(row),row]));
const closuresBySite=new Map(closures.map(row=>[siteKey(row),row]));
const callersBySink=new Map<string,ParameterCaller[]>();
for(const caller of callers){const key=JSON.stringify(caller.sink),values=callersBySink.get(key)??[];values.push(caller);callersBySink.set(key,values)}
const recordsByOrigin=new Map<string,typeof observations>();
for(const held of observations){const key=JSON.stringify([held.origin.id,siteKey(held.origin),held.origin.phase]),values=recordsByOrigin.get(key)??[];values.push(held);recordsByOrigin.set(key,values)}
for(const held of observations)if(!originTuples.has(JSON.stringify([held.origin.id,held.origin.file,held.origin.owner,held.origin.expression,held.origin.phase])))throw new Error('Unknown preparation observation: '+JSON.stringify(held.origin));
for(const row of rows){
 const [id,file,owner,expression]=row,key=siteKey({file,owner,expression});
 const old=originsByTuple.get(originTuple(row));
 const closure=closuresBySite.get(key);
 const parameters=new Set((closure?.activeParameters??[]).map(value=>JSON.stringify(value))), keys=new Set<string>();
 for(const parameter of parameters)for(const caller of callersBySink.get(parameter)??[]){keys.add(caller.key);for(const value of caller.activeParameters??[])parameters.add(JSON.stringify(value));}
 if(data.extensions.some((extension:{ids:string[]})=>extension.ids.includes(id)))callers.forEach(caller=>keys.add(caller.key));
 const callerKeys=[...keys].sort();
 const records=recordsByOrigin.get(JSON.stringify([id,key,row[4]]))??[];
 if(!id.startsWith('pr5-')&&!records.length)continue;
 const metadata:Metadata={...(nonSql.has(key)||old?.[6]?.nonSql?{nonSql:true}:{}),...(callerKeys.length?{callerKeys}:{} )};
 const found=new Set<string>(id.startsWith('pr5-')&&records.length?[]:old?.[5]??relations.get(key)??[]);
 const contexts=new Map<string,Set<string>>();
 for(const held of old?.[6]?.callerRelations??[]){if(held.callers.some(value=>!keys.has(value)))continue;const scope=[...held.callers].sort();if(scope.length)contexts.set(JSON.stringify(scope),new Set(held.relations));}
 for(const held of records){const scope=JSON.stringify(held.callers.filter(value=>keys.has(value)).sort());if(callerKeys.length&&scope==='[]')throw new Error('Unscoped preparation observation: '+id+' '+file+'#'+owner);for(const relation of held.relations)found.add(relation);const values=contexts.get(scope)??new Set<string>();held.relations.forEach(relation=>values.add(relation));contexts.set(scope,values);}
 if(callerKeys.length&&!contexts.size)throw new Error('Refresh preparation caller observations: '+id+' '+file+'#'+owner);
 if(callerKeys.length)metadata.callerRelations=[...contexts].map(([key,values])=>({callers:JSON.parse(key),relations:[...values].sort()})).sort((a,b)=>compare(JSON.stringify(a.callers),JSON.stringify(b.callers)));
 row[5]=metadata.nonSql?[]:[...found].sort();row[6]=metadata;
}
data.writer.sourceExceptions=exceptions.filter(row=>JSON.stringify(row)!==JSON.stringify(legacy.sourceExceptions.find(held=>held.id===row.id)));
data.writer.foundationImports=data.writer.foundationImports.filter((row:unknown)=>!legacy.foundationImports.some(held=>JSON.stringify(held)===JSON.stringify(row)));

for(const row of rows)if(data.extensions.some((extension:{ids:string[]})=>extension.ids.includes(row[0]))&&row[6]?.callerRelations)delete row[6].callerKeys;
const encoded = JSON.stringify(rows.filter(row=>row[0].startsWith('pr5-')||JSON.stringify(row)!==JSON.stringify(baseByTuple.get(originTuple(row)))));
data.writer.preparationOrigins = {
  encoding: 'gzip-base64-json',
  sha256: digest(encoded),
  data: gzipSync(encoded, { mtime: 0 }).toString('base64'),
};


const operationsText = readFileSync(catalogue, 'utf8');
const operations = JSON.parse(operationsText.slice(operationsText.indexOf('['), operationsText.lastIndexOf(']') + 1));
const isWriterRead = (id: string) =>
  /^N:(?:preflight|viewStatus|viewMaterialVersionQuery|operatorView|injectionServedIds|injectionSessionRecords|injectionPromptHeld)/.test(
    id,
  );
const retained = operations.filter((operation: { id: string }) => !isWriterRead(operation.id));
const owner = 'packages/myco-server/src/read/view-store.ts';
const tree = ts.createSourceFile(owner, readFileSync(owner, 'utf8'), ts.ScriptTarget.Latest, true);
const reads: { id: string; family: null; operation: string; template: string; expressionSha256: string }[] = [];
const visit = (node: ts.Node) => {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === 'prepareViewRead' &&
    node.arguments[1] &&
    ts.isStringLiteralLike(node.arguments[1]) &&
    isWriterRead(node.arguments[1].text)
  ) {
    const id = node.arguments[1].text;
    reads.push({
      id,
      family: null,
      operation: id.split(':')[1]!,
      template: '0',
      expressionSha256: digest(node.arguments[2]!.getText(tree)),
    });
  }
  ts.forEachChild(node, visit);
};
visit(tree);
reads.sort((a, b) => compare(a.id, b.id));
if (new Set(reads.map((row) => row.id)).size !== reads.length) throw new Error('duplicate writer read operation');
const classesFile = 'tests/myco-server/fixtures/material-write-classes.json';
const classifications = JSON.parse(readFileSync(classesFile, 'utf8'));
const inventory = walk('packages/myco-server/src').flatMap((file) =>
  materialWriteInventory(file, readFileSync(file, 'utf8')),
);
const reanchored = inventory.map((row) => {
  const exact = classifications.find(
    (held: typeof row) =>
      JSON.stringify([held.file, held.owner, held.expression, held.table, held.operation]) ===
      JSON.stringify([row.file, row.owner, row.expression, row.table, row.operation]),
  );
  if (exact) return exact;
  const candidates = classifications.filter(
    (held: typeof row) =>
      held.file === row.file &&
      held.owner === row.owner &&
      held.table === row.table &&
      held.operation === row.operation,
  );
  if (candidates.length !== 1)
    throw new Error('Classify exact material write: ' + row.file + '#' + row.owner + '/' + row.table);
  return { ...candidates[0], ...row };
});
const outputs = [
  [fixture, JSON.stringify(data) + '\n'],
  [
    catalogue,
    'export const VIEW_READ_OPERATIONS = ' + JSON.stringify([...retained, ...reads], null, 2) + ' as const;\n',
  ],
  [classesFile, JSON.stringify(reanchored, null, 2) + '\n'],
];
for (const [file, text] of outputs) {
  if (check) {
    const held=readFileSync(file!, 'utf8');
    if (file===fixture?JSON.stringify(JSON.parse(held))!==JSON.stringify(data):held!==text) throw new Error('Stale generated preparation catalogue: ' + file);
  } else writeFileSync(file!, text!);
}
console.log(
  JSON.stringify({ origins: additions.length, reads: reads.length, check, cataloguesOnly }),
);

if(!cataloguesOnly)await sealViewReadSource({sources:inputSources,exceptions,closures,callers},true,check);
