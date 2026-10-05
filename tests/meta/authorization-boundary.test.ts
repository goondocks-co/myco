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
  const aliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const from = node.initializer.getText(ast);
      if (/(?:^|\.)blobs$/.test(from) || blobAliases.has(from)) blobAliases.add(node.name.text);
    }
    ts.forEachChild(node, aliases);
  };
  aliases(ast);
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(ast);
      const name = node.expression.name.text;
      if ((name === 'handler' || (['credential', 'deployment', 'unbound', 'grant', 'run'].includes(name)
        && /^(?:entry|route|matched\.route)$/.test(receiver)))
        && module !== 'pipeline.ts' && module !== 'mcp/server.ts') {
        violations.push(`${module}: registry dispatch outside authorization chokepoint`);
      }
      if (name === 'get' && (/(?:^|\.)blobs$/.test(receiver) || blobAliases.has(receiver)) && !RAW_READ_CAPABILITIES.has(module)) {
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
  expect(['deployment', 'project', 'machine', 'credential', 'member', 'run', 'raw', 'protocol']).toContain(declaration.resolver);
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
    ]) expect(boundaryViolations(source, 'new-entry.ts').length).toBeGreaterThan(0);
    expect(boundaryViolations("import type { MemberHandler } from './routes.js';", 'new-entry.ts')).toEqual([]);
    expect(boundaryViolations('env.blobs.get(key);', 'core/raw-resources.ts')).toEqual([]);
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
