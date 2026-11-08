import ts from 'typescript-v6';

/** Imported aliases resolve to the exported function name at each call site. */
export function sourceCalls(text: string): Array<{ called: string; owner: string }> {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
    }
  }
  const calls: Array<{ called: string; owner: string }> = [];
  const visit = (node: ts.Node, owner: string | null): void => {
    let named = owner;
    if (owner === null && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) named = node.name.getText(source);
    if (owner === null && ts.isVariableDeclaration(node) && node.initializer !== undefined) named = node.name.getText(source);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const called = ts.isIdentifier(callee) ? aliases.get(callee.text) ?? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)
            ? callee.name.text : `${callee.expression.getText(source)}.${callee.name.text}`
          : '';
      calls.push({ called, owner: named ?? '<module>' });
    }
    ts.forEachChild(node, (child) => visit(child, named));
  };
  visit(source, null);
  return calls;
}

const MEMBERS_WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+members\b/i;

type SourceGraph = { declaration: (node: ts.Node) => ts.Declaration | undefined; checker: ts.TypeChecker };

function memberSqlResolver(graph?: SourceGraph) {
  const resolve = (node: ts.Node, seen = new Set<ts.Node>()): string => {
    if (seen.has(node)) return '${cycle}';
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => resolve(span.expression, next) + span.literal.text).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return resolve(node.left, next) + resolve(node.right, next);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression, next);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let target = graph?.declaration(ts.isElementAccessExpression(node) ? node.argumentExpression : node);
      if (graph && ts.isElementAccessExpression(node)) {
        const key = graph.checker.getTypeAtLocation(node.argumentExpression);
        let symbol = key.isStringLiteral() ? graph.checker.getPropertyOfType(graph.checker.getTypeAtLocation(node.expression), key.value) : undefined;
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = graph.checker.getAliasedSymbol(symbol);
        target = symbol?.valueDeclaration ?? target;
      }
      if (target && ts.isShorthandPropertyAssignment(target)) {
        let symbol = graph?.checker.getShorthandAssignmentValueSymbol(target);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = graph?.checker.getAliasedSymbol(symbol);
        target = symbol?.valueDeclaration;
      }
      if (target && (ts.isVariableDeclaration(target) || ts.isPropertyAssignment(target)) && target.initializer) return resolve(target.initializer, next);
    }
    return '${unresolved}';
  };
  return resolve;
}

/** SQL mutations of members, including named kernel definitions composed from imported constants. */
export function memberWrites(
  input: string | ts.SourceFile,
  graph?: SourceGraph,
): Array<{ sql: string; name?: string }> {
  const source = typeof input === 'string' ? ts.createSourceFile('source.ts', input, ts.ScriptTarget.Latest, true) : input;
  const writes: Array<{ sql: string; name?: string }> = [];
  const resolve = memberSqlResolver(graph);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = graph?.declaration(node.expression);
      if (target && ts.isVariableDeclaration(target) && target.name.getText() === 'write'
        && target.getSourceFile().fileName.endsWith('/db/kernel/statement.ts')) {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('Kernel write options must be visible to the membership gate');
        const property = (name: string): ts.Expression | undefined => {
          const item = options.properties.find(item => item.name?.getText().replace(/['"]/g, '') === name);
          return item && ts.isPropertyAssignment(item) ? item.initializer : item && ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
        };
        const sqlNode = property('sql'), nameNode = property('name');
        if (!sqlNode) throw new Error('Kernel write SQL is missing: ' + node.getText());
        const sql = resolve(sqlNode);
        if (MEMBERS_WRITE.test(sql)) {
          const name = nameNode && resolve(nameNode);
          if (!name || name.includes('${')) throw new Error('Membership write requires a statically named definition: ' + node.getText());
          writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), name });
        }
        return;
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = resolve(node);
      if (MEMBERS_WRITE.test(sql)) writes.push({ sql: sql.replace(/\s+/g, ' ').trim() });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

/** References to members-write SQL are confined to the identity owner, independent of their use. */
export function memberSqlReferences(source: ts.SourceFile, graph: SourceGraph): string[] {
  const resolve = memberSqlResolver(graph);
  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && MEMBERS_WRITE.test(resolve(node))) references.add(node.getText());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...references].sort();
}
