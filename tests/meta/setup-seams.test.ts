import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';

const src = path.resolve(import.meta.dir, '../../packages/myco/src');
const directory = path.join(src, 'setup');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
const moduleOf = (file: string, specifier: string): string => (specifier.startsWith('@myco/') ? specifier.slice('@myco/'.length)
  : specifier.startsWith('.') ? path.relative(src, path.resolve(path.dirname(file), specifier)).replaceAll(path.sep, '/') : specifier).replace(/\.(js|ts)$/, '');

/** Setup imports operations through their CLI owners and imports only observation leaves below them. */
const seams: Record<string, readonly string[]> = {
  'cli/login': ['run'],
  'cli/cutover': ['planCutover', 'runCutover', 'cutoverSourcePlan', 'cutoverReconciliation', 'observeLegacyMigration', 'legacyConfirmationObserver'],
  'cli/member': ['runJoin', 'runDrain', 'provisionDetectedAgents', 'detectedProvisionLines', 'recordNoAgents', 'memberHarnessStatus'],
  'cli/runner-register': ['registerRunner'],
  'cli/runner-service': ['legacyWorkerInventory', 'preflightRunnerService', 'runnerServiceContact', 'runRunnerService'],
  'cli/runner-deps': ['defaultRunnerName', 'runnerServerUrl'],
  'cli/worker-service': ['executorServiceTarget'],
  'cli/deployment-reader': ['postRoute'],
  'cli/home-observations': ['observationInstant', 'observeProjectCapture', 'observeRunnerService'],
  'cli/legacy-capture': ['legacyCaptureGuidance'],
  'member/registry': ['deploymentUrl', 'listDeploymentMembershipsResult', 'listRegistryEntriesResult', 'readDeploymentMembershipResult', 'readRegistryEntryResult'],
  'member/default-deployment': ['readDefaultDeployment', 'recordDefaultDeployment'],
  'member/transport': ['ServerClient'],
  'member/legacy-migration': ['legacyMigrationState', 'legacyProjectDestination', 'installedLegacyHooks'],
  'member/store': ['readPrivateJson', 'writePrivateFileAtomic'],
  'runner/runner-registry': ['isLiveRunner', 'listRunnerRecordsResult', 'readRunnerRecord'],
  'runner/service': ['harnessDirectories', 'workerServiceStatus', 'workerServiceUnit', 'workerServiceSpec'],
};

it('setup conducts the existing login, cutover, runner and registry seams', () => {
  const violations: string[] = [];
  const operations = new Set<string>();
  for (const file of files(directory)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const bindings = new Map<string, string>();
    const check = (specifier: string, names: readonly string[] | null): void => {
      const module = moduleOf(file, specifier);
      if (!/^(cli|member|runner)\//.test(module)) return;
      if (names === null || seams[module] === undefined || names.some(name => !seams[module].includes(name))) {
        violations.push(`${path.relative(src, file)}: ${specifier} (${names?.join(', ') ?? 'namespace/dynamic import'})`);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const imports = node.importClause?.namedBindings;
        const elements = imports && ts.isNamedImports(imports) && !node.importClause?.name ? imports.elements.filter(element => !element.isTypeOnly) : null;
        const names = elements?.map(element => element.propertyName?.text ?? element.name.text) ?? null;
        check(node.moduleSpecifier.text, names);
        for (const element of elements ?? []) bindings.set(element.name.text, `${moduleOf(file, node.moduleSpecifier.text)}:${element.propertyName?.text ?? element.name.text}`);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        const names = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.filter(element => !element.isTypeOnly).map(element => element.propertyName?.text ?? element.name.text) : null;
        check(node.moduleSpecifier.text, names);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) check(arg.text, null);
        else violations.push(`${path.relative(src, file)}: non-literal module load`);
      }
      if (ts.isCallExpression(node)) {
        let callee: ts.Expression = node.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) callee = callee.right;
        if (ts.isIdentifier(callee)) {
          const operation = bindings.get(callee.text);
          if (operation !== undefined) operations.add(operation);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  for (const operation of ['cli/login:run', 'cli/cutover:planCutover', 'cli/cutover:runCutover', 'cli/cutover:observeLegacyMigration', 'cli/runner-register:registerRunner', 'cli/runner-service:runRunnerService']) expect(operations.has(operation)).toBe(true);
});
