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
const MANIFEST_DIR = path.join(ROOT, 'packages/myco/src/symbionts/manifests');
const manifests = fs.readdirSync(MANIFEST_DIR).filter(file => file.endsWith('.yaml'))
  .map(file => SymbiontManifestSchema.parse(YAML.parse(fs.readFileSync(path.join(MANIFEST_DIR, file), 'utf8'))));
const failureFields = new Set(manifests.flatMap(manifest => manifest.toolResult ? [parseDotPath(manifest.toolResult.failure.path).at(-1)!] : []));

function inlineFailureFields(text: string): string[] {
  const source = ts.createSourceFile('parser.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const stringOf = (node: ts.Node, seen = new Set<string>()): string | undefined => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return stringOf(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return undefined;
      const value = constants.get(node.text);
      return value === undefined ? undefined : stringOf(value, new Set([...seen, node.text]));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringOf(node.left, seen), right = stringOf(node.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const field = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) ? stringOf(node.argumentExpression)
        : ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
          ? node.propertyName ? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : stringOf(node.propertyName))
            : ts.isIdentifier(node.name) ? node.name.text : undefined : undefined;
    if (field !== undefined && failureFields.has(field)) {
      found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${field}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The source modules that implement each registered parser, excluding common continuation and bounds. */
function parserModules(agent: string): string[] {
  const seen = new Set<string>();
  const visit = (filename: string): void => {
    if (seen.has(filename)) return;
    seen.add(filename);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith('./') || specifier === './index.js') continue;
      visit(path.join(PARSER_DIR, specifier.replace(/\.js$/, '.ts')));
    }
  };
  visit(path.join(PARSER_DIR, `${agent}.ts`));
  return [...seen];
}

const emitsFailure = (filename: string): boolean => {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  let emits = false;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text === 'tool.failure') emits = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return emits;
};

describe('tool result source authority', () => {
  it('reads harness failure flags only through the shared declaration accessor', () => {
    for (const file of fs.readdirSync(PARSER_DIR).filter(file => file.endsWith('.ts'))) {
      expect({ file, fields: inlineFailureFields(fs.readFileSync(path.join(PARSER_DIR, file), 'utf8')) }).toEqual({ file, fields: [] });
    }
  });

  it('detects inline comparisons, optional access, bracket access and renamed destructures', () => {
    expect(inlineFailureFields(`block.is_error === true; payload.success === false; message?.isError; line['failed']; const { is_error: error } = block; const { success } = payload;`))
      .toEqual(['1: is_error', '1: success', '1: isError', '1: failed', '1: is_error', '1: success']);
    expect(inlineFailureFields(`const failed = toolResultFailed({ declaration, record, result }); const payload = { success: !failed };`)).toEqual([]);
    expect(inlineFailureFields(`const field = 'is_' + 'error'; const alias = field; block[alias]; const { ['isError']: error } = message;`))
      .toEqual(['1: is_error', '1: isError']);
  });

  it('requires a declaration and evidence for every parser source that emits failures', () => {
    const agents = Object.keys(PARSERS).filter(agent => parserModules(agent).some(emitsFailure)).sort();
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
      const paired = [row.reported, row.success].map(value => {
        const record = structuredClone(value);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        unsetAtPath((declaration.failure.from === 'record' ? record : result) as Record<string, unknown>, declaration.failure.path);
        return record;
      });
      expect(paired[0]).toEqual(paired[1]);
      for (const outcome of ['reported', 'success', 'absent'] as const) {
        const record = structuredClone(outcome === 'reported' ? row.reported : row.success);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        if (outcome === 'absent') unsetAtPath((declaration.failure.from === 'record' ? record : result) as Record<string, unknown>, declaration.failure.path);
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
