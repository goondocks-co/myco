import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript-v6';

export interface BoundarySite {
  kind: 'prepare' | 'batch' | 'exec' | 'sql';
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

export function boundaryInventory(root: string): Map<string, BoundarySite[]> {
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
  const checker = program.getTypeChecker();
  const key = (path: string) => relative(root, path).split(sep).join('/');
  return new Map(paths.filter(path => !key(path).startsWith('db/') && !INFRASTRUCTURE.has(key(path)))
    .map(path => [key(path), boundarySites(program.getSourceFile(path)!, checker)]));
}

/** Both growth and stale entries fail; a zero count must be removed rather than retained. */
export function boundaryViolations(actual: ReadonlyMap<string, readonly BoundarySite[]>, pending: ReadonlyMap<string, number>): string[] {
  const errors: string[] = [];
  for (const file of new Set([...actual.keys(), ...pending.keys()])) {
    const count = actual.get(file)?.length ?? 0;
    const expected = pending.get(file);
    if (expected === undefined && count > 0) errors.push(`${file}: ${count} new boundary sites; move SQL and store execution into db/`);
    else if (expected !== undefined && (count !== expected || expected === 0)) {
      errors.push(`${file}: ${count} boundary sites, expected exactly ${expected}; lower or remove the exception when sites move`);
    }
  }
  return errors;
}
