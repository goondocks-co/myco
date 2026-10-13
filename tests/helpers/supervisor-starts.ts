import path from 'node:path';
import ts from 'typescript-v6';
import { REPO_ROOT, type Closure } from './import-closure.ts';

type SourceMutation = (file: string, text: string) => string;
interface ImplementationReuse {
  checker: ts.TypeChecker;
  declarations: WeakMap<ts.Declaration, ts.Declaration[]>;
  classFiles: ReadonlySet<string>;
  invalidated: ReadonlySet<string>;
}

const syntaxCache = new WeakMap<ts.Node, ts.Node[]>();
const visitCache = new WeakMap<ts.Node, ts.Node[]>();

function nodesOf(root: ts.Node, visitsOnly = false): ts.Node[] {
  const cache = visitsOnly ? visitCache : syntaxCache;
  const cached = cache.get(root);
  if (cached) return cached;
  const nodes: ts.Node[] = [];
  const collect = (node: ts.Node): void => {
    if (visitsOnly && (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && ts.isClassDeclaration(node.parent)) return;
    if (!visitsOnly || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node) || ts.isBindingElement(node)) nodes.push(node);
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(root, collect);
  cache.set(root, nodes);
  return nodes;
}

interface SourceIndex {
  classes: ts.ClassLikeDeclaration[];
  methodNames: string[];
  wrapperNames: string[];
  computedMethods: boolean;
  bindings: { name: ts.Identifier; value: ts.Expression }[];
  calls: ts.CallExpression[];
}

const indexCache = new WeakMap<ts.SourceFile, SourceIndex>();

function indexOf(source: ts.SourceFile): SourceIndex {
  const cached = indexCache.get(source);
  if (cached) return cached;
  const index: SourceIndex = { classes: [], methodNames: [], wrapperNames: [], computedMethods: false, bindings: [], calls: [] };
  for (const node of nodesOf(source)) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) index.classes.push(node);
    if (ts.isFunctionDeclaration(node) && node.name) index.wrapperNames.push(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      index.bindings.push({ name: node.name, value: node.initializer });
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) index.wrapperNames.push(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      index.bindings.push({ name: node.left, value: node.right });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) index.calls.push(node);
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (ts.isComputedPropertyName(node.name)) index.computedMethods = true;
      else index.methodNames.push(node.name.getText(source).replace(/^['"]|['"]$/g, ''));
    }
  }
  indexCache.set(source, index);
  return index;
}

/** One base program over the walked modules; mutations replace only changed source files. */
export function createSupervisorStartScanner(closures: readonly Closure[]): (closure: Closure, mutate?: SourceMutation) => string[] {
  const config = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const options = { ...parsed.options, types: [] };
  const roots = [...new Set(closures.flatMap(closure => [...closure.modules.values()]))].filter(file => /\.tsx?$/.test(file));
  const host = ts.createCompilerHost(options);
  const base = ts.createProgram(roots, options, host);
  const sources = new Map(base.getSourceFiles().map(source => [source.fileName, source]));
  const reverse = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (!sources.has(to)) return;
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to)!.add(from);
  };
  for (const closure of closures) for (const [key, imports] of closure.edges) {
    const from = closure.modules.get(key)!;
    for (const imported of imports) link(from, closure.modules.get(imported)!);
  }
  const resolution = ts.createModuleResolutionCache(REPO_ROOT, file => file, options);
  const importsOf = (file: string, source: ts.SourceFile): string[] => nodesOf(source).flatMap(node => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    if (!specifier || !ts.isStringLiteral(specifier)) return [];
    const target = ts.resolveModuleName(specifier.text, file, options, host, resolution).resolvedModule?.resolvedFileName;
    return target ? [target] : [];
  });
  for (const [file, source] of sources) for (const target of importsOf(file, source)) link(file, target);
  const reachable = (starts: Iterable<string>, graph: Map<string, Set<string>>): Set<string> => {
    const files = new Set(starts);
    for (const file of files) for (const next of graph.get(file) ?? []) files.add(next);
    return files;
  };
  type Baseline = { hits: string[]; reuse: ImplementationReuse };
  const baseline = new WeakMap<Closure, Baseline>();
  const baselineFor = (closure: Closure): Baseline => {
    let result = baseline.get(closure);
    if (!result) {
      const checker = base.getTypeChecker();
      const declarations = new WeakMap<ts.Declaration, ts.Declaration[]>();
      const classFiles = new Set([...closure.modules.values()].filter(file => {
        const source = sources.get(file);
        return source && indexOf(source).classes.length;
      }));
      const reuse = { checker, declarations, classFiles, invalidated: new Set<string>() };
      result = { hits: supervisorStarts(closure, base, reuse), reuse };
      baseline.set(closure, result);
    }
    return result;
  };
  return (closure, mutate) => {
    for (const file of closure.modules.values()) {
      if (/\.tsx?$/.test(file) && !sources.has(file)) throw new Error(`supervisor scanner has no base source for ${file}`);
    }
    // Baseline results are keyed by module identity.
    const original = closures.find(candidate => candidate.modules.size === closure.modules.size
      && [...candidate.modules.keys()].every(key => closure.modules.has(key)));
    if (!original) throw new Error('supervisor scanner closure differs from its base modules');
    const { hits: unchanged, reuse } = baselineFor(original);
    if (!mutate) return [...unchanged];
    const overlay = new Map<string, ts.SourceFile>();
    for (const file of closure.modules.values()) {
      const source = sources.get(file);
      if (!source) continue;
      const text = mutate(file, source.text);
      if (text !== source.text) overlay.set(file, ts.createSourceFile(file, text, options.target ?? ts.ScriptTarget.Latest, true));
    }
    if (overlay.size === 0) return [...unchanged];
    const mutationHost: ts.CompilerHost = {
      ...host,
      readFile: file => overlay.get(file)?.text ?? sources.get(file)?.text ?? host.readFile(file),
      getSourceFile: (file, languageVersion, onError, shouldCreateNewSourceFile) =>
        overlay.get(file) ?? sources.get(file) ?? host.getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile),
    };
    const invalidated = reachable(overlay.keys(), reverse);
    const changesTypeEnvironment = [...overlay].some(([file, source]) => {
      const before = new Set(importsOf(file, sources.get(file)!));
      const after = new Set(importsOf(file, source));
      return !ts.isExternalModule(source) || nodesOf(source).some(ts.isModuleDeclaration)
        || before.size !== after.size || [...before].some(target => !after.has(target));
    });
    if (changesTypeEnvironment) for (const file of sources.keys()) invalidated.add(file);
    return supervisorStarts(closure, ts.createProgram(roots, options, mutationHost, base), { ...reuse, invalidated });
  };
}

/** Scan every module and every method its references activate. */
function supervisorStarts(closure: Closure, program: ts.Program, reuse: ImplementationReuse): string[] {
  const checker = program.getTypeChecker();
  const files = new Set(closure.modules.values());
  const found = new Set<string>();
  const methods = new Set<ts.Node>();
  const queue: ts.Node[] = [];
  const classes: ts.ClassLikeDeclaration[] = [];
  const methodNames = new Set<string>();
  const wrapperNames = new Set<string>();
  let computedMethods = false;
  let reuseImplementations = false;
  const implementationCache = new Map<ts.Declaration, ts.Declaration[]>();
  const declarationCache = new Map<ts.Expression, ts.Declaration[]>();
  const executableCache = new Map<ts.Declaration, string[]>();
  const dangerous = new Set(['start', 'restart', 'reload', 'ensureRunning', 'restartShellCommand', 'install', 'bootstrap']);
  const legacySupervisor = /\/(?:daemon|service|member\/legacy-service)\//;
  const report = (node: ts.Node, reason: string): void => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.add(`${path.relative(REPO_ROOT, source.fileName)}:${line}: ${reason}`);
  };
  const checkerFor = (node: ts.Node): ts.TypeChecker => !reuse.invalidated.has(node.getSourceFile().fileName) ? reuse.checker : checker;
  const typeOf = (node: ts.Node): ts.Type => checkerFor(node).getTypeAtLocation(node);
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const owner = checkerFor(node);
    const symbol = owner.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? owner.getAliasedSymbol(symbol) : symbol;
  };
  const bindings = new Map<ts.Symbol, ts.Expression[]>();
  const bind = (name: ts.Node, value: ts.Expression): void => {
    const symbol = ts.isIdentifier(name) ? symbolOf(name) : undefined;
    if (!symbol) return;
    const assigned = bindings.get(symbol);
    if (assigned) assigned.push(value);
    else bindings.set(symbol, [value]);
  };
  const values = (node: ts.Node | undefined, seen = new Set<ts.Node>()): string[] => {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map(span => span.literal.text).join(' ')];
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      const resolved = symbol ? (bindings.get(symbol) ?? []).flatMap(value => values(value, next)) : [];
      // The native service capability loads only the supplied 2.0 unit.
      if (node.text === 'RELOAD_SCRIPT' && node.getSourceFile().fileName === path.join(REPO_ROOT, 'packages/myco/src/server/service.ts')) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        if (owner?.name?.text === 'reloadServiceDetached') return resolved.map(value => value.replaceAll('launchctl load -w "$unit"', ''));
      }
      return resolved;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSpreadElement(node)) return values(node.expression, next);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => values(element, next));
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, next), ...values(node.whenFalse, next)];
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'join' && ts.isArrayLiteralExpression(node.expression.expression)) {
        const array = node.expression.expression;
        const separators = node.arguments.length ? values(node.arguments[0], next) : [','];
        return separators.map(separator => values(array, next).join(separator));
      }
      if (node.expression.getText() === 'path.win32.join') {
        return [node.arguments.flatMap(arg => values(arg, next)).join('\\')];
      }
    }
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
    const cached = implementationCache.get(declaration);
    if (cached) return cached;
    const reusable = reuseImplementations && !reuse.invalidated.has(declaration.getSourceFile().fileName);
    const shared = reusable ? reuse.declarations.get(declaration) : undefined;
    if (shared) { implementationCache.set(declaration, shared); return shared; }
    const contract = checker.getTypeAtLocation(declaration.parent);
    const name = declaration.name.getText();
    const result = [declaration, ...classes.filter(node => {
      const type = checker.getTypeAtLocation(node);
      return type.getProperty(name) && checker.isTypeAssignableTo(type, contract);
    })
      .flatMap(node => checker.getTypeAtLocation(node).getProperty(name)?.declarations ?? [])];
    implementationCache.set(declaration, result);
    if (reusable) reuse.declarations.set(declaration, result);
    return result;
  };
  const declarationsOf = (expression: ts.Expression): ts.Declaration[] => {
    const cached = declarationCache.get(expression);
    if (cached) return cached;
    let result: ts.Declaration[];
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      let receiver: ts.Expression = expression.expression;
      while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)) receiver = receiver.expression;
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : values(expression.argumentExpression).join('');
      if (!computedMethods && !methodNames.has(name) && !dangerous.has(name)) return [];
      result = typeOf(receiver).getProperty(name)?.declarations?.flatMap(implementations) ?? [];
    } else {
      result = symbolOf(expression)?.declarations?.flatMap(implementations) ?? [];
    }
    declarationCache.set(expression, result);
    return result;
  };
  const executables = (declaration: ts.Declaration, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(declaration) || !/member\/legacy-service\//.test(declaration.getSourceFile().fileName)) return [];
    const cached = executableCache.get(declaration);
    if (cached) return cached;
    const next = new Set(seen).add(declaration);
    const found: string[] = [];
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && ['spawnCombinedOutput', 'spawnRawOutput'].includes(node.expression.text)) {
          found.push(...values(node.arguments[0]));
        } else {
          for (const called of declarationsOf(node.expression)) found.push(...executables(called, next));
        }
      }
      ts.forEachChild(node, inspect);
    };
    ts.forEachChild(declaration, inspect);
    const result = [...new Set(found)];
    if (seen.size === 0) executableCache.set(declaration, result);
    return result;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : values(node.argumentExpression).join('');
      if (!computedMethods && !methodNames.has(name) && !dangerous.has(name)) {
        return;
      }
      const symbol = ts.isPropertyAccessExpression(node) ? symbolOf(node.name)
        : typeOf(node.expression).getProperty(name);
      const declarations = symbol?.declarations?.flatMap(implementations) ?? declarationsOf(node);
      const callable = ts.isCallExpression(node.parent) && node.parent.expression === node
        || declarations.some(declaration => ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration));
      if (callable && dangerous.has(name) && (declarations.length === 0 || declarations.some(declaration => legacySupervisor.test(declaration.getSourceFile().fileName)))) report(node, name);
      for (const declaration of declarations) if (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) activate(declaration);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = (node.propertyName ?? node.name).getText().replace(/^['"]|['"]$/g, '');
      if (dangerous.has(name)) report(node, name);
      const declarations = typeOf(node.parent).getProperty(name)?.declarations?.flatMap(implementations) ?? [];
      for (const declaration of declarations) {
        if (ts.isMethodDeclaration(declaration)) activate(declaration);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const hosts = declarationsOf(expression).flatMap(declaration => executables(declaration));
      const command = [...hosts, ...node.arguments.flatMap(arg => values(arg))].join(' ').replace(/\s+/g, ' ');
      if (/\b(?:launchctl\b.*\b(?:start|submit|kickstart|load|bootstrap|enable)|systemctl\b.*(?:\b(?:start|restart|reenable)\b|\benable\b.*--now\b|--now\b.*\benable\b)|schtasks\b.*(?:\/(?:run|create)\b|\/change\b.*\/enable\b)|(?:powershell|pwsh)(?:\.exe)?\b.*\b(?:Start|Enable|Register)-ScheduledTask)\b/i.test(command)) report(node, 'supervisor exec');
    }
  };
  for (const source of program.getSourceFiles()) {
    if (!files.has(source.fileName)) continue;
    const index = indexOf(source);
    classes.push(...index.classes);
    for (const name of index.wrapperNames) wrapperNames.add(name);
    for (const name of index.methodNames) methodNames.add(name);
    computedMethods ||= index.computedMethods;
  }
  reuseImplementations = ![...reuse.classFiles].some(file => reuse.invalidated.has(file))
    && !classes.some(node => reuse.invalidated.has(node.getSourceFile().fileName));
  for (const source of program.getSourceFiles()) {
    if (!files.has(source.fileName)) continue;
    const index = indexOf(source);
    for (const { name, value } of index.bindings) bind(name, value);
    for (const node of index.calls) {
      if (ts.isIdentifier(node.expression) && wrapperNames.has(node.expression.text)) {
        for (const declaration of declarationsOf(node.expression)) {
          const callable = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
          if (callable && ts.isFunctionLike(callable)) {
            callable.parameters.forEach((parameter, index) => {
              const argument = node.arguments[index] ?? parameter.initializer;
              if (argument) bind(parameter.name, argument);
            });
          }
        }
      }
    }
  }
  for (const source of program.getSourceFiles()) if (files.has(source.fileName)) for (const node of nodesOf(source, true)) visit(node);
  for (const method of queue) for (const node of nodesOf(method, true)) visit(node);
  return [...found].sort();
}
