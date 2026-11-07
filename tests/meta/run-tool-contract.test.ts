import { MAP_LIMITS, MAX_MAP_BYTES } from '@goondocks/myco-shared/canopy';
import { MAX_AUDIT_CHARS, MAX_STEPS, MAX_LISTED, MAX_FAILURES, MAX_REASONING_CHARS } from '@myco-server-worker/core/run-audit.js';
import { runDefinitions, runAllowlist, RUN_TOOL_REGISTRY } from '@myco-server-worker/mcp/run-surface.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { parseCardWrites } from '@myco-server-worker/core/turn-cards.js';
import { parseMapArtifact } from '@goondocks/myco-shared/canopy';
import { parseRunAudit } from '@myco-server-worker/core/run-audit.js';
import { RUN_EXAMPLES } from '@myco-server-worker/mcp/run-definitions.js';
import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript-v6';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';
import { definitionOf, type ToolDefinition } from '@myco-server-worker/mcp/definitions.js';
import { validateInput } from '@myco-server-worker/mcp/validate.js';
import {
  AGENT_LINE_MAX_CHARS,
  AGENT_LINE_TARGET_WORDS,
  AGENT_LINE_WORD_ROOM_CHARS,
  AGENT_LINE_EXAMPLE,
  AGENT_LINE_GUIDANCE,
} from '@myco-server-worker/core/injection.js';
import { EXTRACTION_RULES } from '@myco-server-worker/core/extraction-rules.js';
import { SEEDING_RULES } from '@myco-server-worker/core/seeding-input.js';
import { curationPrompt } from '@myco-server-worker/core/spore-curation.js';
import {
  runRefusal,
  RUN_ACTION_MAX_CHARS,
  RUN_KEY_MAX_CHARS,
  RUN_VERSION_CHARS,
  RUN_SPORE_ID_MAX_CHARS,
  RUN_SEARCH_MAX_CHARS,
} from '@myco-server-worker/core/run-tool-contract.js';
import { MAX_REPORT_DETAILS_CHARS, MAX_REPORT_SUMMARY_CHARS } from '@myco-server-worker/core/run-postconditions.js';
import { TITLE_MAX_CHARS, SUMMARY_MAX_CHARS } from '@myco-server-worker/core/titling-params.js';
import { HANDOFF_MAX_BYTES } from '@myco-server-worker/core/learning-sessions.js';
import { CARD_MAX_CHARS } from '@myco-server-worker/core/read-window.js';
import { CURATION_CLUSTER_CAP, CURATION_REASON_CHARS } from '@myco-server-worker/core/spore-curation-contract.js';
import { OPTIONAL_TEXT_BOUNDS } from '@myco-server-worker/core/spore-input-contract.js';

const root = new URL('../../packages/myco-server/src/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isParenthesizedExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

function bypasses(source: string, inspected: ts.Node | undefined = undefined): string[] {
  const file = ts.createSourceFile('run.ts', source, ts.ScriptTarget.Latest, true);
  const failures = new Set(['failure']);
  const violations: string[] = [];
  const declarations = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'failure') failures.add(node.name.text);
    ts.forEachChild(node, declarations);
  };
  declarations(file);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && failures.has(node.expression.getText(file))) violations.push('failure call');
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === 'ok' &&
            unwrap(property.initializer).kind !== ts.SyntaxKind.TrueKeyword) ||
          (ts.isShorthandPropertyAssignment(property) && property.name.text === 'ok'),
      )
    )
      violations.push('inline refusal');
    ts.forEachChild(node, visit);
  };
  // Nodes inspected from another parse use the same source offsets.
  visit(inspected ?? file);
  return violations;
}

interface SourceModule {
  source: string;
  parsed: ts.SourceFile;
  imports: Map<string, { file: string; name: string }>;
  functions: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>;
}
const registryFile = 'mcp/run-surface.ts';
function refusalScope(load: (file: string) => string): {
  handlers: Set<string>;
  handlerNames: Set<string>;
  helpers: Map<string, Set<string>>;
} {
  const modules = new Map<string, SourceModule>();
  const moduleOf = (path: string): SourceModule => {
    const cached = modules.get(path);
    if (cached) return cached;
    const source = load(path);
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports = new Map<string, { file: string; name: string }>();
    const functions: SourceModule['functions'] = new Map();
    for (const statement of parsed.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith('.') &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        const file = new URL(statement.moduleSpecifier.text, new URL(path, root)).pathname
          .slice(root.pathname.length)
          .replace(/\.js$/, '.ts');
        for (const binding of statement.importClause.namedBindings.elements)
          imports.set(binding.name.text, { file, name: (binding.propertyName ?? binding.name).text });
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          )
            functions.set(declaration.name.text, declaration.initializer);
        }
    }
    const result = { source, parsed, imports, functions };
    modules.set(path, result);
    return result;
  };
  const registry = moduleOf(registryFile);
  const handlers = new Set<string>();
  const handlerNames = new Set<string>();
  const queue: { file: string; name: string }[] = [];
  const declaration = registry.parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === 'RUN_TOOL_REGISTRY')!;
  const roots = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runOperation') {
      const handler = node.arguments[0];
      if (!handler || !ts.isIdentifier(handler) || !registry.imports.has(handler.text))
        throw new Error('Run registry handlers must resolve to imported functions.');
      const held = registry.imports.get(handler.text)!;
      handlers.add(held.file);
      handlerNames.add(held.name);
      queue.push(held);
    }
    ts.forEachChild(node, roots);
  };
  roots(declaration);
  const helpers = new Map<string, Set<string>>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const held = queue.shift()!,
      key = held.file + ':' + held.name;
    if (visited.has(key) || held.file === 'core/run-tool-contract.ts') continue;
    visited.add(key);
    const module = moduleOf(held.file);
    const fn = module.functions.get(held.name);
    if (!fn) throw new Error('Unresolved run refusal helper ' + key);
    const names = helpers.get(held.file) ?? new Set<string>();
    names.add(held.name);
    helpers.set(held.file, names);
    const values = new Map<string, ts.Expression[]>();
    const gather = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        values.set(node.name.text, [...(values.get(node.name.text) ?? []), node.initializer]);
      ts.forEachChild(node, gather);
    };
    gather(fn);
    const traced = new Set<string>();
    const forward = (raw: ts.Expression) => {
      const node = unwrap(raw);
      if (ts.isAwaitExpression(node)) return forward(node.expression);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (module.imports.has(name)) queue.push(module.imports.get(name)!);
        else if (module.functions.has(name)) queue.push({ file: held.file, name });
      } else if (ts.isIdentifier(node) && !traced.has(node.text)) {
        traced.add(node.text);
        for (const value of values.get(node.text) ?? []) forward(value);
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) forward(node.expression);
      else if (ts.isConditionalExpression(node)) {
        forward(node.whenTrue);
        forward(node.whenFalse);
      } else if (ts.isObjectLiteralExpression(node))
        for (const property of node.properties) if (ts.isSpreadAssignment(property)) forward(property.expression);
    };
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) forward(fn.body);
    const returns = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) forward(node.expression);
      ts.forEachChild(node, returns);
    };
    returns(fn);
  }
  return { handlers, handlerNames, helpers };
}
function scopedBypasses(load: (file: string) => string): { file: string; violations: string[] }[] {
  const scope = refusalScope(load);
  return [...scope.helpers].map(([file, names]) => {
    const source = load(file);
    if (scope.handlers.has(file)) return { file, violations: bypasses(source) };
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const fragments: ts.Node[] = [];
    for (const statement of parsed.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) fragments.push(statement);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && names.has(declaration.name.text)) fragments.push(declaration);
    }
    return { file, violations: fragments.flatMap((fragment) => bypasses(source, fragment)) };
  });
}

it('routes run refusals through the mandatory what, actual and next-call helper, including mutations', () => {
  const scope = refusalScope(read);
  expect([...scope.handlerNames].sort()).toEqual(
    [
      ...new Set(
        Object.values(RUN_TOOL_REGISTRY).flatMap((tool) =>
          Object.values(tool.ops).flatMap((entry) => ('handler' in entry ? [entry.handler.name] : [])),
        ),
      ),
    ].sort(),
  );
  for (const result of scopedBypasses(read)) expect(result).toEqual({ file: result.file, violations: [] });
  expect(scope.helpers.get('core/spore-curation.ts')).toContain('completeCuration');
  for (const expression of [
    'false',
    'false as const',
    '(false satisfies boolean)',
    '!true',
    'disabled',
    'true && false',
    'false || false',
  ]) {
    const mutation = `const disabled = false; const bypass = () => ({ok:${expression},error:"try again"});`;
    const load = (file: string) => read(file) + (file === 'mcp/tools/run-learning.ts' ? '\n' + mutation : '');
    expect(scopedBypasses(load).find((result) => result.file === 'mcp/tools/run-learning.ts')!.violations).toContain('inline refusal');
  }
  const virtual = new Map([
    [
      registryFile,
      'import {handleFuture} from "./tools/future-handler.js"; const RUN_TOOL_REGISTRY = {future:{ops:{read:runOperation(handleFuture)}}};',
    ],
    [
      'mcp/tools/future-handler.ts',
      'import {futureRefusal} from "../../core/future-helper.js"; export function handleFuture(){return futureRefusal();}',
    ],
    ['core/future-helper.ts', 'export function futureRefusal(){return {ok:false as const,error:"bad"};}'],
  ]);
  expect(scopedBypasses((file) => virtual.get(file)!).find((result) => result.file === 'core/future-helper.ts')!.violations).toContain(
    'inline refusal',
  );
  expect(bypasses('const success = {ok:true as const};')).toEqual([]);
  expect(bypasses('const ok = false; const refused = {ok};')).toContain('inline refusal');
  expect(bypasses('import {failure as refuse} from "./context"; refuse("bad");')).toContain('failure call');
  const helper = ts.createSourceFile('contract.ts', read('core/run-tool-contract.ts'), ts.ScriptTarget.Latest, true);
  const contract = helper.statements.find(
    (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'RunRefusal',
  )!;
  const fields = contract.members.filter(ts.isPropertySignature);
  for (const required of ['what', 'actual', 'next']) {
    const field = fields.find((member) => member.name.getText(helper) === required)!;
    expect(field).toBeDefined();
    expect(field.questionToken).toBeUndefined();
  }
  const next = fields.find((member) => member.name.getText(helper) === 'next')!.type!;
  expect(ts.isTypeLiteralNode(next)).toBe(true);
  if (ts.isTypeLiteralNode(next))
    for (const required of ['tool', 'op']) {
      const field = next.members.filter(ts.isPropertySignature).find((member) => member.name.getText(helper) === required)!;
      expect(field).toBeDefined();
      expect(field.questionToken).toBeUndefined();
    }
  const admission = ts.createSourceFile('admission.ts', read('core/spore-admission.ts'), ts.ScriptTarget.Latest, true);
  const writer = admission.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'writeSpore',
  )!;
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(admission));
    ts.forEachChild(node, visit);
  };
  visit(writer);
  expect(bypasses(writer.getText(admission))).toEqual([]);
  expect(calls).toContain('runRefusal');
  expect(calls).toContain('withCurationWrite');
  const exporters = admission.statements
    .filter(ts.isFunctionDeclaration)
    .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  expect(exporters.map((node) => node.name?.text)).toEqual(['writeSpore']);
});

type Bound = [string, string, number];
const bounds: Bound[] = [
  ['myco_run', 'action', RUN_ACTION_MAX_CHARS],
  ['myco_run', 'summary', MAX_REPORT_SUMMARY_CHARS],
  ['myco_run', 'details', MAX_REPORT_DETAILS_CHARS],
  ['myco_run', 'audit', MAX_AUDIT_CHARS],
  ['myco_run', 'key', RUN_KEY_MAX_CHARS],
  ['myco_run', 'version', RUN_VERSION_CHARS],
  ['myco_run_spores', 'id', RUN_SPORE_ID_MAX_CHARS],
  ['myco_run_spores', 'search', RUN_SEARCH_MAX_CHARS],
  ['myco_run_sessions', 'title', TITLE_MAX_CHARS],
  ['myco_run_sessions', 'summary', SUMMARY_MAX_CHARS],
  ['myco_run_curation', 'reason', CURATION_REASON_CHARS],
  ['myco_spores', 'agent_line', AGENT_LINE_MAX_CHARS],
];
function missingBounds(definitions: readonly ToolDefinition[]): string[] {
  return bounds.flatMap(([tool, field, limit]) => {
    const definition = definitions.find((item) => item.name === tool)!;
    return definition.inputSchema.properties[field]?.maxLength === limit && definition.description.includes(String(limit))
      ? []
      : [tool + '.' + field];
  });
}
it('publishes the enforced numeric bounds, schemas and a valid example, and catches schema drift', () => {
  const definitions: ToolDefinition[] = [...RUN_DEFINITIONS, definitionOf('myco_spores')!];
  expect(missingBounds(definitions)).toEqual([]);
  const mutated = structuredClone(definitions);
  mutated.find((item) => item.name === 'myco_run_sessions')!.inputSchema.properties.title!.maxLength = TITLE_MAX_CHARS + 1;
  expect(missingBounds(mutated)).toContain('myco_run_sessions.title');
  for (const definition of RUN_DEFINITIONS) {
    expect(definition.inputSchema.examples?.length).toBeGreaterThan(0);
    for (const example of definition.inputSchema.examples!) expect(() => validateInput(definition, example)).not.toThrow();
  }
  expect(Array.isArray(parseCardWrites(RUN_EXAMPLES.myco_run_cards.cards, new Set(['turn-key-from-material'])))).toBe(true);
  expect(() => parseMapArtifact(RUN_EXAMPLES.myco_run_map.artifact)).not.toThrow();
  expect(parseRunAudit(RUN_EXAMPLES.myco_run.audit).ok).toBe(true);
  const handoff = RUN_DEFINITIONS.find((item) => item.name === 'myco_run_learning')!.inputSchema.properties.handoff!;
  expect(handoff.maxLength).toBeUndefined();
  expect(handoff.description).toContain(`${HANDOFF_MAX_BYTES} UTF-8 bytes`);
  for (const field of ['content', 'consolidated_content', 'provenance_ref']) {
    const property = definitionOf('myco_spores')!.inputSchema.properties[field]!;
    expect(property.maxLength).toBeUndefined();
    expect(property.description).toContain('UTF-8 bytes');
  }
  expect(definitionOf('myco_spores')!.description).not.toContain(JSON.stringify(OPTIONAL_TEXT_BOUNDS));
  const curation = RUN_DEFINITIONS.find((item) => item.name === 'myco_run_curation')!;
  expect(curation.inputSchema.properties.members!.maxItems).toBe(CURATION_CLUSTER_CAP);
  const cards = RUN_DEFINITIONS.find((item) => item.name === 'myco_run_cards')!;
  expect(cards.description).toContain(String(CARD_MAX_CHARS));
  const spores = definitionOf('myco_spores')!;
  for (const [field, max] of Object.entries(OPTIONAL_TEXT_BOUNDS))
    if (spores.inputSchema.properties[field]) expect(spores.inputSchema.properties[field]!.maxLength).toBe(max);
  const audit = RUN_DEFINITIONS.find((item) => item.name === 'myco_run')!.inputSchema.properties.audit!.properties!;
  expect(audit.steps!.maxItems).toBe(MAX_STEPS);
  expect(audit.examined!.maxItems).toBe(MAX_LISTED);
  expect(audit.failures!.maxItems).toBe(MAX_FAILURES);
  expect(audit.reasoning!.maxLength).toBe(MAX_REASONING_CHARS);
  const map = RUN_DEFINITIONS.find((item) => item.name === 'myco_run_map')!;
  expect(map.description).toContain(String(MAX_MAP_BYTES));
  const artifact = map.inputSchema.properties.artifact!.properties!;
  expect(artifact.directories!.maxItems).toBe(MAP_LIMITS.directories);
  expect(artifact.domains!.maxItems).toBe(MAP_LIMITS.domains);
  const annotation = artifact.directories!.items!.properties!;
  expect(annotation.path!.maxLength).toBe(MAP_LIMITS.path);
  expect(annotation.annotation!.maxLength).toBe(MAP_LIMITS.annotation);
  expect(annotation.groundedIn!.maxItems).toBe(MAP_LIMITS.groundedIn);
  expect(annotation.groundedIn!.items!.properties!.sha256!.maxLength).toBe(MAP_LIMITS.sha256);
  const domain = artifact.domains!.items!.properties!;
  expect(domain.id!.maxLength).toBe(MAP_LIMITS.id);
  expect(domain.title!.maxLength).toBe(MAP_LIMITS.title);
  expect(domain.files!.maxItems).toBe(MAP_LIMITS.files);
  for (const task of Object.keys(TASK_TOOLS)) {
    const definitions = runDefinitions(runAllowlist(TASK_TOOLS[task]!, { dryRun: false }), task);
    const inventory = definitions.find((item) => item.name === 'myco_run_spores');
    if (inventory !== undefined) {
      const window = readWindowFor(task);
      expect(inventory.description).toContain(String(window.sporeFullReads));
      expect(inventory.inputSchema.properties.max_chars!.maximum).toBe(window.sporeBodyChars);
      expect(inventory.inputSchema.properties.limit!.maximum).toBe(window.sporePage);
    }
    const report = definitions.find((item) => item.name === 'myco_run')!;
    const example = report.inputSchema.examples![0]!;
    if (report.inputSchema.properties.action!.enum) expect(report.inputSchema.properties.action!.enum).toContain(example.action);
  }
  const metadata = read('mcp/run-definitions.ts');
  for (const file of refusalScope(read).handlers) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        for (const item of statement.importClause.namedBindings.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (/^(RUN_.*_(?:CHARS|BYTES)|MAX_REPORT_.*|TITLE_MAX_CHARS|SUMMARY_MAX_CHARS|HANDOFF_MAX_BYTES)$/.test(name))
            expect(metadata).toContain(name);
        }
      }
  }
});

it('gives learning, curation, seeding and spore tools the same measured drafting target', () => {
  expect(AGENT_LINE_EXAMPLE.split(/\s+/).length).toBeLessThanOrEqual(AGENT_LINE_TARGET_WORDS);
  expect(AGENT_LINE_EXAMPLE.length).toBeLessThan(AGENT_LINE_MAX_CHARS);
  expect(AGENT_LINE_TARGET_WORDS * AGENT_LINE_WORD_ROOM_CHARS).toBeLessThanOrEqual(AGENT_LINE_MAX_CHARS);
  for (const text of [
    EXTRACTION_RULES,
    SEEDING_RULES,
    curationPrompt(''),
    definitionOf('myco_spores')!.description,
    definitionOf('myco_spores')!.inputSchema.properties.agent_line!.description!,
  ])
    expect(text).toContain(AGENT_LINE_GUIDANCE);
});

it('requires a bare cause so a composed refusal names exactly one next call', () => {
  const next = { tool: 'myco_spores', op: 'consolidate' };
  const refusal = runRefusal({ what: 'spore write', actual: 'agent_line is too long', next });
  expect(refusal.error.split('Next call:')).toHaveLength(2);
  expect(() => runRefusal({ what: 'curation decision', actual: refusal.error, next })).toThrow('bare cause');
  expect(() => runRefusal({ what: 'curation decision', actual: 'write refused', repair: refusal.error, next })).toThrow('bare cause');
});
