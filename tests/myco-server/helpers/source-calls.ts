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

/** SQL mutations of members, including conflict updates, from source string literals. */
export function memberWrites(text: string): string[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const writes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const sql = node.getText(source).slice(1, -1);
      if (/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+members\b/i.test(sql)) {
        writes.push(sql.replace(/\s+/g, ' ').trim());
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}
