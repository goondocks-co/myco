import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { ACTIONS, RESOURCE_ACTIONS, RESOURCE_KINDS, RESOURCE_RESOLVERS, SUBJECT_KINDS, type AuthorizationDeclaration } from '@myco-server-worker/auth/authorization.js';
import { ROUTES, RETIRED_ROUTES } from '@myco-server-worker/routes.js';
import { NO_OP, TOOL_REGISTRY, type RegistryEntry } from '@myco-server-worker/mcp/registry.js';
import { RUN_TOOL_REGISTRY } from '@myco-server-worker/mcp/run-surface.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from '@myco-server-worker/mcp/definitions.js';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/myco-server/src');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const DECLARING_MODULES = new Set(['routes.ts', 'mcp/registry.ts', 'mcp/run-surface.ts']);
const RAW_READ_CAPABILITIES = new Set([
  'core/raw-resources.ts', 'ingest/parse.ts', 'core/stored-object.ts',
  'read/processed.ts', 'core/embedding/reconcile.ts', 'core/search-index.ts',
  'core/registered-content.ts', 'core/content-budget.ts', 'core/relational-snapshot.ts',
]);

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

function boundaryViolations(source: string, module: string): string[] {
  const ast = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const blobAliases = new Set(['blobs']);
  const registryAliases = new Set(['entry', 'route']);
  const blobCalls = new Set<string>();
  const dispatchCalls = new Set<string>();
  const dispatchProperties = new Set(['handler', 'credential', 'deployment', 'unbound', 'grant', 'run']);
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
  };
  const access = (node: ts.Expression): { receiver: ts.Expression; property: string | undefined } | null => {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node)) return { receiver: node.expression, property: node.name.text };
    if (ts.isElementAccessExpression(node)) {
      const property = node.argumentExpression && unwrap(node.argumentExpression);
      return { receiver: node.expression, property: property && (ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property)) ? property.text : undefined };
    }
    return null;
  };
  const isBlob = (node: ts.Expression): boolean => {
    node = unwrap(node);
    return ts.isIdentifier(node) && blobAliases.has(node.text) || access(node)?.property === 'blobs';
  };
  const isRegistry = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return registryAliases.has(node.text) || ['ROUTES', 'TOOL_REGISTRY', 'RUN_TOOL_REGISTRY'].includes(node.text);
    const held = access(node);
    return held !== null && (isRegistry(held.receiver) || held.property === 'route' && unwrap(held.receiver).getText(ast) === 'matched');
  };
  const isBlobCall = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return blobCalls.has(node.text);
    const held = access(node);
    if (held && isBlob(held.receiver) && (held.property === 'get' || held.property === undefined)) return true;
    if (held && (held.property === undefined || held.property === 'call' || held.property === 'apply') && isBlobCall(held.receiver)) return true;
    return ts.isCallExpression(node) && access(node.expression)?.property === 'bind'
      && isBlobCall(access(node.expression)!.receiver);
  };
  const isDispatchCall = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return dispatchCalls.has(node.text);
    const held = access(node);
    if (held && (held.property === 'handler' || isRegistry(held.receiver) && (held.property === undefined || dispatchProperties.has(held.property)))) return true;
    if (held && (held.property === undefined || held.property === 'call' || held.property === 'apply') && isDispatchCall(held.receiver)) return true;
    return ts.isCallExpression(node) && access(node.expression)?.property === 'bind'
      && isDispatchCall(access(node.expression)!.receiver);
  };
  const remember = (name: string, expression: ts.Expression): void => {
    if (isBlob(expression)) blobAliases.add(name);
    if (isRegistry(expression)) registryAliases.add(name);
    if (isBlobCall(expression)) blobCalls.add(name);
    if (isDispatchCall(expression)) dispatchCalls.add(name);
  };
  const aliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) remember(node.name.text, node.initializer);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const item of node.name.elements) {
          if (!ts.isIdentifier(item.name)) continue;
          if (item.dotDotDotToken) { remember(item.name.text, node.initializer); continue; }
          const computed = item.propertyName !== undefined && ts.isComputedPropertyName(item.propertyName);
          const property = item.propertyName && ts.isComputedPropertyName(item.propertyName)
            ? unwrap(item.propertyName.expression) : item.propertyName ?? item.name;
          const name = ts.isIdentifier(property) && !computed || ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property) ? property.text : undefined;
          if (name === 'blobs') blobAliases.add(item.name.text);
          if (name === 'route' && unwrap(node.initializer).getText(ast) === 'matched') registryAliases.add(item.name.text);
          if (isBlob(node.initializer) && (name === 'get' || name === undefined)) blobCalls.add(item.name.text);
          if (isRegistry(node.initializer) && (name === undefined || dispatchProperties.has(name))) dispatchCalls.add(item.name.text);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      remember(node.left.text, node.right);
    }
    ts.forEachChild(node, aliases);
  };
  let priorAliases = -1;
  while (priorAliases !== blobAliases.size + registryAliases.size + blobCalls.size + dispatchCalls.size) {
    priorAliases = blobAliases.size + registryAliases.size + blobCalls.size + dispatchCalls.size;
    aliases(ast);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const binding = node.importClause?.namedBindings;
      if (!node.importClause?.isTypeOnly && binding && ts.isNamedImports(binding)) {
        for (const imported of binding.elements) {
          const name = (imported.propertyName ?? imported.name).text;
          if (!imported.isTypeOnly && /^handle[A-Z]/.test(name) && !DECLARING_MODULES.has(module)) {
            violations.push(`${module}: handler import ${name} outside declaring registry`);
          }
        }
      }
      if (binding && ts.isNamespaceImport(binding) && /(?:\/api\/|\/tools\/)/.test(node.moduleSpecifier.text)) {
        violations.push(`${module}: handler namespace import`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && /(?:\/api\/|\/tools\/)/.test(node.arguments[0].text)) {
      violations.push(`${module}: dynamic handler import`);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && /(?:\/api\/|\/tools\/)/.test(node.moduleSpecifier.text) && !node.isTypeOnly) {
      violations.push(`${module}: handler re-export outside declaring registry`);
    }
    if (ts.isCallExpression(node)) {
      if (isDispatchCall(node.expression) && module !== 'pipeline.ts' && module !== 'mcp/server.ts') {
        violations.push(`${module}: registry dispatch outside authorization chokepoint`);
      }
      if (isBlobCall(node.expression) && !RAW_READ_CAPABILITIES.has(module)) {
        violations.push(`${module}: blob read outside declared serving/processing/backup capability`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

function validDeclaration(where: string, declaration: AuthorizationDeclaration | undefined, transport: 'http' | 'mcp'): void {
  expect({ where, declared: declaration !== undefined }).toEqual({ where, declared: true });
  if (!declaration) throw new Error(`${where}: authorization missing`);
  expect({ where, transport: declaration.transport }).toEqual({ where, transport });
  expect({ where, recognized: RESOURCE_KINDS.includes(declaration.resource) }).toEqual({ where, recognized: true });
  expect(declaration.subjects.length).toBeGreaterThan(0);
  expect(new Set(declaration.subjects).size).toBe(declaration.subjects.length);
  for (const subject of declaration.subjects) expect(SUBJECT_KINDS.includes(subject)).toBe(true);
  expect(['deployment', 'project', 'machine', 'credential', 'member', 'run', 'raw', 'protocol', 'enrollment', 'self-enrollment']).toContain(declaration.resolver);
  expect(RESOURCE_RESOLVERS[declaration.resource]).toContain(declaration.resolver);
  const actions = typeof declaration.action === 'string' ? [declaration.action] : declaration.action.actions;
  expect(actions.length).toBeGreaterThan(0);
  expect(new Set(actions).size).toBe(actions.length);
  for (const action of actions) {
    expect({ where, action, known: ACTIONS.includes(action), valid: RESOURCE_ACTIONS[declaration.resource].includes(action) })
      .toEqual({ where, action, known: true, valid: true });
  }
  if (typeof declaration.action !== 'string') expect(typeof declaration.action.resolve).toBe('function');
}

describe('authorization registry and bypass boundary', () => {
  it('declares every live and retired HTTP route exactly once on the dispatch tables', () => {
    const names = [...ROUTES, ...RETIRED_ROUTES].map((route) => `${route.method} ${route.path}`);
    expect(new Set(names).size).toBe(names.length);
    for (const route of ROUTES) validDeclaration(`${route.method} ${route.path}`, route.authorization, 'http');
    for (const route of RETIRED_ROUTES) {
      validDeclaration(`retired ${route.method} ${route.path}`, route.authorization, 'http');
      expect(route.authorization.resource).toBe('protocol');
      expect(route.authorization.action).toBe('never');
    }
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(RETIRED_ROUTES.length).toBe(11);
  });

  it('covers both MCP registries and every operation enum, including unserved operations', () => {
    const surfaces: Array<{ registry: Record<string, { ops: Record<string, RegistryEntry> }>; definitions: readonly ToolDefinition[] }> = [
      { registry: TOOL_REGISTRY, definitions: TOOL_DEFINITIONS },
      { registry: RUN_TOOL_REGISTRY, definitions: RUN_DEFINITIONS },
    ];
    for (const { registry, definitions } of surfaces) {
      expect(Object.keys(registry).sort()).toEqual(definitions.map((def) => String(def.name)).sort());
      for (const definition of definitions) {
        const registered = registry[definition.name];
        const operation = definition.inputSchema.properties.op;
        const expected = operation?.enum === undefined ? [NO_OP] : operation.enum.filter((op): op is string => typeof op === 'string');
        expect(Object.keys(registered.ops).sort()).toEqual(expected.sort());
        for (const [op, entry] of Object.entries(registered.ops)) {
          validDeclaration(`${definition.name}.${op}`, entry.authorization, 'mcp');
          if ('notServed' in entry) {
            expect(entry.authorization.resource).toBe('protocol');
            expect(entry.authorization.action).toBe('never');
          }
        }
      }
    }
  });

  it('keeps the run-only surface unavailable to members and grants', () => {
    for (const entry of Object.values(RUN_TOOL_REGISTRY)) {
      for (const operation of Object.values(entry.ops)) {
        expect(operation.authorization.subjects).toEqual(['run']);
        expect(operation.authorization.resource).toBe('run');
        expect(operation.authorization.resolver).toBe('run');
      }
    }
    for (const tool of Object.values(TOOL_REGISTRY)) {
      for (const operation of Object.values(tool.ops)) {
        const action = operation.authorization.action;
        const actions = typeof action === 'string' ? [action] : action.actions;
        expect(actions.some((value) => ['admin', 'owner', 'dispatch', 'cancel', 'execute'].includes(value))).toBe(false);
      }
    }
  });

  it('permits handler imports only in their declaring registries and raw reads only in sanctioned capabilities', () => {
    const violations = sources(ROOT).flatMap((file) => boundaryViolations(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)));
    expect(violations).toEqual([]);
  });

  it('binds every exported HTTP/tool handler to its existing declaring registry', () => {
    const imported = new Set<string>();
    for (const module of DECLARING_MODULES) {
      const ast = ts.createSourceFile(module, read(module), ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const target = path.resolve(ROOT, path.dirname(module), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
        for (const item of bindings.elements) {
          if (item.isTypeOnly) continue;
          const name = (item.propertyName ?? item.name).text;
          if (!/^handle[A-Z]/.test(name)) continue;
          imported.add(`${target}:${name}`);
          let references = 0;
          const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) return;
            if (ts.isIdentifier(node) && node.text === item.name.text) references += 1;
            ts.forEachChild(node, visit);
          };
          visit(ast);
          expect({ module, name, registered: references > 0 }).toEqual({ module, name, registered: true });
        }
      }
    }
    const unregistered: string[] = [];
    for (const filename of sources(ROOT)) {
      const module = path.relative(ROOT, filename);
      if (!/^(?:api\/|auth\/|ingest\/|mcp\/tools\/|mcp\/http\.ts$)/.test(module)) continue;
      const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const names = ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text]
          : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []) : [];
        for (const name of names) {
          if (/^handle[A-Z]/.test(name) && !imported.has(`${filename}:${name}`)) unregistered.push(`${path.relative(ROOT, filename)}:${name}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('detects handler aliases, namespace/re-export bypasses, direct dispatch and blob reads in a new entry point', () => {
    for (const source of [
      "import { handleSaveSpore as save } from './api/spores.js'; save(env, ctx);",
      "import * as api from './api/spores.js'; api.handleSaveSpore(env, ctx);",
      "export { handleSaveSpore } from './api/spores.js';",
      "const handler = await import('./api/spores.js');",
      'entry.handler(input, context);', 'route.handler(env, context);', 'route.run(env, context);',
      'env.blobs.get(key);', 'blobs.get(key);', 'const raw = env.blobs; raw.get(key);',
      "route['handler'](env, ctx);", 'route[operation](env, ctx);', 'entry[operation](input, ctx);',
      "env.blobs['get'](key);", "env['blobs'].get(key);", "env['blobs']['get'](key);",
      "const raw = env['blobs']; raw.get(key);", 'env.blobs[operation](key);',
      "const raw = env['blobs']; const copy = raw; copy[operation](key);",
      "let raw; raw = env['blobs']; raw['get'](key);",
      "const { blobs: raw } = env; raw['get'](key);", 'const { get: load } = env.blobs; load(key);',
      "const { ['get']: load } = env.blobs; load(key);",
      'const { [operation]: load } = env.blobs; load(key);', 'const load = env.blobs.get; load(key);',
      'const load = env.blobs.get.bind(env.blobs); load(key);',
      'const load = env.blobs.get; load.call(env.blobs, key);',
      'const { handler: invoke } = route; invoke(env, ctx);', 'const invoke = route.handler; invoke(env, ctx);',
      'const invoke = route.handler; invoke[operation](env, ctx);',
      'const current = route; current[operation](env, ctx);', "matched['route']['handler'](env, ctx);",
      'TOOL_REGISTRY[tool].ops[op][operation](input, ctx);',
    ]) expect(boundaryViolations(source, 'new-entry.ts').length).toBeGreaterThan(0);
    expect(boundaryViolations("import type { MemberHandler } from './routes.js';", 'new-entry.ts')).toEqual([]);
    expect(boundaryViolations('env.blobs.get(key);', 'core/raw-resources.ts')).toEqual([]);
    expect(boundaryViolations("const raw = env['blobs']; raw['get'](key);", 'core/raw-resources.ts')).toEqual([]);
    expect(boundaryViolations("route['handler'](env, ctx);", 'pipeline.ts')).toEqual([]);
    expect(boundaryViolations('env.blobs.put(key, bytes);', 'new-entry.ts')).toEqual([]);
    expect(boundaryViolations("const { ['put']: save } = env.blobs; save(key, bytes);", 'new-entry.ts')).toEqual([]);
    expect(boundaryViolations('ordinary.get(key); database.run();', 'new-entry.ts')).toEqual([]);
  });

  it('serves raw resources through the uploader capability and keeps the pipeline and MCP dispatch tied to authorization', () => {
    expect(read('api/blobs.ts')).toContain('RawResourceReader');
    expect(read('api/sessions.ts')).toContain('RawResourceReader');
    expect(read('core/raw-resources.ts')).toMatch(/authorize\(/);
    expect(read('pipeline.ts')).toContain('authorizeHttp');
    expect(read('mcp/server.ts')).toContain('authorizeTool');
  });

  it('reports the complete registry coverage', () => {
    const memberOps = Object.values(TOOL_REGISTRY).reduce((n, entry) => n + Object.keys(entry.ops).length, 0);
    const runOps = Object.values(RUN_TOOL_REGISTRY).reduce((n, entry) => n + Object.keys(entry.ops).length, 0);
    process.stdout.write(`[authorization] routes=${ROUTES.length} retired=${RETIRED_ROUTES.length} member_ops=${memberOps} run_ops=${runOps}\n`);
    expect(memberOps).toBeGreaterThan(20);
    expect(runOps).toBeGreaterThan(10);
  });
});
