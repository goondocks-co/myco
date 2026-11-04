import ts from 'typescript-v6';
import path from 'node:path';

export function sourceProgram(roots: string[]) {
  const root = path.resolve(import.meta.dir, '../..');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  if (options.errors.length) throw new Error(options.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
  const program = ts.createProgram(roots, options.options);
  const errors = program.getSyntacticDiagnostics();
  if (errors.length) throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const checker = program.getTypeChecker();
  const declaration = (node: ts.Node): ts.Declaration | undefined => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    if (ts.isPropertyAccessExpression(node)) {
      const owner = declaration(node.expression);
      if (owner && ts.isVariableDeclaration(owner) && owner.initializer && ts.isCallExpression(owner.initializer)) return owner;
    }
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    let declared = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declared && ts.isBindingElement(declared) && ts.isObjectBindingPattern(declared.parent)) {
      const owner = declared.parent.parent;
      if (ts.isVariableDeclaration(owner) && owner.initializer) {
        const property = checker.getPropertyOfType(checker.getTypeAtLocation(owner.initializer), (declared.propertyName ?? declared.name).getText());
        if (property) declared = property.valueDeclaration ?? property.declarations?.[0];
      }
    }
    return declared && ts.isVariableDeclaration(declared) && declared.initializer
      && (ts.isIdentifier(declared.initializer) || ts.isPropertyAccessExpression(declared.initializer))
      ? declaration(declared.initializer) : declared;
  };
  const calls = (node: ts.Node): ts.CallExpression[] => {
    const found: ts.CallExpression[] = [];
    const visit = (at: ts.Node): void => { if (ts.isCallExpression(at)) found.push(at); ts.forEachChild(at, visit); };
    visit(node);
    return found;
  };
  const target = (call: ts.CallExpression): ts.Declaration | undefined =>
    declaration(call.expression) ?? checker.getResolvedSignature(call)?.declaration;
  const reaches = (node: ts.Node, terminal: (call: ts.CallExpression, callee: ts.Declaration | undefined) => boolean, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    return calls(node).some(call => {
      const callee = target(call);
      return terminal(call, callee) || [callee, ...call.arguments.map(declaration)].some(target => target !== undefined
        && target.getSourceFile().fileName.startsWith(path.join(root, 'packages')) && reaches(target, terminal, seen));
    });
  };
  return { program, checker, declaration, calls, target, reaches };
}
