import path from 'node:path';
import ts from 'typescript-v6';
import { REPO_ROOT, type Closure } from './import-closure.ts';

type SourceMutation = (file: string, text: string) => string;

/** Scan every module, following method references into their bodies. */
export function supervisorStarts(closure: Closure, mutate?: SourceMutation): string[] {
  const config = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const options = { ...parsed.options, types: [] };
  const host = ts.createCompilerHost(options);
  host.readFile = file => {
    const text = ts.sys.readFile(file);
    return text === undefined ? undefined : mutate?.(file, text) ?? text;
  };
  const program = ts.createProgram([...closure.modules.values()].filter(file => /\.tsx?$/.test(file)), options, host);
  const checker = program.getTypeChecker();
  const files = new Set(closure.modules.values());
  const found = new Set<string>();
  const methods = new Set<ts.Node>();
  const queue: ts.Node[] = [];
  const classes: ts.ClassLikeDeclaration[] = [];
  const dangerous = new Set(['start', 'restart', 'reload', 'ensureRunning', 'restartShellCommand']);
  const legacySupervisor = /\/(?:daemon|service|member\/legacy-service)\//;
  const report = (node: ts.Node, reason: string): void => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.add(`${path.relative(REPO_ROOT, source.fileName)}:${line}: ${reason}`);
  };
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const initializer = (node: ts.Identifier): ts.Expression | undefined => {
    const declaration = symbolOf(node)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration)
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) ? declaration.initializer : undefined;
  };
  const values = (node: ts.Node, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map(span => span.literal.text).join(' ')];
    if (ts.isIdentifier(node)) { const value = initializer(node); return value ? values(value, next) : []; }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSpreadElement(node)) return values(node.expression, next);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => values(element, next));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [values(node.left, next).join('') + values(node.right, next).join('')];
    }
    return [];
  };
  const activate = (node: ts.Node): void => {
    if (!files.has(node.getSourceFile().fileName) || methods.has(node)) return;
    methods.add(node);
    queue.push(node);
  };
  const implementations = (declaration: ts.Declaration): ts.Declaration[] => {
    if (!ts.isMethodSignature(declaration) || !ts.isInterfaceDeclaration(declaration.parent)) return [declaration];
    const contract = checker.getTypeAtLocation(declaration.parent);
    const name = declaration.name.getText();
    return [declaration, ...classes.filter(node => checker.isTypeAssignableTo(checker.getTypeAtLocation(node), contract))
      .flatMap(node => checker.getTypeAtLocation(node).getProperty(name)?.declarations ?? [])];
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isClassDeclaration(node.parent)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : values(node.argumentExpression).join('');
      const symbol = ts.isPropertyAccessExpression(node) ? symbolOf(node.name)
        : checker.getTypeAtLocation(node.expression).getProperty(name);
      const declarations = symbol?.declarations?.flatMap(implementations) ?? [];
      const callable = ts.isCallExpression(node.parent) && node.parent.expression === node
        || declarations.some(declaration => ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration));
      if (callable && dangerous.has(name) && (declarations.length === 0 || declarations.some(declaration => legacySupervisor.test(declaration.getSourceFile().fileName)))) report(node, name);
      for (const declaration of declarations) if (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) activate(declaration);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = (node.propertyName ?? node.name).getText().replace(/^['"]|['"]$/g, '');
      if (dangerous.has(name)) report(node, name);
      for (const declaration of checker.getTypeAtLocation(node.parent).getProperty(name)?.declarations?.flatMap(implementations) ?? []) {
        if (ts.isMethodDeclaration(declaration)) activate(declaration);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const declaration = ts.isPropertyAccessExpression(expression) && expression.name.text === 'run'
        ? symbolOf(expression.name)?.declarations?.[0] : undefined;
      const platform = declaration?.getSourceFile().fileName.match(/member\/legacy-service\/(launchd|systemd|windows)\.ts$/)?.[1];
      const executable = platform === 'launchd' ? 'launchctl' : platform === 'systemd' ? 'systemctl' : platform === 'windows' ? 'schtasks' : '';
      const command = [executable, ...node.arguments.flatMap(arg => values(arg))].join(' ');
      if (/\b(?:launchctl\b.*\bkickstart|systemctl\b.*\b(?:start|restart)|schtasks\b.*\/run)\b/i.test(command)) report(node, 'supervisor exec');
    }
    ts.forEachChild(node, visit);
  };
  for (const source of program.getSourceFiles()) {
    if (!files.has(source.fileName)) continue;
    const collect = (node: ts.Node): void => { if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes.push(node); ts.forEachChild(node, collect); };
    collect(source);
  }
  for (const source of program.getSourceFiles()) if (files.has(source.fileName)) visit(source);
  for (const method of queue) ts.forEachChild(method, visit);
  return [...found].sort();
}
