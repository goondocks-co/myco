import legacy from '../myco-server/fixtures/view-read-legacy.json';

import ts from 'typescript-v6';
import { createHash } from 'node:crypto';
import { LEGACY_ONLY_OPERATIONS } from '../../packages/myco-server/src/read/view-store.js';
import { VIEW_READ_OPERATIONS } from './view-read-operations.js';

import {protectedSql,protectedRelations,preparationOwner,isSqlPreparation,OPEN_RELATION_PREPARATIONS,MATERIAL_RELATIONS,readPreparationViolations,checkedPreparationOrigins,checkedPreparationSource,type SqlDeclarationPin,type SqlSinkParameter,type SqlParameterCaller,type SqlExceptionClosure,type PreparationOrigin} from './statement-recorder.js';
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
  dependencies?: readonly {file:string;name:string;sha256:string}[];
}

export type SinkParameter=SqlSinkParameter;
export type ParameterCaller=SqlParameterCaller;
export type ExceptionClosure=SqlExceptionClosure;
const sourcePins=await checkedPreparationSource(legacy.sourceClosureProgram);

export interface SourceScanMetrics { parses:number; importEdges:number; taintNodes:number }

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
  from=from.replace(/\\/g,'/');from=/(?:^|\/)((?:tests|packages)\/.*)$/.exec(from)?.[1]??from;
  to=to.replace(/%([0-9a-f]{2})/gi,(_,byte:string)=>String.fromCharCode(Number.parseInt(byte,16)));
  to=to.replace(/\\/g,'/');
  to=to.split(/[?#]/,1)[0]!;
  const sourcePath=(file:string)=>/\.[^/]+$/.test(file)?file.replace(/\.js$/,'.ts'):file+'.ts';
  if(to.startsWith('/')||to.startsWith('file:')||/^[a-z]:\//i.test(to)){
    const segments:string[]=[];
    for(const segment of to.split('/'))if(segment==='..')segments.pop();else if(segment!=='.')segments.push(segment);
    const relative=/(?:^|\/)((?:tests|packages)\/.*)$/.exec(segments.join('/'))?.[1];
    if(relative)return sourcePath(relative);
  }
  if(to.startsWith('@myco-server-worker/'))return sourcePath('packages/myco-server/src/'+to.slice('@myco-server-worker/'.length));
  if(to.startsWith('@myco/'))return sourcePath('packages/myco/src/'+to.slice('@myco/'.length));
  if(to.startsWith('@goondocks/myco-shared/')){
    const name=to.slice('@goondocks/myco-shared/'.length),generated:Record<string,string>={'capture-rules-data':'capture-rules.generated.ts','resume-commands-data':'resume-commands.generated.ts',skills:'skills.generated.ts'};
    return sourcePath('packages/myco-shared/src/'+(generated[name]??name));
  }
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
  options: {importsOnly?:boolean;metrics?:SourceScanMetrics;captureDependencies?:(exception:StatementException,dependencies:NonNullable<StatementException['dependencies']>)=>void;capturePreparation?:(site:{file:string;owner:string;expression:string},relations:readonly string[])=>void;closures?:readonly ExceptionClosure[];callers?:readonly ParameterCaller[];captureClosure?:(closure:ExceptionClosure)=>void;captureCaller?:(caller:ParameterCaller)=>void;captureNonSql?:(site:{file:string;owner:string;expression:string})=>void} = {},
): string[] {
  const metrics=options.metrics??{parses:0,importEdges:0,taintNodes:0};
  sources = new Map([...sources].map(([name,text])=>[name.replace(/\\/g,'/'),text] as const).sort(([left],[right])=>left<right?-1:left>right?1:0));
  const files = new Map([...sources].map(([name, text]) => {metrics.parses++;return [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)] as const;}));
  const declarations = new Map<string, Map<string, ts.Node>>();
  const declarationNames=new Map<ts.Node,{file:string;name:string}>();
  const imports=new Map<string,Map<string,{file:string;name:string}>>();
  const reexports=new Map<string,Map<string,{file:string;name:string}>>();
  const starExports=new Map<string,string[]>();
  for (const [file, tree] of files) {
    const nodes = new Map<string, ts.Node>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {nodes.set(node.name.text, node.initializer ?? node);declarationNames.set(node.initializer??node,{file,name:node.name.text});}
      if (ts.isFunctionDeclaration(node) && node.name) {nodes.set(node.name.text, node);declarationNames.set(node,{file,name:node.name.text});}
      if(options.importsOnly&&(ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node)))return;
      ts.forEachChild(node, collect);
    };
    collect(tree);
    declarations.set(file, nodes);
    const importedNames=new Map<string,{file:string;name:string}>(),exportedNames=new Map<string,{file:string;name:string}>(),stars:string[]=[];
    for(const node of tree.statements){
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
        const bindings=node.importClause?.namedBindings;
        if(bindings&&ts.isNamedImports(bindings))for(const binding of bindings.elements){metrics.importEdges++;importedNames.set(binding.name.text,{file:moduleFile(file,node.moduleSpecifier.text),name:binding.propertyName?.text??binding.name.text});}
      }
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
        const target=moduleFile(file,node.moduleSpecifier.text);
        if(!node.exportClause)stars.push(target);
        else if(ts.isNamedExports(node.exportClause))for(const binding of node.exportClause.elements)exportedNames.set(binding.name.text,{file:target,name:binding.propertyName?.text??binding.name.text});
      }
    }
    imports.set(file,importedNames);reexports.set(file,exportedNames);starExports.set(file,stars);
  }
  const builtinDeclarations=new Map<string,ts.Node>();
  const library=ts.getDefaultLibFilePath({target:ts.ScriptTarget.ESNext}).replace(/[^/]+$/,'');
  if(!options.importsOnly)for(const name of [...ts.sys.readDirectory(library,['.ts']).map(file=>file.slice(library.length)).filter(name=>/^lib\.es[\w.]*\.d\.ts$/.test(name)).sort(),'lib.dom.d.ts']){
    const text=ts.sys.readFile(library+name);if(!text)continue;
    const tree=ts.createSourceFile('node_modules/typescript-v6/lib/'+name,text,ts.ScriptTarget.Latest,true);
    if(name!=='lib.dom.d.ts')files.set(tree.fileName,tree);
    for(const node of tree.statements){
      if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name))builtinDeclarations.set(declaration.name.text,declaration);
      if(ts.isFunctionDeclaration(node)&&node.name)builtinDeclarations.set(node.name.text,node);
    }
  }
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (file) => files.get(file);
  host.fileExists = file => files.has(file);
  host.readFile = file => sources.get(file)??files.get(file)?.text;
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const file = name.startsWith('.')||name.startsWith('@myco/')||name.startsWith('@myco-server-worker/')||name.startsWith('@goondocks/myco-shared/') ? moduleFile(containing,name) : name;
    return files.has(file) ? {resolvedFileName:file,extension:ts.Extension.Ts} : undefined;
  });
  const program = ts.createProgram([...files.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const sqlType=(type:ts.Type):boolean=>Boolean(type.flags&(ts.TypeFlags.StringLike|ts.TypeFlags.Any|ts.TypeFlags.Unknown|ts.TypeFlags.TypeParameter|ts.TypeFlags.Never))||(type.isUnion()||type.isIntersection())&&type.types.some(sqlType);
  const preparation=(node:ts.CallExpression,tree:ts.SourceFile):boolean=>{
    if(!isSqlPreparation(ts,node,tree)||!node.arguments[0])return false;
    const parameter=checker.getResolvedSignature(node)?.declaration?.parameters[0];const declared=parameter&&ts.isParameter(parameter)?parameter.type:undefined;
    return (!declared||sqlType(checker.getTypeFromTypeNode(declared)))&&sqlType(checker.getTypeAtLocation(node.arguments[0]));
  };
  const requireFactory=(node:ts.Expression):boolean=>{
    const symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node)?node.name:node);
    for(const declaration of symbol?.declarations??[]){
      if(ts.isImportSpecifier(declaration)&&(declaration.propertyName?.text??declaration.name.text)==='createRequire'){
        const source=declaration.parent.parent.parent;
        if(ts.isImportDeclaration(source)&&ts.isStringLiteral(source.moduleSpecifier)&&['node:module','module'].includes(source.moduleSpecifier.text))return true;
      }
    }
    if(ts.isPropertyAccessExpression(node)&&node.name.text==='createRequire'&&ts.isIdentifier(node.expression)){
      const namespace=checker.getSymbolAtLocation(node.expression);
      return Boolean(namespace?.declarations?.some(declaration=>ts.isNamespaceImport(declaration)&&ts.isImportDeclaration(declaration.parent.parent)&&ts.isStringLiteral(declaration.parent.parent.moduleSpecifier)&&['node:module','module'].includes(declaration.parent.parent.moduleSpecifier.text)));
    }
    return false;
  };
  const moduleLoader=(node:ts.Expression,seen=new Set<ts.Node>()):boolean=>{
    if(seen.has(node))return false;
    const next=new Set(seen).add(node);
    if(node.kind===ts.SyntaxKind.ImportKeyword)return true;
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return moduleLoader(node.expression,next);
    if(ts.isIdentifier(node)){
      if(node.text==='require')return true;
      return Boolean(checker.getSymbolAtLocation(node)?.declarations?.some(declaration=>ts.isVariableDeclaration(declaration)&&declaration.initializer&&moduleLoader(declaration.initializer,next)));
    }
    if(ts.isPropertyAccessExpression(node))return node.name.text==='require'&&ts.isMetaProperty(node.expression)&&node.expression.keywordToken===ts.SyntaxKind.ImportKeyword;
    if(ts.isCallExpression(node))return requireFactory(node.expression)||(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='bind'&&moduleLoader(node.expression.expression,next));
    return false;
  };
  const resolvedDeclarations=new Map<ts.Identifier,ts.Node|undefined>();
  const declarationOf = (node: ts.Identifier): ts.Node | undefined => {
    if(resolvedDeclarations.has(node))return resolvedDeclarations.get(node);
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const result=declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer ?? declaration : declaration;
    resolvedDeclarations.set(node,result);return result;
  };
  const errors: string[] = [];
  const values=new Map<ts.Node,string|null>();
  let valueCycles=0;
  const value = (node: ts.Node, file: string, seen: Set<ts.Node>): string | null => {
    if(values.has(node))return values.get(node)!;
    if (seen.has(node)) {valueCycles++;return null;}
    const cycles=valueCycles;
    const result=resolveValue(node,file,seen);
    if(cycles===valueCycles)values.set(node,result);
    return result;
  };
  const resolveValue = (node: ts.Node, file: string, seen: Set<ts.Node>): string | null => {
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
  const imported = (file: string, local: string) => imports.get(file)?.get(local)??null;
  type Exported={file:string;name:string;node:ts.Node};
  const exports=new Map<string,Exported|null>();
  const exported = (file: string, name: string, seen = new Set<string>()): { file: string; name:string; node: ts.Node } | null => {
    const key=file+'#'+name;
    if(exports.has(key))return exports.get(key)!;
    if (seen.has(key)) return null;
    const next=new Set(seen).add(key);
    const direct = declarations.get(file)?.get(name);
    if (direct) {const target={file,name,node:direct};exports.set(key,target);return target;}
    const binding=reexports.get(file)?.get(name);
    if(binding){const target=exported(binding.file,binding.name,next);if(target)exports.set(key,target);return target;}
    for(const star of starExports.get(file)??[]){const target=exported(star,name,next);if(target){exports.set(key,target);return target;}}
    if(seen.size===0)exports.set(key,null);
    return null;
  };
  type TaintNode={node:ts.Node;dependencies:TaintNode[];parents:Set<TaintNode>;protected:boolean};
  const taintGraph=new Map<ts.Node,TaintNode>(),pending:TaintNode[]=[];
  const link=(entry:TaintNode,node:ts.Node):void=>{
    const dependency=taintNode(node,node.getSourceFile().fileName);
    entry.dependencies.push(dependency);dependency.parents.add(entry);
    if(dependency.protected)pending.push(entry);
  };
  const taintNode = (node: ts.Node, file: string): TaintNode => {
    const held=taintGraph.get(node);if(held)return held;
    const entry:TaintNode={node,dependencies:[],parents:new Set(),protected:false};
    taintGraph.set(node,entry);metrics.taintNodes++;
    if(ts.isTypeOperatorNode(node)&&node.operator===ts.SyntaxKind.KeyOfKeyword)return entry;
    const literal = value(node, file, new Set());
    if (literal !== null && protectedSql(literal)) pending.push(entry);
    if (ts.isIdentifier(node)) {
      const local = declarationOf(node);
      if (local) {if(!ts.isParameter(local)&&!ts.isTypeAliasDeclaration(local)&&!ts.isInterfaceDeclaration(local)&&!ts.isTypeParameterDeclaration(local))link(entry,local);return entry;}
      const source = imported(file, node.text);
      const target = source && exported(source.file, source.name);
      if(target)link(entry,target.node);return entry;
    }
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {link(entry,node.body);return entry;}
      const returns: ts.ReturnStatement[] = [];
      const collect = (child: ts.Node): void => {
        if (child !== node && (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child))) return;
        if (ts.isReturnStatement(child)) returns.push(child);
        ts.forEachChild(child, collect);
      };
      collect(node);
      for(const statement of returns)if(statement.expression)link(entry,statement.expression);
      return entry;
    }
    if (ts.isCallExpression(node)) {
      if (!(ts.isPropertyAccessExpression(node.expression) && ['prepare', 'first', 'all', 'run', 'batch'].includes(node.expression.name.text)))link(entry,node.expression);
      return entry;
    }
    ts.forEachChild(node,child=>{link(entry,child);});return entry;
  };
  const tainted=(node:ts.Node,file:string):boolean=>{
    const entry=taintNode(node,file);
    while(pending.length){const at=pending.pop()!;if(at.protected)continue;at.protected=true;pending.push(...at.parents);}
    return entry.protected;
  };
  const references=new Map<ts.Node,readonly ts.Node[]>();
  const referenced=(node:ts.Node):readonly ts.Node[]=>{
    const cached=references.get(node);if(cached)return cached;
    const children:ts.Node[]=[];
    references.set(node,children);
    if(ts.isIdentifier(node)){
      const declaration=declarationOf(node);
      if(declaration&&!ts.isParameter(declaration)&&!ts.isTypeAliasDeclaration(declaration)&&!ts.isInterfaceDeclaration(declaration)&&!ts.isTypeParameterDeclaration(declaration)&&files.has(declaration.getSourceFile().fileName))children.push(declaration);
      if(!declaration||ts.isImportSpecifier(declaration)){
        const source=imported(node.getSourceFile().fileName,node.text),target=source&&exported(source.file,source.name);
        if(target)children.push(target.node);
      }
    }else ts.forEachChild(node,child=>{if(!ts.isTypeNode(child))children.push(child);});
    return children;
  };
  const dependencies=(node:ts.Node):NonNullable<StatementException['dependencies']>=>{
    const seen=new Set<ts.Node>(),found=new Map<ts.Node,{file:string;name:string;sha256:string}>();
    const collect=(node:ts.Node):void=>{
      if(seen.has(node))return;
      seen.add(node);
      const declaration=declarationNames.get(node);
      if(declaration)found.set(node,{...declaration,sha256:createHash('sha256').update(node.getText(node.getSourceFile())).digest('hex')});
      for(const dependency of referenced(node))collect(dependency);
    };
    collect(node);
    return [...found.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256));
  };
  const callableName=(node:ts.SignatureDeclaration):string|undefined=>{
    if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isMethodSignature(node)||ts.isGetAccessorDeclaration(node))&&node.name)return node.name.getText(node.getSourceFile());
    if((ts.isArrowFunction(node)||ts.isFunctionExpression(node))&&ts.isVariableDeclaration(node.parent))return node.parent.name.getText(node.getSourceFile());
    return undefined;
  };
  const sinkDeclarations=new Map<string,Set<ts.Node>>(),contractImplementations=new Set<ts.Node>();
  const rememberParameter=(identity:SinkParameter,fn:ts.Node):SinkParameter=>{const key=JSON.stringify([identity.file,identity.owner,identity.index]),held=sinkDeclarations.get(key)??new Set();held.add(fn);sinkDeclarations.set(key,held);return identity;};
  const parameterIdentity=(node:ts.ParameterDeclaration):SinkParameter|undefined=>{
    const fn=node.parent;
    if(!ts.isFunctionLike(fn)&&!ts.isMethodSignature(fn)&&!ts.isFunctionTypeNode(fn))return;
    if((ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))&&ts.isPropertyAssignment(fn.parent)){
      const contextual=checker.getContextualType(fn)?.getCallSignatures()[0]?.declaration;
      if(contextual&&contextual!==fn){const parameter=contextual.parameters[fn.parameters.indexOf(node)];if(parameter&&ts.isParameter(parameter)){const identity=parameterIdentity(parameter);if(identity)contractImplementations.add(fn);return identity&&rememberParameter(identity,fn);}}
    }
    if(ts.isMethodDeclaration(fn)&&ts.isObjectLiteralExpression(fn.parent)&&fn.name&&ts.isIdentifier(fn.name)){
      const objectType=checker.getContextualType(fn.parent),member=objectType?.getProperty(fn.name.text),signature=member&&checker.getTypeOfSymbolAtLocation(member,fn).getCallSignatures()[0]?.declaration;
      const parameter=signature?.parameters[fn.parameters.indexOf(node)];
      if(parameter&&ts.isParameter(parameter)&&signature!==fn){const identity=parameterIdentity(parameter);if(identity){contractImplementations.add(fn);return rememberParameter(identity,fn);}}
    }
    const owner=callableName(fn);if(owner)return rememberParameter({file:node.getSourceFile().fileName,owner,index:fn.parameters.indexOf(node),path:[]},fn);
  };
  const activeParameters=(node:ts.Node,parameters:readonly SinkParameter[]):SinkParameter[]=>{
    const ancestors=new Set<ts.Node>();for(let at:ts.Node|undefined=node.parent;at;at=at.parent)if(ts.isFunctionLike(at))ancestors.add(at);
    return parameters.filter(parameter=>[...(sinkDeclarations.get(JSON.stringify([parameter.file,parameter.owner,parameter.index]))??[])].some(declaration=>ancestors.has(declaration)));
  };
  type Bound={node:ts.Node;environment:Environment;path:readonly string[];rest?:readonly ts.Expression[]};
  type Environment=ReadonlyMap<ts.Node,Bound>;
  type Invocation={call:ts.CallExpression;environment:Environment};
  const emptyEnvironment:Environment=new Map();
  const closedCache=new Map<ts.Node,Map<string,{dependencies:NonNullable<StatementException['dependencies']>;parameters:SinkParameter[];unresolved:string[]}>>();
  const closed=(start:ts.Node,projection:readonly string[]=[])=>{
    const cacheKey=JSON.stringify(projection),cached=closedCache.get(start)?.get(cacheKey);if(cached)return cached;
    const activeVariables=new Map<ts.Node,Set<string>>(),seen=new Map<Environment,Map<ts.Node,Set<string>>>(),activeFunctions=new Set<ts.Node>(),pins=new Map<string,{file:string;name:string;sha256:string}>(),parameters=new Map<string,SinkParameter>(),unresolved=new Set<string>();
    const pin=(node:ts.Node,name:string)=>{
      const file=node.getSourceFile().fileName,entry={file,name,sha256:createHash('sha256').update(node.getText(node.getSourceFile())).digest('hex')};pins.set(JSON.stringify(entry),entry);
    };
    const writes=(node:ts.VariableDeclaration|ts.ParameterDeclaration):{value:ts.Expression;element:boolean}[]=>{
      let scope:ts.Node=node.parent;while(scope.parent&&!ts.isFunctionLike(scope)&&!ts.isSourceFile(scope))scope=scope.parent;
      const assignments:{value:ts.Expression;element:boolean}[]=[];
      const collect=(at:ts.Node):void=>{
        const refers=(value:ts.Node)=>ts.isIdentifier(value)&&declarationOf(value)===(ts.isVariableDeclaration(node)?node.initializer??node:node);
        if(ts.isBinaryExpression(at)&&at.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&at.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&(refers(at.left)||(ts.isPropertyAccessExpression(at.left)||ts.isElementAccessExpression(at.left))&&refers(at.left.expression))){pin(at,node.name.getText());assignments.push({value:at.right,element:ts.isElementAccessExpression(at.left)});}
        if(ts.isCallExpression(at)&&ts.isPropertyAccessExpression(at.expression)&&refers(at.expression.expression)&&['push','unshift','splice','fill'].includes(at.expression.name.text)){pin(at,node.name.getText());assignments.push(...at.arguments.slice(at.expression.name.text==='splice'?2:0).map(value=>({value,element:true})));}
        ts.forEachChild(at,collect);
      };collect(scope);return assignments;
    };
    let controls=0;
    const asControl=(node:ts.Node,environment:Environment):void=>{controls++;try{follow(node,environment);}finally{controls--;}};
    const follow=(node:ts.Node,environment:Environment=emptyEnvironment,path:readonly string[]=[],invocation?:Invocation):void=>{
      if(ts.isTypeNode(node))return;
      if(node.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/')){pin(node,ts.isVariableDeclaration(node)||ts.isFunctionDeclaration(node)||ts.isMethodSignature(node)?node.name?.getText()??ts.SyntaxKind[node.kind]:ts.SyntaxKind[node.kind]);return;}
      const visited=seen.get(environment)??new Map<ts.Node,Set<string>>(),held=visited.get(node)??new Set<string>(),key=JSON.stringify([path,invocation?.call.pos,controls>0]);
      if(held.has(key))return;held.add(key);visited.set(node,held);seen.set(environment,visited);
      if(ts.isIdentifier(node)){
        const parent=node.parent;
        if((ts.isPropertyAccessExpression(parent)&&parent.name===node)||(ts.isPropertyAssignment(parent)&&parent.name===node))return;
        if(ts.isVariableDeclaration(parent)&&parent.name===node||ts.isParameter(parent)&&parent.name===node)return;
        if(!controls){
          const type=checker.getTypeAtLocation(node),literal=type.isUnion()?type.types.every(value=>Boolean(value.flags&ts.TypeFlags.StringLiteral)):Boolean(type.flags&ts.TypeFlags.StringLiteral);
          let fn:ts.Node|undefined=node.parent;while(fn&&!ts.isFunctionLike(fn))fn=fn.parent;
          if(literal&&fn&&'body'in fn&&fn.body&&ts.isBlock(fn.body))for(const statement of fn.body.statements){
            if(statement.getStart()>node.getStart()||!ts.isIfStatement(statement)||!ts.isPrefixUnaryExpression(statement.expression)||statement.expression.operator!==ts.SyntaxKind.ExclamationToken)continue;
            const call=statement.expression.operand,refuses=ts.isReturnStatement(statement.thenStatement)||ts.isThrowStatement(statement.thenStatement)||ts.isBlock(statement.thenStatement)&&statement.thenStatement.statements.some(value=>ts.isReturnStatement(value)||ts.isThrowStatement(value));
            if(!refuses||!ts.isCallExpression(call)||call.arguments.length!==1||!ts.isIdentifier(call.arguments[0]!)||declarationOf(call.arguments[0]!)!==declarationOf(node))continue;
            const guard=checker.getResolvedSignature(call)?.declaration;if(!guard||!ts.isFunctionDeclaration(guard)||!guard.body||guard.parameters.length!==1||guard.body.statements.length!==1)continue;
            const returned=guard.body.statements[0];if(!returned||!ts.isReturnStatement(returned)||!returned.expression||!ts.isCallExpression(returned.expression))continue;
            const check=returned.expression;if(check.expression.getText()!=='Object.hasOwn'||!ts.isPropertyAccessExpression(check.expression)||!ts.isIdentifier(check.expression.expression)||(declarationOf(check.expression.expression)&&!declarationOf(check.expression.expression)!.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/'))||check.arguments.length!==2||!ts.isIdentifier(check.arguments[0]!)||!ts.isIdentifier(check.arguments[1]!)||declarationOf(check.arguments[1]!)!==guard.parameters[0])continue;
            let domain=declarationOf(check.arguments[0]!);while(domain&&(ts.isAsExpression(domain)||ts.isSatisfiesExpression(domain)||ts.isParenthesizedExpression(domain)))domain=domain.expression;
            if(!domain||!ts.isObjectLiteralExpression(domain)||domain.properties.some(value=>!value.name||!ts.isIdentifier(value.name)&&!ts.isStringLiteralLike(value.name)&&!ts.isNumericLiteral(value.name)))continue;
            pin(guard,guard.name?.text??'<guard>');pin(fn,'<guarded function>');follow(check.arguments[0]!,environment);asControl(node,environment);return;
          }
        }
        const namespace=checker.getSymbolAtLocation(node)?.declarations?.find(ts.isNamespaceImport);
        if(namespace){follow(namespace,environment,path,invocation);return;}
        const declaration=declarationOf(node);
        if(declaration){follow(ts.isVariableDeclaration(declaration.parent)&&declaration.parent.initializer===declaration?declaration.parent:declaration,environment,path,invocation);return;}
        const source=imported(node.getSourceFile().fileName,node.text),target=source&&exported(source.file,source.name);
        if(target){follow(target.node,environment,path,invocation);return;}
        if(controls&&source){const declaration=checker.getSymbolAtLocation(node)?.declarations?.find(ts.isImportSpecifier);if(declaration){pin(declaration.parent.parent.parent,node.text);return;}}
        if(node.text==='undefined')return;
        const builtin=builtinDeclarations.get(node.text);if(builtin){pin(builtin,node.text);return;}
        unresolved.add(node.getSourceFile().fileName+':'+node.text);return;
      }
      if(ts.isParameter(node)){
        pin(node,node.name.getText());
        if(node.initializer)follow(node.initializer,environment,path,invocation);
        if(controls){pin(node,node.name.getText());return;}
        if(ts.isFunctionLike(node.parent)&&'body'in node.parent&&node.parent.body)pin(node.parent,'<SQL parameter function>');
        for(const {value,element} of writes(node))follow(value,environment,element&&(path[0]==='*'||/^\d+$/.test(path[0]??''))?path.slice(1):path,invocation);
        const bound=environment.get(node);if(bound){const projection=[...bound.path,...path];if(bound.rest){const numeric=/^\d+$/.test(projection[0]??''),values=numeric?[bound.rest[Number(projection[0])]].filter((value):value is ts.Expression=>value!==undefined):bound.rest;for(const value of values)follow(value,bound.environment,numeric||projection[0]==='*'?projection.slice(1):projection,invocation);}else follow(bound.node,bound.environment,projection,invocation);return;}
        if(node.dotDotDotToken){unresolved.add(node.getSourceFile().fileName+':variadic SQL parameter '+node.name.getText());return;}
        const fn=node.parent,call=fn.parent;
        if((ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))&&ts.isCallExpression(call)&&ts.isPropertyAccessExpression(call.expression)&&['map','flatMap','filter','some','every','find','forEach','reduce','replace','replaceAll'].includes(call.expression.name.text)){
          follow(call.expression.expression,environment,path,invocation);return;
        }
        if((ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))&&ts.isCallExpression(call)){
          const declaration=checker.getResolvedSignature(call)?.declaration,index=call.arguments.indexOf(fn),callback=declaration?.parameters[index];
          if(declaration&&callback&&ts.isParameter(callback)){
            const bound=new Map(environment);declaration.parameters.forEach((parameter,index)=>{const argument=call.arguments[index];if(argument)bound.set(parameter,{node:argument,environment,path:[]});});
            const arguments_:ts.Expression[]=[];
            const inspect=(at:ts.Node):void=>{if(ts.isCallExpression(at)&&ts.isIdentifier(at.expression)&&declarationOf(at.expression)===callback){const argument=at.arguments[fn.parameters.indexOf(node)];if(argument)arguments_.push(argument);}ts.forEachChild(at,inspect);};inspect(declaration);
            if(arguments_.length){pin(declaration,'<callback>');for(const argument of arguments_)follow(argument,bound,path,invocation);return;}
          }
        }
        const identity=parameterIdentity(node);
        if(identity){identity.path=path;parameters.set(JSON.stringify(identity),identity);}else unresolved.add(node.getSourceFile().fileName+':parameter '+node.name.getText());
        return;
      }
      if(ts.isBindingElement(node)){
        const names:string[]=[];let at:ts.Node=node;
        while(ts.isBindingElement(at)){names.unshift(ts.isArrayBindingPattern(at.parent)?String(at.parent.elements.indexOf(at)):at.propertyName?.getText()??at.name.getText());at=at.parent.parent;}
        pin(node,node.name.getText());follow(at,environment,[...names,...path],invocation);return;
      }
      if(ts.isVariableDeclaration(node)){
        const held=activeVariables.get(node)??new Set<string>(),identity=JSON.stringify([path,controls>0]);if(held.has(identity)||controls>0&&held.size)return;if(held.size){unresolved.add(node.getSourceFile().fileName+':cyclic SQL projection '+node.name.getText());return;}held.add(identity);activeVariables.set(node,held);
        try{
        pin(node,node.name.getText());
        if(ts.isVariableDeclarationList(node.parent)&&(ts.isForOfStatement(node.parent.parent)||ts.isForInStatement(node.parent.parent))){follow(node.parent.parent.expression,environment,['*',...path],invocation);return;}
        const assignments=writes(node);
        if(node.initializer)follow(node.initializer,environment,path,invocation);
        if(assignments.length||node.initializer){for(const {value,element} of assignments)follow(value,environment,element&&(path[0]==='*'||/^\d+$/.test(path[0]??''))?path.slice(1):path,invocation);return;}
        unresolved.add(node.getSourceFile().fileName+':uninitialized '+node.name.getText());return;
        }finally{held.delete(identity);}
      }
      if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
        const field=ts.isPropertyAccessExpression(node)?node.name.text:ts.isStringLiteralLike(node.argumentExpression)||ts.isNumericLiteral(node.argumentExpression)?node.argumentExpression.text:'*';
        if(field==='*'&&ts.isElementAccessExpression(node))asControl(node.argumentExpression,environment);
        if(field==='length'){asControl(node.expression,environment);return;}
        let symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node)?node.name:node.argumentExpression);if(symbol&&(symbol.flags&ts.SymbolFlags.Alias))symbol=checker.getAliasedSymbol(symbol);
        const declaration=symbol?.valueDeclaration;
        if(declaration&&(ts.isMethodDeclaration(declaration)||ts.isGetAccessorDeclaration(declaration)||ts.isPropertyDeclaration(declaration))){follow(declaration,environment,path,invocation);return;}
        follow(node.expression,environment,[field,...path],invocation);return;
      }
      if(ts.isObjectLiteralExpression(node)&&path.length){
        pin(node,'<object>');let found=false;
        for(const property of node.properties){
          if(ts.isSpreadAssignment(property)){follow(property.expression,environment,path,invocation);found=true;continue;}
          const name=property.name&&(ts.isIdentifier(property.name)||ts.isStringLiteralLike(property.name)||ts.isNumericLiteral(property.name))?property.name.text:undefined;
          if(name===path[0]||path[0]==='*'){follow(property,environment,path.slice(1),invocation);found=true;}
        }
        if(!found)pin(node,'<absent member '+path.join('.')+'>');return;
      }
      if(ts.isArrayLiteralExpression(node)){const numeric=/^\d+$/.test(path[0]??''),selected=path[0]==='*'||numeric?path.slice(1):path;const items=numeric?[node.elements[Number(path[0])]].filter((item):item is ts.Expression=>item!==undefined):node.elements;for(const item of items)follow(item,environment,selected,invocation);return;}
      if(ts.isTemplateExpression(node)&&node.head.text==="'"&&node.templateSpans.length===1&&node.templateSpans[0]!.literal.text==="'"){
        const value=node.templateSpans[0]!.expression;
        const escaped=ts.isCallExpression(value)&&ts.isPropertyAccessExpression(value.expression)&&value.expression.name.text==='replaceAll'&&value.arguments.length===2&&ts.isStringLiteralLike(value.arguments[0]!)&&value.arguments[0]!.text==="'"&&ts.isStringLiteralLike(value.arguments[1]!)&&value.arguments[1]!.text==="''";
        let fn:ts.Node|undefined=node.parent;while(fn&&!ts.isFunctionLike(fn))fn=fn.parent;
        let grammar:ts.Node|undefined;
        if(ts.isIdentifier(value)&&fn&&'body'in fn&&fn.body&&ts.isBlock(fn.body))for(const statement of fn.body.statements){
          if(statement.getStart()>node.getStart()||!ts.isIfStatement(statement)||!ts.isPrefixUnaryExpression(statement.expression)||statement.expression.operator!==ts.SyntaxKind.ExclamationToken)continue;
          const call=statement.expression.operand;
          if(!ts.isCallExpression(call)||!ts.isPropertyAccessExpression(call.expression)||call.expression.name.text!=='test'||call.arguments.length!==1||!ts.isIdentifier(call.arguments[0]!)||declarationOf(call.arguments[0]!)!==declarationOf(value))continue;
          const refused=ts.isThrowStatement(statement.thenStatement)||ts.isBlock(statement.thenStatement)&&statement.thenStatement.statements.some(ts.isThrowStatement);
          const pattern=ts.isIdentifier(call.expression.expression)?declarationOf(call.expression.expression):call.expression.expression;
          if(!refused||!pattern||!ts.isRegularExpressionLiteral(pattern))continue;
          const text=pattern.getText(),parts=/^\/\^\[([^\]]+)\](?:\+|\*|\{\d+(?:,\d*)?\})\$\/([a-z]*)$/.exec(text);
          if(parts&&!parts[2]!.includes('m')&&!new RegExp('['+parts[1]+']',parts[2]).test("'"))grammar=pattern;
        }
        if(escaped||grammar){if(grammar){follow(grammar,environment);if(fn)pin(fn,ts.isFunctionLike(fn)?callableName(fn)??'<function>':'<scope>');}asControl(value,environment);return;}
      }
      if(ts.isConditionalExpression(node)){
        let selected:ts.Expression=node.whenTrue;while(ts.isAsExpression(selected)||ts.isParenthesizedExpression(selected))selected=selected.expression;
        let domain:ts.Expression|undefined;
        if(ts.isIdentifier(selected)){
          const subject=declarationOf(selected);
          const inspect=(condition:ts.Node):void=>{
            if(ts.isBinaryExpression(condition)&&condition.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken){inspect(condition.left);inspect(condition.right);}
            if(ts.isCallExpression(condition)&&ts.isPropertyAccessExpression(condition.expression)&&condition.arguments.length===2&&ts.isIdentifier(condition.expression.expression)&&condition.expression.expression.text==='Object'&&(!declarationOf(condition.expression.expression)||declarationOf(condition.expression.expression)!.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/'))&&condition.expression.name.text==='hasOwn'&&ts.isIdentifier(condition.arguments[1]!)&&declarationOf(condition.arguments[1]!)===subject)domain=condition.arguments[0];
          };inspect(node.condition);
        }
        asControl(node.condition,environment);
        if(domain)follow(domain,environment,path,invocation);else follow(node.whenTrue,environment,path,invocation);
        follow(node.whenFalse,environment,path,invocation);return;
      }
      if(ts.isYieldExpression(node)){if(controls)pin(node,'<yield result>');else unresolved.add(node.getSourceFile().fileName+':resumed generator SQL value');return;}
      if(ts.isBinaryExpression(node)&&![ts.SyntaxKind.PlusToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.CommaToken,ts.SyntaxKind.EqualsToken,ts.SyntaxKind.PlusEqualsToken,ts.SyntaxKind.BarBarEqualsToken,ts.SyntaxKind.AmpersandAmpersandEqualsToken,ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)){asControl(node.left,environment);asControl(node.right,environment);return;}
      if(ts.isPropertyAssignment(node)){pin(node,node.name.getText());follow(node.initializer,environment,path,invocation);return;}
      if(ts.isShorthandPropertyAssignment(node)){pin(node,node.name.text);const symbol=checker.getShorthandAssignmentValueSymbol(node),declaration=symbol?.valueDeclaration;if(declaration)follow(declaration,environment,path,invocation);else unresolved.add(node.getSourceFile().fileName+':shorthand '+node.name.text);return;}
      if(ts.isPropertyDeclaration(node)){pin(node,node.name.getText());if(node.initializer)follow(node.initializer,environment,path,invocation);else unresolved.add(node.getSourceFile().fileName+':field '+node.name.getText());return;}
      if(ts.isCallExpression(node)){
        if(ts.isCallExpression(node.expression)){unresolved.add(node.getSourceFile().fileName+':returned callable '+node.expression.getText());return;}
        let root:ts.Expression=node.expression;while(ts.isPropertyAccessExpression(root))root=root.expression;
        if(ts.isIdentifier(root)&&builtinDeclarations.has(root.text)&&(!declarationOf(root)||declarationOf(root)!.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/'))){
          let guarded=false;
          if(root.text==='String'&&node.arguments.length===1&&ts.isIdentifier(node.arguments[0]!)){
            const value=node.arguments[0]!,subject=declarationOf(value);let fn:ts.Node|undefined=node.parent;while(fn&&!ts.isFunctionLike(fn))fn=fn.parent;
            if(fn&&'body'in fn&&fn.body&&ts.isBlock(fn.body))for(const statement of fn.body.statements){
              if(statement.getStart()>node.getStart()||!ts.isIfStatement(statement))continue;
              const negative=(condition:ts.Expression):boolean=>ts.isBinaryExpression(condition)&&condition.operatorToken.kind===ts.SyntaxKind.BarBarToken?negative(condition.left)||negative(condition.right):ts.isPrefixUnaryExpression(condition)&&condition.operator===ts.SyntaxKind.ExclamationToken&&ts.isCallExpression(condition.operand)&&condition.operand.expression.getText()==='Number.isSafeInteger'&&condition.operand.arguments.length===1&&ts.isIdentifier(condition.operand.arguments[0]!)&&declarationOf(condition.operand.arguments[0]!)===subject;
              if(negative(statement.expression)&&(ts.isThrowStatement(statement.thenStatement)||ts.isBlock(statement.thenStatement)&&statement.thenStatement.statements.some(ts.isThrowStatement))){guarded=true;pin(fn,ts.isFunctionLike(fn)?callableName(fn)??'<function>':'<scope>');}
            }
          }
          follow(node.expression,environment);for(const argument of node.arguments)if(guarded||['Math','Number','parseInt','parseFloat'].includes(root.text)||root.text==='Date'&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='now')asControl(argument,environment);else follow(argument,environment,path);return;
        }
        if(ts.isPropertyAccessExpression(node.expression)&&['map','flatMap','filter','find','some','every','forEach','reduce','join','slice','concat','replace','replaceAll','toString','toLowerCase','toUpperCase'].includes(node.expression.name.text)&&checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/')){
          const method=node.expression.name.text;
          if(['map','flatMap','forEach','some','every'].includes(method))asControl(node.expression.expression,environment);else follow(node.expression.expression,environment,path);
          const callback=node.arguments[0],declaration=callback&&ts.isIdentifier(callback)?declarationOf(callback):undefined;
          if(method==='map'&&node.arguments.length===1&&declaration&&(ts.isFunctionDeclaration(declaration)||ts.isFunctionExpression(declaration)||ts.isArrowFunction(declaration))&&declaration.parameters.length===1&&checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/')){
            const bound=new Map(environment);bound.set(declaration.parameters[0]!,{node:node.expression.expression,environment,path:[]});follow(declaration,bound,path);return;
          }
          for(const argument of node.arguments)if(['filter','find','some','every','slice'].includes(method))asControl(argument,environment);else follow(argument,environment,path);return;
        }
        follow(node.expression,environment,path,{call:node,environment});return;
      }
      const identity=declarationNames.get(node);if(identity)pin(node,identity.name);
      if(ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)){
        pin(node,node.name?.getText()??'<function>');
        if(!node.body){
          const implementation=node.name&&checker.getSymbolAtLocation(node.name)?.declarations?.find(declaration=>(ts.isFunctionDeclaration(declaration)||ts.isMethodDeclaration(declaration))&&declaration.body);
          if(implementation&&implementation!==node)follow(implementation,environment,path,invocation);else unresolved.add(node.getSourceFile().fileName+':function implementation '+(callableName(node)??'<function>'));return;
        }
        const generator='asteriskToken'in node&&Boolean(node.asteriskToken),selection=path[0]==='*'?path.slice(1):['next','throw'].includes(path[0]??'')&&path[1]==='value'?path.slice(2):undefined;
        if(generator&&(!selection||node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword))){unresolved.add(node.getSourceFile().fileName+':unresolved generator SQL projection '+(callableName(node)??'<function>'));return;}
        if(activeFunctions.has(node)){unresolved.add(node.getSourceFile().fileName+':recursive '+(callableName(node)??'<function>'));return;}
        let next=environment;
        if(invocation){
          if(invocation.call.arguments.some(ts.isSpreadElement)){unresolved.add(node.getSourceFile().fileName+':spread SQL invocation '+invocation.call.expression.getText());return;}
          const bound=new Map(environment);node.parameters.forEach((parameter,index)=>{const argument=invocation.call.arguments[index]??parameter.initializer;if(parameter.dotDotDotToken)bound.set(parameter,{node:parameter,environment:invocation.environment,path:[],rest:invocation.call.arguments.slice(index)});else if(argument)bound.set(parameter,{node:argument,environment:invocation.environment,path:[]});});next=bound;
        }
        activeFunctions.add(node);
        if(ts.isArrowFunction(node)&&!ts.isBlock(node.body))follow(node.body,next,path);
        else {const returns=(at:ts.Node):void=>{if(at!==node&&ts.isFunctionLike(at))return;if(generator&&ts.isYieldExpression(at)){if(at.expression)follow(at.expression,next,at.asteriskToken?['*',...selection!]:selection!);}else if(ts.isReturnStatement(at)&&at.expression)follow(at.expression,next,generator?selection!:path);else ts.forEachChild(at,returns);};returns(node);}
        activeFunctions.delete(node);return;
      }
      if(ts.isImportSpecifier(node)){
        const source=node.parent.parent.parent;
        const target=ts.isImportDeclaration(source)&&ts.isStringLiteral(source.moduleSpecifier)&&exported(moduleFile(node.getSourceFile().fileName,source.moduleSpecifier.text),node.propertyName?.text??node.name.text);
        if(target){follow(target.node,environment,path,invocation);return;}
        unresolved.add(node.getSourceFile().fileName+':import '+node.name.text);return;
      }
      if(ts.isNamespaceImport(node)){
        const source=node.parent.parent,target=path[0]&&ts.isImportDeclaration(source)&&ts.isStringLiteral(source.moduleSpecifier)&&exported(moduleFile(node.getSourceFile().fileName,source.moduleSpecifier.text),path[0]);
        if(target){follow(target.node,environment,path.slice(1),invocation);return;}
        unresolved.add(node.getSourceFile().fileName+':namespace '+node.name.text);return;
      }
      if(ts.isClassDeclaration(node)){
        pin(node,node.name?.text??'<class>');const members=path.length?node.members.filter(member=>member.name?.getText()===path[0]):node.members;
        if(!members.length)unresolved.add(node.getSourceFile().fileName+':class member '+path[0]);
        for(const member of members)if(ts.isMethodDeclaration(member)||ts.isGetAccessorDeclaration(member)||ts.isPropertyDeclaration(member))follow(member,environment,path.slice(1),invocation);return;
      }
      if(ts.isEnumDeclaration(node)){pin(node,node.name.text);for(const member of node.members)if(!path.length||path[0]==='*'||member.name.getText()===path[0])follow(member,environment,path.slice(1),invocation);return;}
      if(ts.isEnumMember(node)){pin(node,node.name.getText());if(node.initializer)follow(node.initializer,environment,path,invocation);return;}
      if(ts.isImportClause(node)||ts.isImportEqualsDeclaration(node)){unresolved.add(node.getSourceFile().fileName+':import '+(node.name?.getText()??'<default>'));return;}
      if(ts.isLiteralExpression(node)||node.kind===ts.SyntaxKind.TrueKeyword||node.kind===ts.SyntaxKind.FalseKeyword||node.kind===ts.SyntaxKind.NullKeyword)return;
      if(ts.isTemplateExpression(node)){for(const span of node.templateSpans)follow(span.expression,environment,path,invocation);return;}
      if(ts.isBinaryExpression(node)){follow(node.left,environment,path,invocation);follow(node.right,environment,path,invocation);return;}
      if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isSatisfiesExpression(node)||ts.isNonNullExpression(node)||ts.isAwaitExpression(node)||ts.isSpreadElement(node)){follow(node.expression,environment,path,invocation);return;}
      if(ts.isObjectLiteralExpression(node)){pin(node,'<object>');for(const property of node.properties)follow(property,environment,path,invocation);return;}
      if(ts.isSpreadAssignment(node)){follow(node.expression,environment,path,invocation);return;}
      if(ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node)){asControl(node.operand,environment);return;}
      if(ts.isTypeOfExpression(node)||ts.isVoidExpression(node)||ts.isDeleteExpression(node)){asControl(node.expression,environment);return;}
      if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&['Map','Set','Array','RegExp','String','Number','TextEncoder','Uint8Array','ArrayBuffer','WeakMap','WeakSet','Float32Array','Float64Array','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Date'].includes(node.expression.text)&&(!declarationOf(node.expression)||declarationOf(node.expression)!.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/'))){
        follow(node.expression,environment);const projection=['get','keys','values','entries'].includes(path[0]??'')?path.slice(1):path;for(const argument of node.arguments??[])follow(argument,environment,projection,invocation);return;
      }
      if(controls&&ts.isNewExpression(node)&&ts.isIdentifier(node.expression)){const imported=checker.getSymbolAtLocation(node.expression)?.declarations?.find(ts.isImportSpecifier);if(imported){pin(imported.parent.parent.parent,node.expression.text);for(const argument of node.arguments??[])asControl(argument,environment);return;}}
      unresolved.add(node.getSourceFile().fileName+':unsupported '+ts.SyntaxKind[node.kind]);
    };
    follow(start,emptyEnvironment,projection);
    const result={dependencies:[...pins.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256)),parameters:[...parameters.values()],unresolved:[...unresolved].sort()};const values=closedCache.get(start)??new Map();values.set(cacheKey,result);closedCache.set(start,values);return result;
  };
  const knownBearing=(file:string,name:string):boolean=>foundations.some(item=>item.owner===file && item.imports.includes(name));
  const bearingCache=new Map<string,boolean>();
  const bearing=(file:string,name:string):boolean=>{
    const key=file+'#'+name;if(bearingCache.has(key))return bearingCache.get(key)!;
    const target=exported(file,name);
    const result=knownBearing(file,name)||Boolean(target&&(knownBearing(target.file,target.name)||tainted(target.node,target.file)));
    bearingCache.set(key,result);return result;
  };
  const catalogInputs=(parameters:readonly SinkParameter[])=>parameters.filter(parameter=>{
    for(const fn of sinkDeclarations.get(JSON.stringify([parameter.file,parameter.owner,parameter.index]))??[]){
      if(!ts.isFunctionLike(fn)&&!ts.isMethodSignature(fn))continue;const argument=fn.parameters[parameter.index];if(!argument)continue;let type=checker.getTypeAtLocation(argument);
      for(const field of parameter.path){const member=type.getProperty(field);if(!member)break;if(['prepare','batch'].includes(field)&&member.declarations?.some(value=>value.getSourceFile().fileName==='packages/myco-server/src/core/adapters.ts'))return false;type=checker.getTypeOfSymbolAtLocation(member,argument);}
    }
    return true;
  });
  const frozenClosures:readonly ExceptionClosure[]=options.closures??sourcePins.closures;
  const frozenCallers:readonly ParameterCaller[]=options.callers??sourcePins.callers;
  const sinkParameters=new Map<string,SinkParameter>();
  const openParameters=new Set<string>();
  const calls:ts.CallExpression[]=[];
  const addParameters=(values:readonly SinkParameter[])=>{for(const value of values){const covered=[...sinkParameters.values()].some(existing=>existing.file===value.file&&existing.owner===value.owner&&existing.index===value.index&&existing.path.length<=value.path.length&&existing.path.every((part,index)=>part===value.path[index]));if(!covered)sinkParameters.set(JSON.stringify(value),value);}};
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
        if(ts.isCallExpression(node)&&/^packages\/[^/]+\/src\//.test(file)){
          if(moduleLoader(node.expression)&&!ts.isStringLiteralLike(node.arguments[0]))errors.push(file+': non-literal module specifier');
        }
        const specifier=value(node.arguments[0],file,new Set());
        const target=specifier===null?'':moduleFile(file,specifier);
        if(!file.startsWith('tests/')&&target.startsWith('tests/'))errors.push(file+': production imports test capability');
        if(target===recorder)errors.push(file+': dynamic oracle authority import');
      }

      ts.forEachChild(node,authority);
    };
    authority(tree);
    const visit = (node: ts.Node): void => {
      if(!options.importsOnly&&ts.isCallExpression(node))calls.push(node);
      if(!options.importsOnly&&ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['prepare','query','exec'].includes(node.expression.name.text)&&node.arguments[0]&&!preparation(node,tree))options.captureNonSql?.({file,owner:preparationOwner(ts,node,tree),expression:node.arguments[0].getText(tree)});
      if(options.capturePreparation&&ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&isSqlPreparation(ts,node,tree)&&node.arguments[0]){
        tainted(node.arguments[0],file);
        const relations=new Set<string>(),seen=new Set<TaintNode>();
        const collect=(entry:TaintNode):void=>{if(seen.has(entry))return;seen.add(entry);const text=value(entry.node,entry.node.getSourceFile().fileName,new Set());if(text!==null)for(const relation of protectedRelations(text))relations.add(relation);for(const dependency of entry.dependencies)collect(dependency);};
        collect(taintNode(node.arguments[0],file));
        options.capturePreparation({file,owner:preparationOwner(ts,node,tree),expression:node.arguments[0].getText(tree)},[...relations].sort());
      }
      if (!options.importsOnly && !own && ts.isStringLiteralLike(node) && node.text.includes('/*vs:')) errors.push(file + ': outside tag construction');
      if (!options.importsOnly && !own && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && preparation(node,tree) && node.arguments[0]) {
        const expression = node.arguments[0].getText(tree), owner = nodeName(node, tree);
        const exception=exceptions.find(item => item.file === file && item.owner === owner && item.expression === expression);
        const physicalOwner=preparationOwner(ts,node,tree);
        if(file.startsWith('packages/')&&(exception||preparationOrigins.some(item=>item.file===file&&item.owner===physicalOwner&&item.expression===expression))){
          const result=closed(node.arguments[0]),closure={file,owner:physicalOwner,expression,...result,activeParameters:activeParameters(node,result.parameters)};
          const open=OPEN_RELATION_PREPARATIONS.find(item=>item.file===file&&item.owner===physicalOwner&&item.expression===expression);
          if(open){closure.dependencies=[...result.dependencies,{file,name:physicalOwner,sha256:createHash('sha256').update(tree.text).digest('hex')}];closure.parameters=catalogInputs(result.parameters).filter(parameter=>parameter.file===file&&parameter.owner===physicalOwner);for(const parameter of closure.parameters)openParameters.add(JSON.stringify(parameter));}
          closure.activeParameters=activeParameters(node,closure.parameters);
          closure.dependencies=[...closure.dependencies].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256));
          options.captureClosure?.(closure);addParameters(closure.parameters);
          const expected=frozenClosures.find(item=>item.file===file&&item.owner===physicalOwner&&item.expression===expression);
          if(!open)for(const name of result.unresolved)errors.push(file+'#'+physicalOwner+': unresolved SQL dependency '+name);
          if(!expected&&result.dependencies.length)errors.push(file+'#'+physicalOwner+': missing frozen SQL closure');
          if(expected){
            if(JSON.stringify(expected.dependencies)!==JSON.stringify(closure.dependencies)||JSON.stringify(expected.parameters)!==JSON.stringify(closure.parameters)||JSON.stringify(expected.activeParameters??[])!==JSON.stringify(closure.activeParameters))errors.push(file+'#'+physicalOwner+': SQL closure differs');
          }
        }
        if(!exception){if(tainted(node.arguments[0],file)&&!frozenClosures.some(item=>item.file===file&&item.owner===physicalOwner&&item.expression===expression))errors.push(file + '#' + owner + ': protected SQL preparation outside owner');}
        else {
          const reached=dependencies(node.arguments[0]);
          options.captureDependencies?.(exception,reached);
          if(JSON.stringify(exception.dependencies??[])!==JSON.stringify(reached))errors.push(file+'#'+owner+': SQL exception dependencies differ');
        }
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
  const targetCache=new Map<ts.Node,{declarations:ts.SignatureDeclaration[];dependencies:SqlDeclarationPin[];storage:boolean;container:boolean;objects:ts.ObjectLiteralExpression[]}>();
  const callableTargets=(start:ts.Node)=>{
    const cached=targetCache.get(start);if(cached)return cached;
    const declarations=new Set<ts.SignatureDeclaration>(),pins=new Map<string,SqlDeclarationPin>(),seen=new Map<ts.Node,Set<string>>(),objects:ts.ObjectLiteralExpression[]=[];let storage=false,container=false;
    const pin=(node:ts.Node,name:string)=>{const entry={file:node.getSourceFile().fileName,name,sha256:createHash('sha256').update(node.getText()).digest('hex')};pins.set(JSON.stringify(entry),entry);};
    const follow=(node:ts.Node,path:readonly string[]=[]):void=>{
      const visited=seen.get(node)??new Set<string>(),key=JSON.stringify(path);if(visited.has(key))return;visited.add(key);seen.set(node,visited);
      if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isSatisfiesExpression(node)||ts.isNonNullExpression(node)){follow(node.expression,path);return;}
      if(ts.isIdentifier(node)){const declaration=declarationOf(node);if(declaration&&declaration!==node){if(declaration.parent&&ts.isVariableDeclaration(declaration.parent)&&declaration.parent.initializer===declaration)pin(declaration.parent,node.text);follow(declaration,path);}return;}
      if(ts.isVariableDeclaration(node)&&node.initializer){pin(node,node.name.getText());follow(node.initializer,path);return;}
      if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){const field=ts.isPropertyAccessExpression(node)?node.name.text:ts.isStringLiteralLike(node.argumentExpression)||ts.isNumericLiteral(node.argumentExpression)?node.argumentExpression.text:'*';follow(node.expression,[field,...path]);return;}
      if(ts.isObjectLiteralExpression(node)){storage=true;if(!path.length)container=true;objects.push(node);pin(node,'<dispatch>');for(const member of node.properties){const name=member.name&&(ts.isIdentifier(member.name)||ts.isStringLiteralLike(member.name)||ts.isNumericLiteral(member.name))?member.name.text:undefined;if(!path.length||path[0]==='*'||name===path[0])follow(member,path.slice(1));}return;}
      if(ts.isPropertyAssignment(node)){follow(node.initializer,path);return;}
      if(ts.isShorthandPropertyAssignment(node)){const declaration=checker.getShorthandAssignmentValueSymbol(node)?.valueDeclaration;if(declaration)follow(declaration,path);return;}
      if(ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)){if(!path.length)declarations.add(node);return;}
    };follow(start);
    const result={declarations:[...declarations],dependencies:[...pins.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256)),storage,container,objects};targetCache.set(start,result);return result;
  };
  const processedCalls=new Set<string>();
  const callHints=options.importsOnly?[]:calls.map(call=>{
    const name=ts.isIdentifier(call.expression)?call.expression:ts.isPropertyAccessExpression(call.expression)?call.expression.name:undefined;
    return {call,name:name?.text,declaration:name&&ts.isIdentifier(name)?declarationOf(name):undefined,targets:callableTargets(call.expression)};
  });
  const signatures=new Map<ts.CallExpression,ts.SignatureDeclaration|ts.JSDocSignature|undefined>();
  let count=-1;
  while(count!==sinkParameters.size){
    count=sinkParameters.size;
    const names=new Set([...sinkParameters.values()].map(sink=>sink.owner));
    for(const {call,name,declaration:hint,targets} of callHints){
      if(call.getSourceFile().fileName==='packages/myco-server/src/read/view-store.ts')continue;
      const target=hint&&(ts.isFunctionDeclaration(hint)||ts.isArrowFunction(hint)||ts.isFunctionExpression(hint)||ts.isMethodDeclaration(hint)||ts.isMethodSignature(hint))?callableName(hint):undefined;
      if(name!==undefined&&!names.has(name)&&(!target||!names.has(target))&&!targets.declarations.some(node=>names.has(callableName(node)??'')))continue;
      if(!signatures.has(call))signatures.set(call,checker.getResolvedSignature(call)?.declaration);
      const declared=signatures.get(call);
      for(const declaration of targets.storage?targets.declarations:declared?[declared]:[]){
      for(const [index,parameter]of declaration.parameters.entries()){
        if(!ts.isParameter(parameter))continue;
        const identityParameter=parameterIdentity(parameter),argument=call.arguments[index]??parameter.initializer;
        if(!identityParameter)continue;
        for(const sink of sinkParameters.values()){
        if(sink.file!==identityParameter.file||sink.owner!==identityParameter.owner||sink.index!==index)continue;
        const file=call.getSourceFile().fileName,owner=preparationOwner(ts,call,call.getSourceFile()),callee=call.expression.getText(),text=call.arguments[index]?.getText()??'<omitted>';
        const identity={file,owner,callee,argument:text,index,sink},key=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        if(processedCalls.has(key))continue;processedCalls.add(key);
        const result=argument?closed(argument,sink.path):{dependencies:[{file:parameter.getSourceFile().fileName,name:parameter.name.getText(),sha256:createHash('sha256').update(parameter.getText()).digest('hex')}],parameters:[],unresolved:parameter.questionToken||parameter.dotDotDotToken?[]:['missing SQL argument '+index]},caller={key,...identity,dependencies:result.dependencies,parameters:result.parameters,activeParameters:activeParameters(call,result.parameters)};
        const open=openParameters.has(JSON.stringify(sink))||OPEN_RELATION_PREPARATIONS.some(site=>site.file===file&&site.owner===owner&&site.expression===text);
        if(open){if(result.unresolved.length)caller.dependencies=[...result.dependencies,{file,name:owner,sha256:createHash('sha256').update(sources.get(file)!).digest('hex')}];caller.parameters=catalogInputs(result.parameters);for(const parameter of caller.parameters)openParameters.add(JSON.stringify(parameter));}
        caller.activeParameters=activeParameters(call,caller.parameters);
        if(targets.storage)caller.dependencies=[...caller.dependencies,...targets.dependencies].filter((pin,index,all)=>all.findIndex(value=>JSON.stringify(value)===JSON.stringify(pin))===index).sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256));
        caller.dependencies=[...caller.dependencies].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256));
        options.captureCaller?.(caller);addParameters(caller.parameters);
        if(/^packages\/[^/]+\/src\//.test(file)&&file!=='packages/myco-server/src/read/view-store.ts'){
          const expected=frozenCallers.find(item=>item.key===key);
          if(!expected)errors.push(file+'#'+owner+': unpinned SQL sink argument '+callee+'['+index+']');
          else if(JSON.stringify(expected.dependencies)!==JSON.stringify(caller.dependencies)||JSON.stringify(expected.activeParameters??[])!==JSON.stringify(caller.activeParameters))errors.push(file+'#'+owner+': SQL sink argument dependencies differ '+callee+'['+index+']');
          if(!open)for(const name of result.unresolved)errors.push(file+'#'+owner+': unresolved SQL sink argument '+name);
        }
        }
      }
      }
    }
  }
  const admittedCallbacks=new Set<ts.Node>();
  for(const call of calls)for(const [index,argument]of call.arguments.entries()){
    if(!ts.isIdentifier(argument))continue;const fn=declarationOf(argument);if(!fn)continue;
    const matching=[...sinkParameters.values()].filter(sink=>openParameters.has(JSON.stringify(sink))&&sinkDeclarations.get(JSON.stringify([sink.file,sink.owner,sink.index]))?.has(fn));if(!matching.length)continue;
    const declaration=checker.getResolvedSignature(call)?.declaration,parameter=declaration?.parameters[index];
    if(!declaration||!parameter||!checker.getTypeAtLocation(parameter).getCallSignatures().length)continue;
    for(const sink of matching){
      const file=call.getSourceFile().fileName,owner=preparationOwner(ts,call,call.getSourceFile()),identity={file,owner,callee:call.expression.getText(),argument:argument.getText(),index,sink},key=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const refs=[...dependencies(declaration),...dependencies(fn),{file,name:owner,sha256:createHash('sha256').update(sources.get(file)!).digest('hex')}],pins=new Map(refs.map(value=>[JSON.stringify(value),value]));
      const caller={key,...identity,dependencies:[...pins.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.name.localeCompare(b.name)||a.sha256.localeCompare(b.sha256)),parameters:[],activeParameters:[]};
      options.captureCaller?.(caller);const expected=frozenCallers.find(value=>value.key===key);
      if(/^packages\/[^/]+\/src\//.test(file)){if(!expected)errors.push(file+'#'+owner+': unpinned open SQL callback '+identity.callee);else if(JSON.stringify(expected.dependencies)!==JSON.stringify(caller.dependencies))errors.push(file+'#'+owner+': open SQL callback dependencies differ');}
      admittedCallbacks.add(argument);
    }
  }
  if(!options.importsOnly){
    const sinks=new Set<ts.Node>();
    for(const sink of sinkParameters.values())for(const declaration of sinkDeclarations.get(JSON.stringify([sink.file,sink.owner,sink.index]))??[])sinks.add(declaration);
    const storageCalls=callHints.filter(({targets})=>targets.storage&&targets.declarations.some(node=>sinks.has(node)&&(!targets.container||!contractImplementations.has(node)))),resolvedStorage=new Set(storageCalls.flatMap(({targets})=>targets.declarations)),objects=new Set(storageCalls.flatMap(({targets})=>targets.objects));
    for(const sink of sinks)if(/^packages\/[^/]+\/src\//.test(sink.getSourceFile().fileName)&&ts.isMethodDeclaration(sink)&&ts.isObjectLiteralExpression(sink.parent)&&!contractImplementations.has(sink)&&!resolvedStorage.has(sink))errors.push(sink.getSourceFile().fileName+'#'+callableName(sink)+': unresolved SQL sink storage');
    for(const [file,tree] of files){
      if(!/^packages\/[^/]+\/src\//.test(file)||file==='packages/myco-server/src/read/view-store.ts')continue;
      const inspect=(node:ts.Node):void=>{
        if(ts.isTypeNode(node)||ts.isImportDeclaration(node)||ts.isExportDeclaration(node))return;
        if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
          const targets=callableTargets(node);
          if(!targets.container&&targets.declarations.some(value=>sinks.has(value))){
            let use:ts.Node=node;while(ts.isParenthesizedExpression(use.parent)||ts.isAsExpression(use.parent)||ts.isNonNullExpression(use.parent)||ts.isTypeAssertionExpression(use.parent)||ts.isSatisfiesExpression(use.parent))use=use.parent;
            const parent=use.parent;
            const direct=ts.isCallExpression(parent)&&parent.expression===use&&storageCalls.some(entry=>entry.call===parent);
            const alias=ts.isVariableDeclaration(parent)&&parent.initializer===use;
            const compared=ts.isBinaryExpression(parent)&&[ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)||ts.isTypeOfExpression(parent);
            if(!direct&&!alias&&!compared)errors.push(file+'#'+preparationOwner(ts,node,tree)+': unresolved SQL sink member '+node.getText());
          }
        }
        if(ts.isIdentifier(node)){
          if(admittedCallbacks.has(node))return;
          const declaration=declarationOf(node);
          const stored=callableTargets(node),storedSink=stored.storage&&stored.declarations.some(value=>sinks.has(value)&&(!stored.container||!contractImplementations.has(value)));
          if(declaration&&(sinks.has(declaration)||storedSink)){
            if('name'in declaration&&declaration.name===node)return;
            if(ts.isPropertyAssignment(node.parent)&&node.parent.initializer===node&&objects.has(node.parent.parent))return;
            if(ts.isVariableDeclaration(node.parent)&&node.parent.name===node&&node.parent.initializer===declaration)return;
            let use:ts.Node=node;
            if(ts.isPropertyAccessExpression(use.parent)&&use.parent.name===use)use=use.parent;
            while(ts.isParenthesizedExpression(use.parent)||ts.isAsExpression(use.parent)||ts.isNonNullExpression(use.parent)||ts.isTypeAssertionExpression(use.parent)||ts.isSatisfiesExpression(use.parent))use=use.parent;
            if(storedSink){while((ts.isPropertyAccessExpression(use.parent)||ts.isElementAccessExpression(use.parent))&&use.parent.expression===use)use=use.parent;if(ts.isVariableDeclaration(use.parent)&&use.parent.initializer===use)return;}
            if(ts.isBinaryExpression(use.parent)&&[ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(use.parent.operatorToken.kind)||ts.isTypeOfExpression(use.parent))return;
            const call=use.parent;
            if(ts.isCallExpression(call)&&call.arguments.some(argument=>argument===use)&&call.expression.getText()==='Object.keys'&&checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName.startsWith('node_modules/typescript-v6/lib/'))return;
            if(!ts.isCallExpression(call)||call.expression!==use||!(checker.getResolvedSignature(call)?.declaration===declaration||storageCalls.some(entry=>entry.call===call)))errors.push(file+'#'+preparationOwner(ts,node,tree)+': unresolved SQL sink reference '+node.text);
          }
        }
        ts.forEachChild(node,inspect);
      };inspect(tree);
    }
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
