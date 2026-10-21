import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import YAML from 'yaml';
import { assertToolResultDeclaration, toolResultDeclarationOf, toolResultFailed, ToolResultDeclarationInvalid } from '@goondocks/myco-shared/tool-result';
import { getAtPath, parseDotPath, unsetAtPath } from '@goondocks/myco-shared/dot-path';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { DECLARED_SCHEMES } from '@myco-server-worker/ingest/prompt-scheme.js';
import evidence from '../fixtures/tool-result-evidence.json';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const PARSER_DIR = path.join(ROOT, 'packages/myco-server/src/ingest/parsers');
const INGEST_DIR = path.dirname(PARSER_DIR);
const MANIFEST_DIR = path.join(ROOT, 'packages/myco/src/symbionts/manifests');
const manifests = fs.readdirSync(MANIFEST_DIR).filter(file => file.endsWith('.yaml'))
  .map(file => SymbiontManifestSchema.parse(YAML.parse(fs.readFileSync(path.join(MANIFEST_DIR, file), 'utf8'))));
const failureFields = new Set(manifests.flatMap(manifest => manifest.toolResult?.failure ? [parseDotPath(manifest.toolResult.failure.path).at(-1)!] : []));

function expressionSource(text: string) {
  const source = ts.createSourceFile('parser.ts', text, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  return { source, constants };
}

function resolvedExpression(node: ts.Node, constants: ReadonlyMap<string, ts.Expression>, seen = new Set<string>()): { node: ts.Node; seen: Set<string> } | undefined {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node) || ts.isComputedPropertyName(node)) {
    return resolvedExpression(node.expression, constants, seen);
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    if (seen.has(node.text)) return undefined;
    return resolvedExpression(constants.get(node.text)!, constants, new Set([...seen, node.text]));
  }
  return { node, seen };
}

function inlineFailureFields(text: string, filename = path.join(PARSER_DIR, 'parser.ts')): string[] {
  const { source, constants } = expressionSource(text);
  const found: string[] = [];
  const scanLiterals = filename.startsWith(INGEST_DIR + path.sep)
    || runtimeImports(source).some(specifier => path.basename(specifier).replace(/\.(?:js|ts)$/, '') === 'dot-path');
  const stringOf = (expression: ts.Node, seen = new Set<string>()): string | undefined => {
    const resolved = resolvedExpression(expression, constants, seen);
    if (!resolved) return undefined;
    const { node, seen: visited } = resolved;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringOf(node.left, visited), right = stringOf(node.right, visited);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const visit = (node: ts.Node, keyExpression = false): void => {
    const field = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) ? stringOf(node.argumentExpression)
        : ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
          ? node.propertyName ? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : stringOf(node.propertyName))
            : ts.isIdentifier(node.name) ? node.name.text : undefined : undefined;
    const literal = (scanLiterals || keyExpression) && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) ? node.text : undefined;
    const name = (literal ?? field)?.split('.').at(-1);
    const flagged = name !== undefined && failureFields.has(name);
    if (flagged) {
      found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${name}`);
    }
    if (ts.isElementAccessExpression(node)) {
      visit(node.expression, keyExpression);
      if (!flagged) visit(node.argumentExpression, true);
      return;
    }
    if (ts.isBindingElement(node) && node.propertyName && !ts.isIdentifier(node.propertyName)) {
      if (!flagged) visit(node.propertyName, true);
      visit(node.name, keyExpression);
      if (node.initializer) visit(node.initializer, keyExpression);
      return;
    }
    ts.forEachChild(node, child => visit(child, keyExpression));
  };
  visit(source);
  return found;
}

const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile).config;
const options = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
const AUTHORITIES = new Set(['tool-result.ts', 'capture-rules.generated.ts'].map(file => path.join(ROOT, 'packages/myco-shared/src', file)));
const readSource = (filename: string) => fs.readFileSync(filename, 'utf8');
const resolveImport = (specifier: string, filename: string): string | undefined => {
  const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule;
  return resolved?.isExternalLibraryImport ? undefined : resolved?.resolvedFileName;
};

function runtimeImports(source: ts.SourceFile): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
      || (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** Runtime import closure; manifest data and its accessor own the declared fields. */
function reachableModules(entry: string, read = readSource, resolve = resolveImport): string[] {
  const seen = new Set<string>();
  const visit = (filename: string): void => {
    if (seen.has(filename) || AUTHORITIES.has(filename)) return;
    seen.add(filename);
    const source = ts.createSourceFile(filename, read(filename), ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeImports(source)) {
      const resolved = resolve(specifier, filename);
      if (resolved) visit(resolved);
    }
  };
  visit(entry);
  return [...seen];
}
const parserModules = (agent: string) => reachableModules(path.join(PARSER_DIR, `${agent}.ts`));

function emitsFailure(filename: string, text = readSource(filename)): boolean {
  const { source, constants } = expressionSource(text);
  let emits = false;
  const value = (expression: ts.Node, seen = new Set<string>()): boolean => {
    const resolved = resolvedExpression(expression, constants, seen);
    if (!resolved) return false;
    const { node, seen: visited } = resolved;
    return ts.isStringLiteralLike(node) && node.text === 'tool.failure'
      || ts.isConditionalExpression(node) && (value(node.whenTrue, visited) || value(node.whenFalse, visited));
  };
  const visit = (node: ts.Node): void => {
    if (filename === path.join(PARSER_DIR, 'index.ts') && ts.isFunctionDeclaration(node) && node.name?.text === 'unfinishedCalls') return;
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? resolvedExpression(node.name.expression, constants)?.node : node.name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'kind' && value(node.initializer)) emits = true;
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'kind' && value(node.name)) emits = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return emits;
}

describe('tool result source authority', () => {
  it('reads harness failure flags only through the shared declaration accessor', () => {
    for (const file of new Set(Object.keys(PARSERS).flatMap(parserModules))) {
      expect({ file, fields: inlineFailureFields(readSource(file), file) }).toEqual({ file, fields: [] });
    }
  });

  it('detects inline comparisons, optional access, bracket access and renamed destructures', () => {
    expect(inlineFailureFields(`block.is_error === true; payload.success === false; message?.isError; line['failed']; const { is_error: error } = block; const { success } = payload;`))
      .toEqual(['1: is_error', '1: isError', '1: failed', '1: is_error']);
    expect(inlineFailureFields(`const failed = toolResultFailed({ declaration, record, result }); const payload = { success: !failed };`)).toEqual([]);
    expect(inlineFailureFields(`const field = 'is_' + 'error'; const alias = field; block[alias]; const { ['isError']: error } = message;`))
      .toEqual(['1: is_error', '1: isError']);
  });

  it('detects flag literals passed to helpers and reads moved outside the parser directory', () => {
    expect(inlineFailureFields("getAtPath(block, 'is_error') === true; 'isError' in result; getAtPath(record, `payload.failed`); record['payload.is_error'];")).toEqual(['1: is_error', '1: isError', '1: failed', '1: is_error']);
    expect(inlineFailureFields("block[`${'is_error'}`]; const { [String('isError')]: bad } = message; block[`${prefix}.is_error`];"))
      .toEqual(['1: is_error', '1: isError', '1: is_error']);
    const entry = path.join(PARSER_DIR, 'probe.ts');
    const helper = path.resolve(PARSER_DIR, '../tool-flags.ts');
    const files: Record<string, string> = { [entry]: "import { failure } from '../tool-flags.js';", [helper]: "export const failure = getAtPath(block, 'is_error') === true;" };
    const modules = reachableModules(entry, file => files[file]!, (specifier, from) => path.resolve(path.dirname(from), specifier.replace(/\.js$/, '.ts')));
    expect(modules).toEqual([entry, helper]);
    expect(modules.flatMap(file => inlineFailureFields(files[file]!, file))).toEqual(['1: is_error']);
    const index = path.join(PARSER_DIR, 'index.ts');
    expect(emitsFailure(index, "export function unfinishedCalls() { return [{ kind: 'tool.failure' }]; }")).toBe(false);
    for (const key of ['kind', "'kind'", "['kind']"]) {
      expect(emitsFailure(index, `export function anotherFailure() { return [{ ${key}: 'tool.failure' }]; }`)).toBe(true);
    }
  });

  it('detects wrapped, aliased and shorthand failure emitters', () => {
    const file = path.join(PARSER_DIR, 'index.ts');
    for (const expression of ["'tool.failure' as const", "('tool.failure')", "'tool.failure' satisfies string", "<string>'tool.failure'"]) {
      expect({ expression, emits: emitsFailure(file, `export const failure = () => [{ kind: ${expression} }];`) })
        .toEqual({ expression, emits: true });
    }
    expect(emitsFailure(file, "const failure = 'tool.failure' as const; const kind = failure; export const anotherFailure = () => [{ kind }];")).toBe(true);
    expect(emitsFailure(file, "const a = b; const b = a; export const anotherFailure = () => [{ kind: a }];")).toBe(false);
  });

  it('limits standalone flag literals to ingest modules and dot-path consumers, while checking field reads throughout the closure', () => {
    const shared = path.join(ROOT, 'packages/myco-shared/src/status.ts');
    const display = "export const text = 'failed';";
    expect(inlineFailureFields(display, shared)).toEqual([]);
    expect(inlineFailureFields("record[`${'is_error'}`]; const { [String('isError')]: bad } = record; record[`${prefix}.failed`];", shared))
      .toEqual(['1: is_error', '1: isError', '1: failed']);
    expect(inlineFailureFields(display, path.join(PARSER_DIR, '../status.ts'))).toEqual(['1: failed']);
    expect(inlineFailureFields("record.is_error; record['isError']; const { failed: bad } = record;", shared))
      .toEqual(['1: is_error', '1: isError', '1: failed']);
    expect(inlineFailureFields("import { getAtPath } from '@goondocks/myco-shared/dot-path'; export const bad = getAtPath(record, 'is_error');", shared))
      .toEqual(['1: is_error']);
    const entry = path.join(PARSER_DIR, 'probe.ts');
    const files: Record<string, string> = {
      [entry]: `import { bad } from '${path.relative(PARSER_DIR, shared).replace(/\.ts$/, '.js')}';`,
      [shared]: "import { getAtPath } from '@goondocks/myco-shared/dot-path'; export const bad = getAtPath(record, 'is_error');",
    };
    const modules = reachableModules(entry, file => files[file]!, (specifier, from) => specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier.replace(/\.js$/, '.ts')) : undefined);
    expect(modules).toEqual([entry, shared]);
    expect(modules.flatMap(file => inlineFailureFields(files[file]!, file))).toEqual(['1: is_error']);
  });

  it('requires a declaration and evidence for every parser source that emits failures', () => {
    const agents = Object.keys(PARSERS).filter(agent => parserModules(agent).some(file => emitsFailure(file))).sort();
    expect(manifests.filter(manifest => manifest.toolResult).map(manifest => manifest.name).sort()).toEqual(agents);
    expect(evidence.map(row => row.agent).sort()).toEqual(agents);
    for (const agent of agents) expect(toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, agent)).toBeDefined();
  });

  it('carries the exact manifest declaration through both generated carriers', () => {
    for (const manifest of manifests) {
      expect(toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, manifest.name)).toEqual(manifest.toolResult);
      expect(BUNDLED_MANIFESTS.find(bundle => bundle.name === manifest.name)?.toolResult).toEqual(manifest.toolResult);
    }
  });

  it('pairs every declared flag with reported, success and absent evidence through the accessor and parser', async () => {
    for (const row of evidence) {
      const declaration = toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, row.agent)!;
      assertToolResultDeclaration(row.agent, declaration);
      expect(fs.existsSync(path.join(ROOT, declaration.evidence))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(ROOT, declaration.evidence), 'utf8'))).toEqual(evidence);
      expect(fs.existsSync(path.join(ROOT, row.provenance.source))).toBe(true);
      expect(row.provenance.detail.length).toBeGreaterThan(0);
      if (declaration.failure === null) {
        expect(row.reported).toBeUndefined();
        const records = fs.readFileSync(path.join(ROOT, row.provenance.source), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const outputs = records.filter(record => record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type));
        expect(outputs.length).toBeGreaterThan(0);
        for (const record of outputs) {
          expect(record.payload).not.toHaveProperty('success');
          expect(toolResultFailed({ declaration, record, result: record.payload })).toBe(false);
        }
        expect(toolResultFailed({ declaration, record: { payload: { success: false } } })).toBe(false);
        for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
          const events = await PARSERS[row.agent]!.parse({ lines: records.map((value, offset) => ({ value, offset })),
            sessionId: 'result-session', transcriptId: 'result-transcript', recordScheme,
            scheme: DECLARED_SCHEMES[row.agent]!, now: Date.parse('2027-01-01T00:00:00Z'), terminal: 'complete_file' });
          const tools = events.filter(event => event.kind === 'tool.use' || event.kind === 'tool.failure');
          expect(tools.length).toBeGreaterThan(0);
          for (const tool of tools) expect({ kind: tool.kind, reason: tool.payload.resultReason, success: tool.payload.success })
            .toEqual({ kind: 'tool.use', reason: undefined, success: true });
        }
        continue;
      }
      const failure = declaration.failure;
      const paired = [row.reported, row.success].map(value => {
        const record = structuredClone(value);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        unsetAtPath((failure.from === 'record' ? record : result) as Record<string, unknown>, failure.path);
        return record;
      });
      expect(paired[0]).toEqual(paired[1]);
      for (const outcome of ['reported', 'success', 'absent'] as const) {
        const record = structuredClone(outcome === 'reported' ? row.reported : row.success);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        if (outcome === 'absent') unsetAtPath((failure.from === 'record' ? record : result) as Record<string, unknown>, failure.path);
        const failed = outcome === 'reported';
        expect({ agent: row.agent, outcome, failed: toolResultFailed({ declaration, record, result }) }).toEqual({ agent: row.agent, outcome, failed });
        for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
          const records = [...row.before, record];
          const lines = records.map((value, offset) => ({ value: value as Record<string, unknown>, offset }));
          const events = await PARSERS[row.agent]!.parse({ lines, sessionId: 'result-session', transcriptId: 'result-transcript', recordScheme,
            scheme: DECLARED_SCHEMES[row.agent]!, now: Date.parse('2027-01-01T00:00:00Z'), terminal: 'complete_file' });
          const tools = events.filter(event => event.kind === 'tool.use' || event.kind === 'tool.failure');
          expect({ agent: row.agent, outcome, recordScheme, kinds: tools.map(event => event.kind) }).toEqual({ agent: row.agent, outcome, recordScheme, kinds: [failed ? 'tool.failure' : 'tool.use'] });
          expect(tools[0]!.payload.resultReason).toBe(failed ? 'reported' : undefined);
          expect(tools[0]!.payload.success).toBe(!failed);
        }
      }
    }
  });

  it('refuses missing and malformed declarations in both schema and runtime accessor', () => {
    const original = toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, 'claude-code')!;
    const mutations: Array<(value: any) => void> = [
      value => { delete value.evidence; }, value => { value.evidence = ''; }, value => { value.evidence = ' '; },
      value => { delete value.failure; }, value => { value.failure.from = 'call'; },
      value => { value.failure.path = ''; }, value => { value.failure.path = '...'; }, value => { value.failure.path = '__proto__.is_error'; },
      value => { value.failure.equals = 'true'; }, value => { delete value.failure.equals; },
      value => { value.failure.other = true; }, value => { value.other = true; },
    ];
    expect(() => toolResultFailed({ declaration: undefined })).toThrow(ToolResultDeclarationInvalid);
    for (const mutate of mutations) {
      const declaration = structuredClone(original); mutate(declaration);
      expect(() => assertToolResultDeclaration('claude-code', declaration)).toThrow(ToolResultDeclarationInvalid);
      expect(() => toolResultFailed({ declaration })).toThrow(ToolResultDeclarationInvalid);
      const manifest = { ...manifests.find(manifest => manifest.name === 'claude-code')!, toolResult: declaration };
      expect(SymbiontManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});
