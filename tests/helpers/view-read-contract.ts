import legacy from '../myco-server/fixtures/view-read-legacy.json';

import ts from 'typescript-v6';
import { VIEW_READ_OPERATIONS, LEGACY_ONLY_OPERATIONS } from '../../packages/myco-server/src/read/view-store.js';

import {protectedSql,MATERIAL_RELATIONS,readPreparationViolations,checkedPreparationOrigins,type PreparationOrigin} from './statement-recorder.js';
export {protectedSql,MATERIAL_RELATIONS} from './statement-recorder.js';
const ids = new Set<string>(VIEW_READ_OPERATIONS.map(operation=>operation.id));
const preparationOrigins=await checkedPreparationOrigins(legacy.preparationOrigins);
const legacyOperations=new Set<string>(LEGACY_ONLY_OPERATIONS);
const observedDurableClasses=new Set(['DeploymentClock','RecoveryProducer']);
export function durableObservationViolations(classes:readonly string[]):string[]{
 return [...classes.filter(name=>!observedDurableClasses.has(name)).map(name=>'unclassified Durable Object '+name),...[...observedDurableClasses].filter(name=>classes.filter(value=>value===name).length!==1).map(name=>'requires one observed '+name)];
}

export function readTag(sql: string): { operation: string; statement: string } | null {
  const match = /^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(sql);
  return match === null ? null : { operation: match[1]!, statement: sql.slice(match[0].length) };
}

export function significantRead(sql: string): string {
  const tag = readTag(sql);
  if (tag === null || !ids.has(tag.operation)) throw new Error('unknown or absent view-read operation tag');
  if (/^\/\*vs:/.test(tag.statement.trimStart())) throw new Error('multiple view-read tags');
  return tag.statement;
}

export interface StatementException {
  id: string;
  file: string;
  owner: string;
  expression: string;
  phase: 'W' | 'P' | 'H' | 'T';
}

export interface FoundationImport {
  owner: string;
  importer: string;
  imports: readonly string[];
}

const nodeName = (node: ts.Node, file: ts.SourceFile): string => {
  for (let at: ts.Node | undefined = node; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at.parent.name.getText(file);
  }
  return '<module>';
};

function moduleFile(from: string, to: string): string {
  to=to.replace(/%([0-9a-f]{2})/gi,(_,byte:string)=>String.fromCharCode(Number.parseInt(byte,16)));
  to=to.split(/[?#]/,1)[0]!;
  const sourcePath=(file:string)=>/\.[^/]+$/.test(file)?file.replace(/\.js$/,'.ts'):file+'.ts';
  if(to.startsWith('/')||to.startsWith('file:')){
    const segments:string[]=[];
    for(const segment of to.split('/'))if(segment==='..')segments.pop();else if(segment!=='.')segments.push(segment);
    const relative=/(?:^|\/)((?:tests|packages)\/.*)$/.exec(segments.join('/'))?.[1];
    if(relative)return sourcePath(relative);
  }
  if(to.startsWith('@myco-server-worker/'))return sourcePath('packages/myco-server/src/'+to.slice('@myco-server-worker/'.length));
  const parts = from.split('/').slice(0, -1);
  for (const part of to.replace(/\.js$/, '.ts').split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return sourcePath(parts.join('/'));
}

export function sourceBoundary(
  sources: ReadonlyMap<string, string>,
  exceptions: readonly StatementException[] = [],
  foundations: readonly FoundationImport[] = [],
  options: {importsOnly?:boolean} = {},
): string[] {
  const files = new Map([...sources].map(([name, text]) => [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)]));
  const declarations = new Map<string, Map<string, ts.Node>>();
  for (const [file, tree] of files) {
    const nodes = new Map<string, ts.Node>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) nodes.set(node.name.text, node.initializer ?? node);
      if (ts.isFunctionDeclaration(node) && node.name) nodes.set(node.name.text, node);
      if(options.importsOnly&&(ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node)))return;
      ts.forEachChild(node, collect);
    };
    collect(tree);
    declarations.set(file, nodes);
  }
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (file) => files.get(file);
  host.fileExists = file => files.has(file);
  host.readFile = file => sources.get(file);
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const file = name.startsWith('.') ? moduleFile(containing, name) : name.startsWith('@myco-server-worker/') ? 'packages/myco-server/src/' + name.slice('@myco-server-worker/'.length).replace(/\.js$/, '.ts') : name;
    return files.has(file) ? {resolvedFileName:file,extension:ts.Extension.Ts} : undefined;
  });
  const program = ts.createProgram([...files.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const declarationOf = (node: ts.Identifier): ts.Node | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer ?? declaration : declaration;
  };
  const errors: string[] = [];
  const value = (node: ts.Node, file: string, seen: Set<ts.Node>): string | null => {
    if (seen.has(node)) return null;
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => (value(span.expression, file, next) ?? '?') + span.literal.text).join('');
    if (ts.isParenthesizedExpression(node)) return value(node.expression, file, next);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, file, next), right = value(node.right, file, next);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (declaration) return value(declaration, declaration.getSourceFile().fileName, next);
    }
    return null;
  };
  const imported = (file: string, local: string): { file: string; name: string } | null => {
    for (const node of files.get(file)?.statements ?? []) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const found = bindings.elements.find(binding => binding.name.text === local);
        if (found) return { file: moduleFile(file, node.moduleSpecifier.text), name: found.propertyName?.text ?? found.name.text };
      }
    }
    return null;
  };
  const exported = (file: string, name: string, seen = new Set<string>()): { file: string; name:string; node: ts.Node } | null => {
    if (seen.has(file + '#' + name)) return null;
    seen.add(file + '#' + name);
    const direct = declarations.get(file)?.get(name);
    if (direct) return { file, name, node: direct };
    for (const node of files.get(file)?.statements ?? []) {
      if (!ts.isExportDeclaration(node) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      if(!node.exportClause){const target=exported(moduleFile(file,node.moduleSpecifier.text),name,seen);if(target)return target;continue;}
      if(!ts.isNamedExports(node.exportClause))continue;
      const binding = node.exportClause.elements.find(binding => binding.name.text === name);
      if (binding) return exported(moduleFile(file, node.moduleSpecifier.text), binding.propertyName?.text ?? binding.name.text, seen);
    }
    return null;
  };
  const tainted = (node: ts.Node, file: string, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    if(ts.isTypeOperatorNode(node)&&node.operator===ts.SyntaxKind.KeyOfKeyword)return false;
    const next = new Set(seen).add(node);
    const literal = value(node, file, new Set());
    if (literal !== null && protectedSql(literal)) return true;
    if (ts.isIdentifier(node)) {
      const local = declarationOf(node);
      if (local) return ts.isParameter(local) || ts.isTypeAliasDeclaration(local) || ts.isInterfaceDeclaration(local) || ts.isTypeParameterDeclaration(local) ? false : tainted(local, local.getSourceFile().fileName, next);
      const source = imported(file, node.text);
      const target = source && exported(source.file, source.name);
      return target !== null && target !== undefined && tainted(target.node, target.file, next);
    }
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return tainted(node.body, file, next);
      const returns: ts.ReturnStatement[] = [];
      const collect = (child: ts.Node): void => {
        if (child !== node && (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child))) return;
        if (ts.isReturnStatement(child)) returns.push(child);
        ts.forEachChild(child, collect);
      };
      collect(node);
      return returns.some(statement => statement.expression !== undefined && tainted(statement.expression, file, next));
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ['prepare', 'first', 'all', 'run', 'batch'].includes(node.expression.name.text)) return false;
      return tainted(node.expression, file, next);
    }
    return node.getChildren(files.get(file)).some(child => tainted(child, file, next));
  };
  const knownBearing=(file:string,name:string):boolean=>foundations.some(item=>item.owner===file && item.imports.includes(name));
  const bearing=(file:string,name:string):boolean=>{
    const target=exported(file,name);
    return knownBearing(file,name)||Boolean(target&&(knownBearing(target.file,target.name)||tainted(target.node,target.file)));
  };
  const allowedImport=(owner:string,importer:string,name:string):boolean=>foundations.some(item=>item.owner===owner && item.importer===importer && item.imports.includes(name));
  for (const [file, tree] of files) {
    const own = file.endsWith('/read/view-store.ts') || file === 'read/view-store.ts';
    if(own){
      const symbol=checker.getSymbolAtLocation(tree);
      for(const entry of symbol?checker.getExportsOfModule(symbol):[]){
        const target=(entry.flags&ts.SymbolFlags.Alias)?checker.getAliasedSymbol(entry):entry;
        const declaration=target.valueDeclaration??target.declarations?.[0];
        if(declaration&&tainted(ts.isVariableDeclaration(declaration)?declaration.initializer??declaration:declaration,declaration.getSourceFile().fileName))errors.push(file+': SQL-bearing export '+entry.name);
      }
    }
    const authority = (node: ts.Node): void => {
      const recorder='tests/helpers/statement-recorder.ts',loader='tests/helpers/view-read-legacy-fixtures.ts';
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
        const target=moduleFile(file,node.moduleSpecifier.text),bindings=node.importClause?.namedBindings;
        if(!file.startsWith('tests/')&&target.startsWith('tests/'))errors.push(file+': production imports test capability');
        if(target===recorder&&bindings){
          if(ts.isNamespaceImport(bindings))errors.push(file+': oracle authority namespace import');
          if(ts.isNamedImports(bindings)&&bindings.elements.some(binding=>(binding.propertyName?.text??binding.name.text)==='createOracleLoader')&&file!==loader)errors.push(file+': oracle authority import outside loader');
        }
      }
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&moduleFile(file,node.moduleSpecifier.text)===recorder&&(!node.exportClause||!ts.isNamedExports(node.exportClause)||node.exportClause.elements.some(binding=>(binding.propertyName?.text??binding.name.text)==='createOracleLoader')))errors.push(file+': oracle authority re-export');
      if((ts.isCallExpression(node)||ts.isNewExpression(node))&&node.arguments?.[0]){
        const specifier=value(node.arguments[0],file,new Set());
        const target=specifier===null?'':moduleFile(file,specifier);
        if(!file.startsWith('tests/')&&target.startsWith('tests/'))errors.push(file+': production imports test capability');
        if(target===recorder)errors.push(file+': dynamic oracle authority import');
      }

      ts.forEachChild(node,authority);
    };
    authority(tree);
    const visit = (node: ts.Node): void => {
      if (!options.importsOnly && !own && ts.isStringLiteralLike(node) && node.text.includes('/*vs:')) errors.push(file + ': outside tag construction');
      if (!options.importsOnly && !own && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['prepare','query','exec'].includes(node.expression.name.text) && node.arguments[0] && tainted(node.arguments[0], file)) {
        const expression = node.arguments[0].getText(tree), owner = nodeName(node, tree);
        if (!exceptions.some(item => item.file === file && item.owner === owner && item.expression === expression)) errors.push(file + '#' + owner + ': protected SQL preparation outside owner');
      }
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && ts.isStringLiteral(node.moduleSpecifier)) {
        for (const binding of node.importClause.namedBindings.elements) {
          const name = binding.propertyName?.text ?? binding.name.text, targetFile = moduleFile(file, node.moduleSpecifier.text);
          const target = exported(targetFile, name);
          if (bearing(targetFile,name) && !allowedImport(targetFile,file,name)) {
            errors.push(file + ': SQL-bearing import ' + name);
          }
        }
      }
      if(ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetFile=moduleFile(file,node.moduleSpecifier.text);
        for(const binding of node.exportClause.elements) {
          const name=binding.propertyName?.text??binding.name.text;
          if(bearing(targetFile,name)&&!allowedImport(targetFile,file,name))errors.push(file+': SQL-bearing re-export '+name);
        }
      }
      if(ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetFile=moduleFile(file,node.moduleSpecifier.text);
        const symbol=checker.getSymbolAtLocation(files.get(targetFile)??node.moduleSpecifier);
        if(symbol&&checker.getExportsOfModule(symbol).some(item=>bearing(targetFile,item.name)&&!allowedImport(targetFile,file,item.name)))errors.push(file+': SQL-bearing star re-export');
      }
      if(ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings) && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetFile=moduleFile(file,node.moduleSpecifier.text);
        const names=new Set<string>(foundations.filter(item=>item.owner===targetFile).flatMap(item=>item.imports));
        for(const statement of files.get(targetFile)?.statements??[]) {
          if(ts.isVariableStatement(statement)&&statement.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))for(const item of statement.declarationList.declarations)if(ts.isIdentifier(item.name))names.add(item.name.text);
          if(ts.isFunctionDeclaration(statement)&&statement.name&&statement.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))names.add(statement.name.text);
          if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause))for(const item of statement.exportClause.elements)names.add(item.name.text);
        }
        if([...names].some(name=>bearing(targetFile,name)))errors.push(file+': SQL-bearing namespace import');
      }
      if(!options.importsOnly)ts.forEachChild(node, visit);
    };
    if(options.importsOnly)for(const statement of tree.statements)visit(statement);else visit(tree);
  }
  return [...new Set(errors)];
}

export interface RuntimeStatement {
  sql: string;
  operation: string;
  phase: string;
  statementId: string;
  exceptionId?: string;
  captured?: boolean;
  origin?:PreparationOrigin;
}

export function runtimeBoundary(
  statements: readonly RuntimeStatement[],
  options: { legacy?: ReadonlySet<string>; exceptions?: readonly { id: string; operation: string; phase: string; statementId: string; sql: string }[] } = {},
): string[] {
  return readPreparationViolations(statements,{known:ids,legacy:options.legacy??legacyOperations,origins:preparationOrigins,exceptions:options.exceptions});
}

export interface PlanRow { id: number; parent: number; detail: string; relation?:string; notused?:number }
function planIdentity(rows: readonly PlanRow[]): readonly { id: number; parent: number; detail: string }[] {
  const ids = new Map(rows.map((row, index) => [row.id, index]));
  return rows.map((row, index) => ({ ...row, id: index, parent: ids.get(row.parent) ?? -1 }));
}

export function armPlanViolations(input: {
  baseline: readonly PlanRow[];
  legacy: readonly PlanRow[];
  publication: readonly PlanRow[];
  view: readonly PlanRow[];
  boundedNodes?: ReadonlyMap<number, { bound: number; maximum: number }>;
}): string[] {
  const errors: string[] = [];
  if (JSON.stringify(planIdentity(input.baseline)) !== JSON.stringify(planIdentity(input.legacy))) errors.push('legacy arm differs from frozen plan');
  const publication=input.publication[0];
  if(input.publication.length!==1 || (publication?.relation??(/^SEARCH session_views\b/i.test(publication?.detail??'')?'session_views':undefined))!=='session_views'
    || !/^SEARCH\s+\S+\b.*(?:PRIMARY KEY|INDEX).*(?:project_id=\?).*(?:session_id=\?)/i.test(publication?.detail??''))errors.push('publication gate requires one exact indexed session_views search');
  for (const row of input.view) {
    if (/^SEARCH\b/i.test(row.detail)) {
      if (!/(?:USING (?:COVERING )?INDEX|USING (?:INTEGER )?PRIMARY KEY|USING PRIMARY KEY)/i.test(row.detail)) errors.push('unindexed view access: ' + row.detail);
      continue;
    }
    if (/^(?:SCAN|USE TEMP B-TREE|CO-ROUTINE|MATERIALIZE|COMPOUND|LEFT-MOST|UNION|CONSTANT)/i.test(row.detail)) {
      const bounded = input.boundedNodes?.get(row.id);
      if (!bounded || bounded.bound < 0 || bounded.bound > bounded.maximum || /^(?:SCAN|MATERIALIZE)\s+(?:prompt_batches|responses|tool_calls|plans|view_\w+)\b/i.test(row.detail)) errors.push('unbounded view arm node: ' + row.detail);
    }
  }
  return errors;
}

export function viewSchemaViolations(rows: readonly { type: string; name: string; tbl_name: string; sql: string | null }[]): string[] {
  const errors: string[] = [];
  for (const row of rows) {
    const sql = row.sql ?? '';
    if (row.type === 'view' && !legacy.schema.persistentViews.some(expected=>expected.name===row.name&&expected.tbl_name===row.tbl_name&&expected.sql===row.sql)) errors.push(row.name + ': unclassified persistent view');
    if (row.type !== 'trigger' || !/^view_/.test(row.tbl_name)) continue;
    if (/\b(?:INTO|UPDATE|DELETE FROM)\s+["\[]?(?:session_read_facts|embedding_versions|search_blob_queue)\b/i.test(sql)) errors.push(row.name + ': forbidden view trigger dependency');
    const writes = [...sql.replace(/^.*?\bBEGIN\b/is, '').matchAll(/\b(?:INTO|UPDATE|DELETE FROM)\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]!);
    const declared = legacy.schema.viewTriggers.native.find(expected => expected.name === row.name && expected.tbl_name === row.tbl_name && expected.sql === row.sql);
    if (!declared || writes.some(table => table !== row.tbl_name + '_fts')) errors.push(row.name + ': unclassified view trigger');
  }
  return errors;
}
