import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import YAML from 'yaml';
import {
  assertRecordIdentityDeclaration, canonicalRecordId, extractRecordSource, recordPlanCoordinate, RecordKindUndeclared,
  type RecordIdRequest, type RecordSourceRequest,
} from '@goondocks/myco-shared/record-identity';
import { getAtPath } from '@goondocks/myco-shared/dot-path';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { DECLARED_SCHEMES } from '@myco-server-worker/ingest/prompt-scheme.js';
import { deriveId } from '@myco/member/envelope.js';
import evidence from '../fixtures/record-identity-evidence.json';
import declarations from '../fixtures/record-identity/declarations.json';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const PACKAGES = path.join(ROOT, 'packages');
const REGISTRY = path.join(PACKAGES, 'myco-shared/src/record-identity.ts');
const MANIFESTS = path.join(PACKAGES, 'myco/src/symbionts/manifests');
const DOMAINS = new Set(['response', 'tool-call', 'plan-tag', ...[...fs.readFileSync(REGISTRY, 'utf8').matchAll(/['"](source-[a-z0-9-]+)['"]/g)].map(match => match[1]!)]);

const symbolKey = (symbol: ts.Symbol): string | undefined => {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration && `${path.relative(PACKAGES, declaration.getSourceFile().fileName)}#${symbol.getName()}`;
};
const resolvedSymbol = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
  const parent = node.parent;
  const binding = ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node && ts.isObjectBindingPattern(parent.parent)
    && ts.isVariableDeclaration(parent.parent.parent) ? parent.parent.parent : undefined;
  const symbol = binding?.initializer && ts.isIdentifier(node)
    ? checker.getPropertyOfType(checker.getTypeAtLocation(binding.initializer), node.text)
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), node.argumentExpression.text)
      : ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
};
const RECORD_ENTRIES = new Set(['canonicalRecordId', 'deriveLegacyRecordId', 'canonicalPromptId'].map(name => `myco-shared/src/record-identity.ts#${name}`));

/** Non-parser identity owners and their fixed domains. */
const NON_PARSER_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  'myco/src/member/envelope.ts#subagentIdFor': ['subagent'],
  'myco/src/member/envelope.ts#planKeyForPath': ['plan'],
  'myco/src/member/envelope.ts#planKeyForTag': ['plan-tag'],
  'myco/src/member/envelope.ts#planKeyForPromptTag': ['plan-tag'],
  'myco/src/member/legacy-import.ts#legacyId': ['legacy'],
  'myco/src/member/legacy-import.ts#legacyPlanKey': ['plan-key'],
  'myco/src/hooks/user-prompt-submit.ts#main': ['thread'],
  'myco/src/member/transcript.ts#deriveTranscriptCapture': ['attachment'],
  'myco-server/src/read/turns.ts#sessionTurnContexts': ['thread', 'subagent'],
  'myco-server/src/ingest/parse.ts#envelopeFor': ['transcript-event'],
  'myco-server/src/ingest/legacy-replies.ts#legacyReplies': ['transcript-event'],
  'myco-server/src/core/plans.ts#planKeyFor': ['plan', 'plan-key'],
};
const KIND_DATA = new Set([
  'myco-server/src/ingest/kinds.ts#kindSpec',
  'myco-server/src/core/processed-resources.ts#processedResourceProofSql',
  'myco/src/member/envelope.ts#envelope',
  'myco/src/member/legacy-import.ts#kinds',
  'myco/src/member/legacy-import.ts#withId',
]);

function entryOwner(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || (ts.isVariableDeclaration(parent) && parent.initializer && (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer)))) && parent.name && ts.isIdentifier(parent.name)) {
      const symbol = checker.getSymbolAtLocation(parent.name);
      if (symbol) return symbolKey(symbol);
    }
  }
  return undefined;
}

function hasherReferences(source: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const hashers = new Set(['myco-server/src/hash.ts#uuidv5', 'myco/src/member/envelope.ts#deriveId']);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const definition = (ts.isFunctionDeclaration(node.parent) || ts.isVariableDeclaration(node.parent)) && node.parent.name === node;
      const memberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const symbol = resolvedSymbol(checker, node);
      if (ts.isIdentifier(node) && symbol && (symbol.flags & ts.SymbolFlags.Module) !== 0) {
        const exposed = checker.getExportsOfModule(symbol).filter(exported => hashers.has(symbolKey(exported) ?? ''));
        const parent = node.parent;
        const selected = (ts.isPropertyAccessExpression(parent) && parent.expression === node)
          || (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression));
        const bound = ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)
          && parent.name.elements.every(element => element.dotDotDotToken === undefined);
        if (!selected && !bound) for (const exported of exposed) found.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${exported.getName()}`);
      }
      if (!definition && !memberName && symbol && hashers.has(symbolKey(symbol) ?? '')) {
        const call = node.parent;
        const callee = ts.isCallExpression(call) ? resolvedSymbol(checker, call.expression) : undefined;
        const argument = ts.isCallExpression(call) && call.arguments[0] === node && callee && RECORD_ENTRIES.has(symbolKey(callee) ?? '');
        const domain = ts.isCallExpression(call) && call.expression === node ? call.arguments[0] : undefined;
        const nonParser = domain && ts.isStringLiteralLike(domain) && NON_PARSER_ENTRIES[entryOwner(checker, node) ?? '']?.includes(domain.text);
        if (!argument && !nonParser) found.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${symbol.getName()}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'dist'].includes(entry.name) ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Resolves literal and imported aliases into direct call-argument domains. */
function externalDomains(text: string, filename = 'source.ts', typed?: { source: ts.SourceFile; checker: ts.TypeChecker }): string[] {
  const source = typed?.source ?? ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings = new Map<string, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, [...(bindings.get(node.name.text) ?? []), node.initializer]);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(element.name) && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))) {
          const value = ts.factory.createElementAccessExpression(node.initializer, ts.factory.createStringLiteral(property.text));
          bindings.set(element.name.text, [...(bindings.get(element.name.text) ?? []), value]);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const unwrap = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;
  const values = (node: ts.Identifier): ts.Expression[] => {
    const local = node.getSourceFile() === source ? bindings.get(node.text) : undefined;
    if (local) return local;
    if (!typed) return [];
    let symbol = typed.checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = typed.checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).flatMap(declaration => ts.isVariableDeclaration(declaration) && declaration.initializer ? [declaration.initializer] : []);
  };
  const strings = (raw: ts.Expression, seen = new Set<string>()): string[] => {
    const node = unwrap(raw);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isSpreadElement(node)) return strings(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : strings(element, seen));
    if (ts.isIdentifier(node) && !seen.has(node.text)) return values(node).flatMap(value => strings(value, new Set([...seen, node.text])));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return strings(node.left, seen).flatMap(left => strings(node.right, seen).map(right => left + right));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) ? node.argumentExpression.text : undefined;
      if (name === undefined) return [];
      const target = unwrap(node.expression);
      const objects = ts.isIdentifier(target) ? values(target) : [target];
      return objects.flatMap(rawObject => {
        const obj = unwrap(rawObject);
        if (ts.isArrayLiteralExpression(obj)) {
          const element = obj.elements[Number(name)];
          return element && !ts.isOmittedExpression(element) ? strings(element, seen) : [];
        }
        return ts.isObjectLiteralExpression(obj) ? obj.properties.flatMap(property => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === name ? strings(property.initializer, seen) : []) : [];
      });
    }
    return [];
  };
  const kindData = (call: ts.CallExpression | ts.NewExpression, argument: ts.Expression): boolean => {
    if (!typed) return false;
    const checker = typed.checker;
    if (ts.isNewExpression(call)) return true;
    const domain = call.arguments[0];
    if (domain && ts.isStringLiteralLike(domain) && NON_PARSER_ENTRIES[entryOwner(checker, call) ?? '']?.includes(domain.text)) return true;
    const symbol = resolvedSymbol(checker, call.expression);
    const key = symbol && symbolKey(symbol);
    if (key && (KIND_DATA.has(key) || Object.hasOwn(NON_PARSER_ENTRIES, key))) return true;
    if (symbol?.declarations?.some(declaration => declaration.getSourceFile().fileName.includes('/node_modules/zod/'))) return true;
    const signature = checker.getResolvedSignature(call);
    if (!signature) return false;
    const result = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
    const dataResult = (type: ts.Type): boolean => type.isUnion() ? type.types.every(dataResult)
      : (type.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    return result !== undefined && dataResult(result);
  };
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const argument of node.arguments ?? []) {
      for (const domain of strings(argument)) if (DOMAINS.has(domain) && !kindData(node, argument)) found.push(`${source.getLineAndCharacterOfPosition(argument.getStart()).line + 1}: ${domain}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('record identity source gate', () => {
  it('keeps record domains and formulas in one registry across every package and parser closure', () => {
    const candidates = sources(PACKAGES).filter(file => file !== REGISTRY);
    const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
    const program = ts.createProgram(candidates, options);
    const checker = program.getTypeChecker();
    const found = candidates.flatMap(file => {
      const source = program.getSourceFile(file)!;
      return [...hasherReferences(source, checker), ...externalDomains(source.text, file, { source, checker })].map(hit => `${path.relative(ROOT, file)}:${hit}`);
    });
    expect(found).toEqual([]);
  });

  it('rejects object-wrapper, member-chain and interpolated-domain bypasses by resolved hasher references', () => {
    const filename = path.join(ROOT, 'packages/myco-server/src/ingest/parsers/identity-gate-probe.ts');
    const text = `import { uuidv5 as hash } from '../../hash.js';
      import { canonicalRecordId as mint } from '@goondocks/myco-shared/record-identity';
      const probeMint = (request: {kind:string}) => hash(request.kind, 's', '1'); probeMint({kind:'response'});
      const domains = {kinds:['response']}; hash(domains.kinds[0], 's', '1');
      hash(\`\${'resp'}onse\`, 's', '1');
      const alias = hash; alias('response', 's', '1');
      const holder = {hash};
      mint(hash, {} as never);
      import * as hashes from '../../hash.js';
      const {uuidv5: renamed} = hashes; renamed('response', 's', '1');
      hashes.uuidv5('response', 's', '1');
      hashes['uuidv5']('response', 's', '1');
      const namespaceAlias = hashes;
      const {...rest} = hashes;
      declare const selected: string; hashes[selected]('response', 's', '1');`;
    const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) => file === filename ? ts.createSourceFile(file, text, language, true) : original(file, language, onError, fresh);
    const program = ts.createProgram([filename], options, host);
    expect(hasherReferences(program.getSourceFile(filename)!, program.getTypeChecker())).toEqual([
      '3: uuidv5', '4: uuidv5', '5: uuidv5', '6: uuidv5', '7: uuidv5', '10: uuidv5', '11: uuidv5', '12: uuidv5', '13: uuidv5', '14: uuidv5', '15: uuidv5',
    ]);
  });

  it('detects renamed callees, const/domain aliases and object aliases while admitting typed kind data', () => {
    expect(externalDomains(`renamed('response', s, o); const domain = 'tool-call'; const alias = domain; hash(alias, s, k); const domains = { plan: 'plan-tag' } as const; anyName(domains.plan, s); const { plan: planDomain } = domains; mintAlias(planDomain, s); hash('source-' + 'response-v1', s);`)).toEqual(['1: response', '1: tool-call', '1: plan-tag', '1: plan-tag', '1: source-response-v1']);
    expect(externalDomains(`canonicalRecordId(hash, { kind: 'response', source, scheme }); extractRecordSource({ kind: 'tool-call' });`)).toEqual([]);
  });

  it('rejects hash aliases, array spreads and every identity-bearing return type', () => {
    const filename = path.join(ROOT, 'identity-gate-probe.ts');
    const text = `declare function hash(...parts: string[]): string; declare function generic<R>(...parts: string[]): R;
      const domain = 'response'; const alias = domain; hash(alias, 's', '1'); generic('tool-call', 's', 'k');
      declare function objectId(...parts:string[]): { id:string }; objectId('plan-tag', 's', 'p');
      declare function finite(domain:'response', ...parts:string[]):string; finite('response', 's', '1');
      declare function byteHash(...parts:string[]):Uint8Array; byteHash('tool-call', 's', 'k');
      declare function numericHash(domain:'response'|'tool-call', ...parts:string[]):number; numericHash('response', 's', '1');
      declare function wrapped(...parts:string[]): { digest:string }; const renamed = wrapped; renamed('response', 's', '1').digest;
      const parts = [domain, 's', '1']; const partAlias = parts; hash(...partAlias);
      const nested = [...parts, 'k']; hash(...nested); hash(parts as unknown as string);
      const data = (kind: 'response' | 'plan'): boolean => kind === 'response'; data('response');`;
    const host = ts.createCompilerHost({});
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) => file === filename ? ts.createSourceFile(file, text, language, true) : original(file, language, onError, fresh);
    const program = ts.createProgram([filename], {}, host);
    expect(externalDomains(text, filename, { source: program.getSourceFile(filename)!, checker: program.getTypeChecker() }))
      .toEqual(['2: response', '2: tool-call', '3: plan-tag', '4: response', '5: tool-call', '6: response', '7: response', '8: response', '9: response', '9: response']);
  });

  it('follows imported constants and imported object members used by arbitrary hash calls', () => {
    const filename = path.join(ROOT, 'identity-import-probe.ts');
    const domainfile = path.join(ROOT, 'identity-domain-probe.ts');
    const text = `import { DOMAIN, DOMAINS } from './identity-domain-probe';
      declare function renamed(...parts:string[]):string;
      renamed(DOMAIN, 's', '1'); renamed(DOMAINS.tool, 's', 'k');`;
    const modules = new Map([[filename, text], [domainfile, `export const DOMAIN='response'; export const DOMAINS={tool:'tool-call'} as const;`]]);
    const host = ts.createCompilerHost({});
    const originalSource = host.getSourceFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    host.fileExists = file => modules.has(file) || originalExists(file);
    host.getSourceFile = (file, language, onError, fresh) => modules.has(file) ? ts.createSourceFile(file, modules.get(file)!, language, true) : originalSource(file, language, onError, fresh);
    const program = ts.createProgram([...modules.keys()], {}, host);
    expect(externalDomains(text, filename, { source: program.getSourceFile(filename)!, checker: program.getTypeChecker() }))
      .toEqual(['3: response', '3: tool-call']);
  });

  it('names only the three deferred positional prompt branches in the registry', () => {
    const text = fs.readFileSync(REGISTRY, 'utf8');
    expect(text).toContain("case 'offset-v1':\n      return hash(request.namespace, request.sessionId, String(request.offset));");
    expect(text).toContain("return request.stamp ?? hash('prompt', request.sessionId, String(request.offset));");
    expect(text).toContain("? hash('transcript-prompt', request.sessionId, String(request.position))");
  });
});

describe('record identity declaration evidence', () => {
  const manifests = fs.readdirSync(MANIFESTS).filter(file => file.endsWith('.yaml')).map(file => SymbiontManifestSchema.parse(YAML.parse(fs.readFileSync(path.join(MANIFESTS, file), 'utf8'))));

  it('freezes every parser declaration and carries it through both generated carriers', () => {
    const actual = Object.fromEntries(manifests.filter(manifest => manifest.recordIdentity).map(manifest => [manifest.name, manifest.recordIdentity]));
    expect<unknown>(actual).toEqual(declarations);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(PARSERS).sort());
    for (const manifest of manifests) {
      expect(CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === manifest.name)?.recordIdentity).toEqual(manifest.recordIdentity);
      expect(BUNDLED_MANIFESTS.find(bundle => bundle.name === manifest.name)?.recordIdentity).toEqual(manifest.recordIdentity);
    }
  });

  it('pairs each key, ordered alternative, result, position and thread default with exact source and ID evidence', () => {
    for (const manifest of manifests) {
      if (!manifest.recordIdentity) continue;
      assertRecordIdentityDeclaration(manifest.name, manifest.recordIdentity);
      for (const [scheme, rules] of Object.entries(manifest.recordIdentity.schemes)) for (const [kind, rule] of Object.entries(rules)) {
        expect(fs.existsSync(path.join(ROOT, rule.evidence))).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(ROOT, rule.evidence), 'utf8'))).toEqual(evidence);
        const rows = evidence.filter(row => row.agent === manifest.name && row.kind === kind);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          const source = extractRecordSource({ ...row.facts, declaration: manifest.recordIdentity, scheme, kind } as RecordSourceRequest);
          expect<unknown>(source).toEqual(row.source);
          if (row.kind === 'plan') expect(recordPlanCoordinate({ declaration: manifest.recordIdentity, scheme: scheme as RecordSourceRequest['scheme'], source, matchIndex: 1 })).toEqual(row.coordinate!);
          const request = { kind, scheme, agent: manifest.name, sessionId: 'session-1', transcriptId: 'transcript-1', offset: row.offset, source,
            ...(row.kind === 'plan' ? { tag: row.tag!, coordinate: row.coordinate!, legacyPosition: row.legacyPosition! } : {}) } as RecordIdRequest;
          expect(canonicalRecordId(deriveId, request)).toBe(scheme === 'source-record-v1' ? row.sourceId : row.legacyId);
        }
        if (scheme === 'legacy-session-v1') continue;
        if (rule.position || rule.absentKey === 'position') expect(rows.some(row => 'position' in row.source)).toBe(true);
        for (const [role, field] of [['call', rule.key], ['result', rule.resultKey]] as const) {
          if (field === undefined) continue;
          const paths = typeof field.path === 'string' ? [field.path] : field.path;
          for (const [pathIndex, keyPath] of paths.entries()) expect(rows.some(row => {
            const facts = row.facts as Record<string, unknown>;
            return 'key' in row.source && row.source.key !== undefined && (role === 'result' ? facts.role === 'result' : facts.role !== 'result')
              && getAtPath(facts[field.from], keyPath) === row.source.key
              && paths.slice(0, pathIndex).every(prior => getAtPath(facts[field.from], prior) == null);
          })).toBe(true);
        }
        if (rule.thread?.absent) {
          expect(rows.some(row => 'thread' in row.source && row.source.thread === rule.thread!.absent)).toBe(true);
          expect(rows.some(row => 'thread' in row.source && row.source.thread !== rule.thread!.absent)).toBe(true);
        }
      }
    }
  });

  it('pairs keyed and absent-key chunk fixtures with their original content-block anchors', () => {
    const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'claude-code')!.recordIdentity;
    const paired = evidence.flatMap(row => 'pairedFixtures' in row ? row.pairedFixtures ?? [] : []);
    expect(paired.length).toBe(2);
    for (const fixture of paired) {
      const record = JSON.parse(fs.readFileSync(path.join(ROOT, fixture.path), 'utf8').trimEnd().split('\n')[fixture.line]!);
      const ids = fixture.anchors.map(anchor => {
        const source = extractRecordSource({ declaration, scheme: 'source-record-v1', kind: 'response', record, block: anchor.block });
        expect<unknown>(source).toEqual(anchor.source);
        const id = canonicalRecordId(deriveId, { scheme: 'source-record-v1', kind: 'response', agent: 'claude-code', sessionId: 'session-1', transcriptId: 'transcript-1', offset: fixture.offset, source });
        expect(id).toBe(anchor.id);
        return id;
      });
      expect(new Set(ids).size).toBe(2);
    }
  });

  it('declares every kind the registered parser emits from its paired complete transcript', async () => {
    for (const parser of Object.values(PARSERS)) {
      const agentFixture = parser.agent === 'claude-code' ? 'claude' : parser.agent;
      let offset = 0;
      const lines = fs.readFileSync(path.join(ROOT, `tests/fixtures/${agentFixture}-parse-basic.jsonl`), 'utf8').trimEnd().split('\n').map(text => {
        const line = { value: JSON.parse(text) as Record<string, unknown>, offset }; offset += Buffer.byteLength(text) + 1; return line;
      });
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === parser.agent)!.recordIdentity!;
      const planRecord = evidence.find(row => row.agent === parser.agent && row.kind === 'plan' && row.facts.record && 'key' in row.source)?.facts.record;
      if (planRecord) lines.push({ value: planRecord as Record<string, unknown>, offset });
      for (const scheme of ['legacy-session-v1', 'source-record-v1'] as const) {
        const events = await parser.parse({ lines, sessionId: 's1', transcriptId: 'paired-transcript', recordScheme: scheme,
          scheme: DECLARED_SCHEMES[parser.agent]!, now: Date.now(), terminal: 'complete_file' });
        const emitted = [...new Set(events.flatMap(event => event.kind === 'response' ? ['response']
          : event.kind === 'tool.use' || event.kind === 'tool.failure' ? ['tool-call'] : event.kind === 'plan' ? ['plan'] : []))].sort();
        expect({ agent: parser.agent, emitted }).toEqual({ agent: parser.agent, emitted: Object.keys(declaration.schemes[scheme]!).sort() });
      }
    }
  });

  it('refuses an undeclared emitted kind through the runtime accessor under either pin', () => {
    for (const manifest of manifests) {
      for (const scheme of ['legacy-session-v1', 'source-record-v1'] as const) for (const kind of ['response', 'tool-call', 'plan'] as const) {
        if (manifest.recordIdentity?.schemes[scheme]?.[kind]) continue;
        expect(() => extractRecordSource({ declaration: manifest.recordIdentity, scheme, kind })).toThrow(RecordKindUndeclared);
      }
    }
  });

  it('rejects declarations missing evidence, a retained kind, a current definition, or a supported scheme', () => {
    const original = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'claude-code')!.recordIdentity!;
    const mutations: Array<(value: any) => void> = [
      value => { delete value.schemes['source-record-v1'].response.evidence; },
      value => { delete value.schemes['legacy-session-v1'].plan; },
      value => { delete value.schemes['source-record-v1']; },
      value => { value.scheme = 'unknown'; },
      value => { value.schemes.unknown = value.schemes['source-record-v1']; },
      value => { value.schemes['source-record-v1'].response.key.path = '__proto__.id'; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(original); mutate(value);
      expect(() => assertRecordIdentityDeclaration('claude-code', value)).toThrow();
      const manifest = structuredClone(manifests.find(manifest => manifest.name === 'claude-code')!);
      manifest.recordIdentity = value;
      expect(SymbiontManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});
