import ts from 'typescript-v6';
import type { VisibleString } from './visible-strings.ts';

const stringLike = (type: ts.Type): boolean => type.isUnion() ? type.types.some(stringLike) : (type.flags & ts.TypeFlags.StringLike) !== 0;

const READER_FIELDS = new Set(['reason', 'detail', 'idleBecause', 'needs', 'findings', 'error', 'message', 'summary', 'label', 'defers']);
const READER_CALLS: Readonly<Record<string, readonly number[]>> = {
  badRequest: [0], malformed: [1], skipContext: [0], failStaleRun: [4], failQueuedRun: [4], endQueuedRun: [4],
};

/** Literal flow into dashboard diagnostics, through constants, helper returns and helper parameters. */
export function serverReaderStrings(files: readonly string[], renderedFields: ReadonlySet<string> = new Set()): Array<VisibleString & { file: string }> {
  const readerFields = new Set([...READER_FIELDS, ...renderedFields]);
  const program = ts.createProgram([...files], { allowJs: false, noResolve: false, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes('node_modules'));
  const parameterInputs = new Map<ts.Symbol, ts.Expression[]>();
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  const roots: ts.Node[] = [];
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const rootFiles = new Set(files.map((file) => file.replaceAll('\\', '/')));
  for (const source of sources) {
    const isRoot = rootFiles.has(source.fileName.replaceAll('\\', '/'));
    const visit = (node: ts.Node) => {
      if (isRoot && ts.isPropertyAssignment(node) && readerFields.has(node.name.getText(source).replace(/^['"]|['"]$/g, ''))) roots.push(node.initializer);
      if (isRoot && ts.isShorthandPropertyAssignment(node) && readerFields.has(node.name.text)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(node);
        for (const declaration of symbol?.declarations ?? []) {
          if (ts.isVariableDeclaration(declaration)) roots.push(declaration.name);
          if (ts.isParameter(declaration)) roots.push(declaration.name);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isRoot && ts.isPropertyAccessExpression(node.left) && readerFields.has(node.left.name.text)) roots.push(node.right);
        if (isRoot && ts.isElementAccessExpression(node.left) && ts.isStringLiteralLike(node.left.argumentExpression) && readerFields.has(node.left.argumentExpression.text)) roots.push(node.right);
        const symbol = symbolOf(node.left);
        if (symbol !== undefined) {
          const values = assignments.get(symbol) ?? [];
          values.push(node.right);
          assignments.set(symbol, values);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['push', 'unshift'].includes(node.expression.name.text)) {
        const symbol = symbolOf(node.expression.expression);
        if (symbol !== undefined) assignments.set(symbol, [...(assignments.get(symbol) ?? []), ...node.arguments]);
      }
      if (isRoot && ts.isNewExpression(node) && /^(BackupApplyError|BackupTooLargeError|RepositoryInputError|SecretValueError|ReleaseProvenanceInputError|InvalidSearch|RuntimeDraining|RuntimeAlreadyHolding)$/.test(node.expression.getText(source))) node.arguments?.forEach((argument) => roots.push(argument));
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText(source).split('.').pop()!;
        for (const index of isRoot && Object.hasOwn(READER_CALLS, name) ? READER_CALLS[name]! : []) if (node.arguments?.[index] !== undefined) roots.push(node.arguments?.[index]!);
        const signature = checker.getResolvedSignature(node)?.declaration;
        if (isRoot && signature !== undefined) signature.parameters.forEach((parameter, index) => {
          const symbol = symbolOf(parameter.name);
          const argument = node.arguments?.[index];
          if (symbol === undefined || argument === undefined) return;
          const inputs = parameterInputs.get(symbol) ?? [];
          inputs.push(argument);
          parameterInputs.set(symbol, inputs);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const seen = new Set<ts.Node>();
  const out: Array<VisibleString & { file: string }> = [];
  const returns = (node: ts.Node) => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) { if (node.expression !== undefined) flow(node.expression); return; }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, returns);
  };
  const flow = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const source = node.getSourceFile();
      const text = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' … ') : node.text;
      out.push({ file: source.fileName, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: text.trim().replace(/\s+/g, ' ') });
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => flow(span.expression));
      return;
    }
    if (ts.isElementAccessExpression(node)) { flow(node.expression); return; }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = symbolOf(ts.isPropertyAccessExpression(node) ? node.name : node);
      for (const input of symbol === undefined ? [] : [...(parameterInputs.get(symbol) ?? []), ...(assignments.get(symbol) ?? [])]) flow(input);
      for (const declaration of symbol?.declarations ?? []) {
        if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isParameter(declaration)) && declaration.initializer !== undefined) flow(declaration.initializer);
        if (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) returns(declaration.body);
        if (ts.isClassDeclaration(declaration)) for (const member of declaration.members) {
          if (ts.isConstructorDeclaration(member) && member.body !== undefined) for (const statement of member.body.statements) {
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword) statement.expression.arguments.forEach(flow);
          }
        }
      }
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'join' || stringLike(checker.getTypeAtLocation(node.expression.expression)))) flow(node.expression.expression);
      flow(node.expression);
      node.arguments?.forEach(flow);
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (ts.isBlock(node.body)) returns(node.body); else flow(node.body);
      return;
    }
    if (ts.isPropertyAssignment(node)) { flow(node.initializer); return; }
    ts.forEachChild(node, flow);
  };
  roots.forEach(flow);
  return out;
}

/** String-valued fields read by JSX expressions contribute reader roots to the server gate. */
export function dashboardReaderFields(files: readonly string[]): ReadonlySet<string> {
  const program = ts.createProgram([...files], { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const fields = new Set<string>();
  const rendered = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) return;
    if (ts.isPropertyAccessExpression(node) && stringLike(checker.getTypeAtLocation(node))) fields.add(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && stringLike(checker.getTypeAtLocation(node))) fields.add(node.argumentExpression.text);
    ts.forEachChild(node, rendered);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) { rendered(node); return; }
    ts.forEachChild(node, visit);
  };
  for (const file of files) { const source = program.getSourceFile(file); if (source !== undefined) visit(source); }
  return fields;
}
