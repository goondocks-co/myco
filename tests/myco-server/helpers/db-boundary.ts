import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript-v6';

export interface BoundarySite {
  kind: 'prepare' | 'batch' | 'exec' | 'sql' | 'changes' | 'compile';
  line: number;
}

/** The SQL layer owns schema and migration emission as well as application statements. */
export const INFRASTRUCTURE = new Map<string, string>([
  ['platform/bun/sqlite.ts', 'Native RelationalStore adapter'],
  ['platform/bun/vectors.ts', 'Native vector storage adapter'],
  ['platform/bun/database.ts', 'Native SQLite connection configuration'],
  ['platform/bun/server-main.ts', 'Native volume startup and schema migration'],
  ['platform/bun/store-maintenance.ts', 'Native integrity and planner maintenance adapter'],
  ['platform/cloudflare/store-maintenance.ts', 'D1 integrity and planner maintenance adapter'],
  ['platform/cloudflare/recovery-producer-object.ts', 'Recovery Durable Object coordination storage: ctx.storage.sql'],
]);

/** Inside db/, only these may reach the store directly; everything else is a kernel definition run through commit. */
export const DB_STORE_ALLOWED = new Map<string, string>([
  ['db/kernel/statement.ts', 'Kernel: compiles every Bound'],
  ['db/kernel/commit.ts', 'Kernel: runs and reports every named batch and its guards'],
  ['db/kernel/guarded-store.ts', 'Kernel: a store decorator whose guarded batches carry their guard statements'],
  ['db/migrate.ts', 'Migrations: reads the version before any step applies'],
  ['db/meta/budget-activation.ts', 'Operator path: runs generated activation steps in order'],
]);

const FROZEN_SCHEMA = /^db\/schema-v\d+\.ts$/;
const STORE_KINDS: ReadonlySet<BoundarySite['kind']> = new Set(['prepare', 'batch', 'exec']);
const BOUND_COMPILERS = new Set(['prepareBound', 'prepareClaimCompanion']);

const namesType = (checker: ts.TypeChecker, type: ts.Type, name: string): boolean => {
  const awaited = checker.getAwaitedType(type) ?? type;
  if (awaited.isUnion()) return awaited.types.some(member => namesType(checker, member, name));
  if (checker.isTupleType(awaited)) return checker.getTypeArguments(awaited as ts.TypeReference).some(member => namesType(checker, member, name));
  return awaited.getSymbol()?.name === name || awaited.aliasSymbol?.name === name;
};

/** A call that turns a Bound into a PreparedStatement, under its known names or any other by its signature. */
function compilesBound(call: ts.CallExpression, checker?: ts.TypeChecker): boolean {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (BOUND_COMPILERS.has(callee.text)) return true;
  const signature = checker?.getResolvedSignature(call);
  return signature !== undefined && namesType(checker!, signature.getReturnType(), 'PreparedStatement')
    && signature.parameters.some(parameter => namesType(checker!, checker!.getTypeOfSymbol(parameter), 'Bound'));
}

function storeReceiver(node: ts.Expression, checker?: ts.TypeChecker): boolean {
  if (checker !== undefined) {
    const type = checker.getTypeAtLocation(node);
    if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      return (type.getProperty('prepare') !== undefined && type.getProperty('batch') !== undefined)
        || (type.getProperty('exec') !== undefined && (type.getProperty('query') !== undefined || type.getProperty('databaseSize') !== undefined));
    }
  }
  return /(?:^|\.)(?:db|store|source|sqlite|sql|MYCO_DB)$/.test(node.getText());
}

/** AST nodes exclude comments and distinguish SQL-producing strings from regex literals. */
export function boundarySites(source: ts.SourceFile, checker?: ts.TypeChecker): BoundarySite[] {
  const sites: BoundarySite[] = [];
  const add = (node: ts.Node, kind: BoundarySite['kind']) => sites.push({ kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (compilesBound(node, checker)) add(node, 'compile');
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        if (method === 'prepare') add(node, 'prepare');
        else if ((method === 'batch' || method === 'exec') && storeReceiver(callee.expression, checker)) add(node, method);
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map(span => ` ${span.literal.text}`).join('') : node.text;
      if (/^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text)
        || (/\bFROM\s+[A-Za-z_][A-Za-z_0-9]*\b/i.test(text) && /\bWHERE\b/i.test(text))) add(node, 'sql');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

interface SourceProgram {
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  readonly checker: ts.TypeChecker;
}

const programs = new Map<string, SourceProgram>();

function sourceProgram(root: string): SourceProgram {
  const known = programs.get(root);
  if (known !== undefined) return known;
  const files = (dir: string): string[] => readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
  const paths = files(root);
  const configPath = join(root, '..', 'tsconfig.json');
  const config = ts.readConfigFile(configPath, path => readFileSync(path, 'utf8'));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, '..'));
  const program = ts.createProgram(paths, options);
  const built = {
    files: new Map(paths.map(path => [relative(root, path).split(sep).join('/'), program.getSourceFile(path)!] as const)),
    checker: program.getTypeChecker(),
  };
  programs.set(root, built);
  return built;
}

/** What the gate counts for one file: inside db/, SQL text is expected and only direct store access counts. */
export function gatedSites(key: string, sites: readonly BoundarySite[]): BoundarySite[] {
  if (INFRASTRUCTURE.has(key) || DB_STORE_ALLOWED.has(key) || FROZEN_SCHEMA.test(key)) return [];
  return key.startsWith('db/') ? sites.filter(site => STORE_KINDS.has(site.kind)) : [...sites];
}

export function boundaryInventory(root: string): Map<string, BoundarySite[]> {
  const { files, checker } = sourceProgram(root);
  return new Map([...files].map(([key, file]) => [key, gatedSites(key, boundarySites(file, checker))]));
}

/** An allowed file that no longer reaches the store has outlived its reason. */
export function staleStoreAllowances(root: string): string[] {
  const { files, checker } = sourceProgram(root);
  return [...DB_STORE_ALLOWED.keys()].filter(key => {
    const file = files.get(key);
    return file === undefined || !boundarySites(file, checker).some(site => STORE_KINDS.has(site.kind));
  });
}

const isMeta = (node: ts.Expression): boolean => ts.isPropertyAccessExpression(node) && node.name.text === 'meta';
const boundName = (element: ts.BindingElement): string | undefined => {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
};

/** A read through an alias of the metadata object resolves to the `changes` member declared under a `meta` property. */
function declaredUnderMeta(name: ts.Node, checker?: ts.TypeChecker): boolean {
  return checker?.getSymbolAtLocation(name)?.declarations?.some(declaration => {
    const owner = declaration.parent.parent;
    return owner !== undefined && ts.isPropertySignature(owner) && owner.name.getText() === 'meta';
  }) ?? false;
}

/** Every read of a statement's change count; writing a result's `meta` is not a read. */
export function changeCountSites(source: ts.SourceFile, checker?: ts.TypeChecker): BoundarySite[] {
  const sites: BoundarySite[] = [];
  const add = (node: ts.Node) => sites.push({ kind: 'changes', line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'changes' && (isMeta(node.expression) || declaredUnderMeta(node.name, checker))) add(node);
    if (ts.isElementAccessExpression(node) && isMeta(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'changes') add(node);
    if (ts.isBindingElement(node) && boundName(node) === 'changes' && ts.isObjectBindingPattern(node.parent)) {
      const holder = node.parent.parent;
      const declared = checker?.getTypeAtLocation(node.parent).getProperty('changes')?.declarations?.some(declaration => {
        const owner = declaration.parent.parent;
        return owner !== undefined && ts.isPropertySignature(owner) && owner.name.getText() === 'meta';
      }) ?? false;
      if (declared || (ts.isBindingElement(holder) && boundName(holder) === 'meta')
        || (ts.isVariableDeclaration(holder) && holder.initializer !== undefined && isMeta(holder.initializer))) add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Everything but the store adapters, which are where a change count is produced. */
export function changeCountInventory(root: string): Map<string, BoundarySite[]> {
  const { files, checker } = sourceProgram(root);
  return new Map([...files].filter(([key]) => !INFRASTRUCTURE.has(key)).map(([key, file]) => [key, changeCountSites(file, checker)]));
}

interface ExceptionWording { readonly sites: string; readonly remedy: string; readonly set: string }

const describeSites = (sites: readonly BoundarySite[]): string => sites.map(site => `line ${site.line} (${site.kind})`).join(', ');

/** A listed file may keep raw sites until it is fully migrated; an unlisted file may have none, and a listed file with none must leave the set. */
function exceptionViolations(actual: ReadonlyMap<string, readonly BoundarySite[]>, pending: ReadonlySet<string>, wording: (file: string) => ExceptionWording): string[] {
  const errors: string[] = [];
  for (const file of [...new Set([...actual.keys(), ...pending])].sort()) {
    const sites = actual.get(file) ?? [];
    const { sites: noun, remedy, set } = wording(file);
    if (!pending.has(file) && sites.length > 0) errors.push(`${file}: ${noun} at ${describeSites(sites)}; ${remedy}`);
    else if (pending.has(file) && sites.length === 0) errors.push(`${file}: no ${noun} left; remove it from ${set}`);
  }
  return errors;
}

const OUTSIDE_DB: ExceptionWording = { sites: 'boundary sites', remedy: 'move SQL and store execution into db/', set: 'PENDING' };
const INSIDE_DB: ExceptionWording = { sites: 'direct store calls', remedy: 'use a kernel definition and commit', set: 'PENDING' };
const CHANGE_COUNTS: ExceptionWording = { sites: '.meta.changes reads', remedy: 'decide the outcome from a RETURNING row or an in-batch assertion', set: 'PENDING_CHANGE_COUNTS' };

export const boundaryViolations = (actual: ReadonlyMap<string, readonly BoundarySite[]>, pending: ReadonlySet<string>): string[] =>
  exceptionViolations(actual, pending, file => file.startsWith('db/') ? INSIDE_DB : OUTSIDE_DB);

export const changeCountViolations = (actual: ReadonlyMap<string, readonly BoundarySite[]>, pending: ReadonlySet<string>): string[] =>
  exceptionViolations(actual, pending, () => CHANGE_COUNTS);
