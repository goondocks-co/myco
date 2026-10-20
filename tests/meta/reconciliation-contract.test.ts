/**
 * Two states of one session are combined in one place (`member/session-reconcile.ts`), by one declared rule per field,
 * and only at the seams that move a session between spools.
 *
 * A. Field coverage: every `SessionState` field has a rule (the `satisfies` clause there fails the type check, and the
 *    `Required<SessionState>` fixture here fails it too); each composite rule decides exactly the fields declared for
 *    it; and no other function takes two session states to combine them.
 * B. The seams: the reconciler, the source-state reader and its declared wrapper are called only from the functions
 *    named here, and inside them a source state is used only in the enumerated ways. Positive and negative fixtures
 *    pin the checker itself. The checks are call-site and use-site checks resolved by the compiler, not a dataflow
 *    analysis: the generic `readSessionState*` readers take any directory, and a new foreign read through them is
 *    not seen here; the production-path tests in `tests/member` are authoritative for behavior.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { SESSION_COMPOSITE_RULES, SESSION_FIELD_RULES } from '@myco/member/session-reconcile.js';
import type { SessionState } from '@myco/member/session-state.js';

const REPO = path.resolve(import.meta.dir, '../..');
const SRC = path.join(REPO, 'packages/myco/src');
const MEMBER = path.join(SRC, 'member');
const RECONCILER = path.join(MEMBER, 'session-reconcile.ts');

/** The functions that fold another spool's state into a session's own. */
const SEAMS = ['restoreHeldReceiptsForHook', 'moveHeld', 'copySession'];
/** The seams that read another spool's state themselves. */
const READERS = ['moveHeld', 'copySession'];
/** A declared reader of another spool's state, and the only functions that may call it. */
const WRAPPERS: Record<string, string[]> = { heldSessionStates: ['restoreHeldReceiptsForHook'] };
/** Functions besides the reconciler's own that take two session states, and why each is not a merge. */
const TWO_STATE_FUNCTIONS: Record<string, string> = {
  [`${path.join(MEMBER, 'session-state.ts')}#replaceSessionState`]: 'writes a reconciled state back over the one a writer handed out',
};

const FULL: Required<SessionState> = {
  version: 1, highWater: 1, markWater: 1, markGeneration: 'g', startSettled: true, promptId: 'p', prompts: { h: 'p' },
  transcript: { path: '/t', transcriptId: 't', inode: 1, nextOffset: 0, parsedSize: 0 },
  continuations: { '/c': { path: '/c', transcriptId: 'c', inode: 2, nextOffset: 0, parsedSize: 0 } },
  siblings: { '/s': { path: '/s', transcriptId: 's', inode: 3, nextOffset: 0, parsedSize: 0 } },
  planHashes: { h: 'k' }, planTagCount: 1, planPaths: { '/p': { planKey: 'k', hash: 'h' } }, attachmentKeys: ['a'], delivered: ['cortex'],
  compactionOrdinal: 1, agent: 'claude-code', agentUnknown: true, transcriptRetry: { at: 1, backoffMs: 1 }, eventRetry: { at: 1, backoffMs: 1 },
  startedAt: 1, lastAckAt: 1, lastAccountedAt: 1, lastDeliveryAt: 1, contextAsks: [{ kind: 'start', at: 1, id: 'a' }],
  promptBackfill: { transcriptPath: '/t', at: 1 }, hookAt: 1, endedAt: 1, renderedAsk: 'a', turn: { id: 't', promptId: 'p' },
  updatedAt: 1, pendingLosses: [],
};

describe('A. session field coverage', () => {
  it('declares a rule for exactly the fields a session state has', () => {
    expect(Object.keys(SESSION_FIELD_RULES).sort()).toEqual(Object.keys(FULL).sort());
  });

  it('has each composite rule decide exactly the fields declared for it', () => {
    for (const [rule, decide] of Object.entries(SESSION_COMPOSITE_RULES)) {
      const declared = Object.entries(SESSION_FIELD_RULES).filter(([, owner]) => owner === rule).map(([field]) => field).sort();
      expect({ rule, fields: Object.keys(decide(FULL, FULL)).sort() }).toEqual({ rule, fields: declared });
    }
  });
});

const config = ts.readConfigFile(path.join(REPO, 'tsconfig.json'), ts.sys.readFile);
if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, REPO);
if (options.errors.length > 0) throw new Error(options.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));

const sourcesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? sourcesUnder(file) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [file] : [];
});

/** Fixtures are served as virtual files beside the reconciler, so their imports resolve as a member module's do. */
const fixturePath = (name: string): string => path.join(MEMBER, `__reconciliation_fixture_${name}.ts`);
const FIXTURE_IMPORTS = `
import { readSourceStateForMove, reconcileSessionState, type SourceSessionState } from './session-reconcile.js';
import { emptySessionState, type SessionState } from './session-state.js';
import { heldSessionStates } from './pending.js';
declare function alternative(states: { target: SessionState; source: SessionState }): SessionState;
declare const route: Parameters<typeof heldSessionStates>[1];
`;
const NEGATIVE_FIXTURES: Record<string, string> = {
  objectArgument: `export function copySession(target: SessionState) {
    const read = readSourceStateForMove('dir', 's', 'held');
    if (!read.ok) return;
    const source = read.state;
    return alternative({ target, source });
  }`,
  arrayReduce: `export function copySession(target: SessionState) {
    const read = readSourceStateForMove('dir', 's', 'held');
    if (!read.ok) return;
    const source = read.state;
    return [target, source].reduce((a, b) => ({ ...a, ...b }));
  }`,
  spread: `export function moveHeld(target: SessionState) {
    const read = readSourceStateForMove('dir', 's', 'take');
    if (!read.ok) return;
    const source = read.state;
    return { ...target, ...source };
  }`,
  mapMerge: `export function restoreHeldReceiptsForHook(target: SessionState) {
    const states = heldSessionStates('/root', route, 's', '/home');
    const merge = (state: SourceSessionState) => reconcileSessionState(target, state).state;
    return states.map(merge);
  }`,
  aliasedImport: `import { reconcileSessionState as fold } from './session-reconcile.js';
  export function sneaky(target: SessionState, source: SourceSessionState) { return fold(target, source); }`,
  outsideSeams: `export function helper() {
    const read = readSourceStateForMove('dir', 's', 'held');
    return read.ok ? reconcileSessionState(emptySessionState(), read.state) : null;
  }`,
  undeclaredWrapperCaller: `export function moveHeld() {
    return heldSessionStates('/root', route, 's', '/home').length;
  }`,
  twoStates: `export function combine(left: SessionState, right: SessionState): SessionState { return { ...right, ...left }; }`,
};
/** The violation each negative seam fixture must report. */
const FLAGGED: Record<string, string> = {
  objectArgument: 'source state used in copySession: source',
  arrayReduce: 'source state used in copySession: source',
  spread: 'source state used in moveHeld: source',
  mapMerge: 'source state used in restoreHeldReceiptsForHook: states',
  aliasedImport: 'reconcileSessionState called from sneaky',
  outsideSeams: 'readSourceStateForMove called from helper',
  undeclaredWrapperCaller: 'heldSessionStates called from moveHeld',
};
const POSITIVE_FIXTURES: Record<string, string> = {
  permittedUses: `export function copySession(target: SessionState) {
    const read = readSourceStateForMove('dir', 's', 'held');
    if (!read.ok) return;
    const source = read.state;
    const cursor = source.highWater;
    const hash = JSON.stringify(source);
    return [cursor, hash, reconcileSessionState(target, source).state];
  }`,
};
const fixtures = Object.fromEntries(Object.entries({ ...NEGATIVE_FIXTURES, ...POSITIVE_FIXTURES })
  .map(([name, body]) => [fixturePath(name), `${FIXTURE_IMPORTS}\n${body}\n`]));

const host = ts.createCompilerHost(options.options);
const realSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (name, language, ...rest) => fixtures[name] !== undefined
  ? ts.createSourceFile(name, fixtures[name]!, language, true)
  : realSourceFile(name, language, ...rest);
const realFileExists = host.fileExists.bind(host);
host.fileExists = (name) => fixtures[name] !== undefined || realFileExists(name);
const realReadFile = host.readFile.bind(host);
host.readFile = (name) => fixtures[name] ?? realReadFile(name);
const program = ts.createProgram([...sourcesUnder(SRC), ...Object.keys(fixtures)], options.options, host);
const checker = program.getTypeChecker();

/** The named function a node belongs to: its nearest enclosing declaration, past any callbacks inside it. */
function ownerOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) return at.name.getText();
    if (ts.isVariableDeclaration(at) && at.initializer !== undefined && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer)) &&
        ts.isIdentifier(at.name) && ts.isSourceFile(at.parent.parent.parent)) return at.name.text;
  }
  return '<module>';
}

/** The declaration a call resolves to, through import aliases. */
function calleeOf(call: ts.CallExpression): ts.Declaration | undefined {
  const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(target);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

const declares = (declaration: ts.Declaration | undefined, name: string, file?: string): boolean =>
  declaration !== undefined && (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration))
  && declaration.name?.getText() === name && (file === undefined || declaration.getSourceFile().fileName === file);

const isBranded = (type: ts.Type): boolean => checker.getPropertiesOfType(type).some((property) => property.getName().startsWith('__@sourceState'));

/** A source state, or an array of them, possibly undefined. */
function isSourceType(type: ts.Type): boolean {
  if (type.isUnion()) {
    const parts = type.types.filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
    return parts.length > 0 && parts.every(isSourceType);
  }
  if (checker.isArrayType(type)) return isSourceType(checker.getTypeArguments(type as ts.TypeReference)[0]!);
  return isBranded(type);
}

/** An identifier that names something rather than reading it. */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) ||
    ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    || (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent);
}

/** What a value flows into unchanged: through parentheses, a conditional's branches and `.flat()`. */
function useOf(node: ts.Node): ts.Node {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (ts.isParenthesizedExpression(parent) || (ts.isConditionalExpression(parent) && parent.condition !== at)) { at = parent; continue; }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === at && parent.name.text === 'flat' &&
        ts.isCallExpression(parent.parent) && parent.parent.expression === parent) { at = parent.parent; continue; }
    return at;
  }
}

const enclosingFunction = (node: ts.Node): ts.SignatureDeclaration | undefined => {
  for (let at = node.parent; at !== undefined; at = at.parent) if (ts.isFunctionLike(at)) return at;
  return undefined;
};
const returnedFrom = (node: ts.Node): ts.SignatureDeclaration | undefined => {
  const parent = node.parent;
  if (ts.isReturnStatement(parent)) return enclosingFunction(parent);
  if (ts.isArrowFunction(parent) && parent.body === node) return parent;
  return undefined;
};

/** Whether a source state at `node`, inside `owner`, is used in one of the enumerated ways. */
function permitted(node: ts.Expression, owner: string): boolean {
  const use = useOf(node);
  const parent = use.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === use && ts.isIdentifier(parent.name)) return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(use as ts.Expression)) {
    const callee = calleeOf(parent);
    return declares(callee, 'reconcileSessionState', RECONCILER) || declares(callee, 'pointersOf', path.join(MEMBER, 'session-state.ts'))
      || parent.expression.getText() === 'JSON.stringify';
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use && parent.name.text === 'highWater') {
    return !(ts.isBinaryExpression(parent.parent) && parent.parent.left === parent && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  }
  if (ts.isForOfStatement(parent) && parent.expression === use && ts.isCallExpression(use)) {
    return Object.entries(WRAPPERS).some(([wrapper, callers]) => declares(calleeOf(use), wrapper) && callers.includes(owner));
  }
  if (WRAPPERS[owner] !== undefined) {
    const returned = returnedFrom(use);
    if (returned !== undefined && ts.isFunctionDeclaration(returned) && returned.name?.text === owner) return true;
    if (ts.isArrayLiteralExpression(parent) && parent.elements.length === 1) {
      const callback = returnedFrom(useOf(parent));
      return callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isCallExpression(callback.parent);
    }
  }
  return false;
}

const at = (node: ts.Node): string => {
  const file = node.getSourceFile();
  return `${path.relative(REPO, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

/** Every call or use of a source state that breaks the seam contract, in `file`. */
function seamViolations(file: ts.SourceFile): string[] {
  if (file.fileName === RECONCILER) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = calleeOf(node);
      const owner = ownerOf(node);
      if (declares(callee, 'reconcileSessionState', RECONCILER) && !SEAMS.includes(owner)) found.push(`${at(node)} reconcileSessionState called from ${owner}`);
      if (declares(callee, 'readSourceStateForMove', RECONCILER) && ![...READERS, ...Object.keys(WRAPPERS)].includes(owner)) {
        found.push(`${at(node)} readSourceStateForMove called from ${owner}`);
      }
      for (const [wrapper, callers] of Object.entries(WRAPPERS)) {
        if (declares(callee, wrapper) && callee!.getSourceFile().fileName.startsWith(MEMBER) && !callers.includes(owner)) found.push(`${at(node)} ${wrapper} called from ${owner}`);
      }
    }
    const reads = (ts.isIdentifier(node) && !isDeclarationName(node)) || ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)
      || ts.isShorthandPropertyAssignment(node);
    if (reads && isSourceType(checker.getTypeAtLocation(ts.isShorthandPropertyAssignment(node) ? node.name : node))) {
      const owner = ownerOf(node);
      const scoped = SEAMS.includes(owner) || WRAPPERS[owner] !== undefined;
      if (!scoped || ts.isShorthandPropertyAssignment(node) || !permitted(node as ts.Expression, owner)) found.push(`${at(node)} source state used in ${owner}: ${node.getText()}`);
      if (ts.isShorthandPropertyAssignment(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Functions outside the reconciler that take two session states. */
function twoStateFunctions(file: ts.SourceFile): string[] {
  if (file.fileName === RECONCILER) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node)) {
      const states = node.parameters.filter((parameter) => {
        const type = checker.getTypeAtLocation(parameter);
        return ['SessionState', 'SourceSessionState'].includes(checker.typeToString(type));
      });
      const name = `${file.fileName}#${node.name?.getText() ?? ownerOf(node)}`;
      if (states.length >= 2 && TWO_STATE_FUNCTIONS[name] === undefined) found.push(`${at(node)} ${node.name?.getText() ?? '<anonymous>'} takes two session states`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const realFiles = (): ts.SourceFile[] => program.getSourceFiles().filter((file) => file.fileName.startsWith(`${SRC}${path.sep}`) && fixtures[file.fileName] === undefined);
const fixtureFile = (name: string): ts.SourceFile => program.getSourceFile(fixturePath(name))!;

describe('A. one reconciler', () => {
  it('has no function outside the reconciler that takes two session states', () => {
    expect(realFiles().flatMap(twoStateFunctions)).toEqual([]);
    expect(twoStateFunctions(fixtureFile('twoStates'))).toHaveLength(1);
  });

  it('calls the turn claim merge only from the reconciler', () => {
    const calls = realFiles().flatMap((file) => {
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && declares(calleeOf(node), 'mergedTurn') && file.fileName !== RECONCILER) found.push(at(node));
        ts.forEachChild(node, visit);
      };
      visit(file);
      return found;
    });
    expect(calls).toEqual([]);
  });
});

describe('B. reconciliation seams', () => {
  it('passes the real seams and their declared wrapper', () => {
    const files = realFiles();
    expect(files.map((file) => path.relative(SRC, file.fileName))).toEqual(expect.arrayContaining(['member/pending.ts', 'member/held.ts', 'member/spool-migration.ts']));
    expect(files.flatMap(seamViolations)).toEqual([]);
  });

  it('passes the enumerated uses of a source state inside a seam', () => {
    expect(seamViolations(fixtureFile('permittedUses'))).toEqual([]);
  });

  it.each(Object.entries(FLAGGED))('flags the %s fixture', (name, violation) => {
    expect(seamViolations(fixtureFile(name)).map((found) => found.replace(/^\S+ /, ''))).toContain(violation);
  });
});

import { upsertOccurrences, validateUpserts } from './server-upsert-inventory.js';
import { RECONCILED_UPSERTS } from './server-upsert-manifest.js';

describe('server reconciliation upsert contract', () => {
  it('declares every conflict-update occurrence, including fragments and repeated tables', () => {
    const root = path.join(REPO, 'packages/myco-server/src');
    const occurrences = fs.readdirSync(root, { recursive: true })
      .map(String).filter(file => file.endsWith('.ts'))
      .flatMap(file => upsertOccurrences(file, fs.readFileSync(path.join(root, file), 'utf8')));
    expect(validateUpserts(occurrences, RECONCILED_UPSERTS)).toEqual([]);
  });

  it('detects extra occurrences in an existing owner, a new owner and unresolved SQL', () => {
    const sql = 'INSERT INTO records(id) VALUES (?) ON CONFLICT(id) DO UPDATE SET id=excluded.id';
    const source = `function write() { db.prepare(\`${sql}\`); }`;
    const manifest = { 'fixture.ts#write': [{ tables: ['records'], order: 'writer-revision' as const }] };
    expect(validateUpserts(upsertOccurrences('fixture.ts', source), manifest)).toEqual([]);
    for (const mutant of [
      source.replace('db.prepare', `db.prepare(\`${sql}\`); db.prepare`),
      source + `function other() { db.prepare(\`${sql}\`); }`,
      source.replace('INSERT INTO records', 'INSERT INTO other_records'),
    ]) expect(validateUpserts(upsertOccurrences('fixture.ts', mutant), manifest).length).toBeGreaterThan(0);
    const fragment = upsertOccurrences('fragment.ts', 'const SQL = "ON CONFLICT(id) DO UPDATE SET id=excluded.id";');
    expect(validateUpserts(fragment, {} ).length).toBeGreaterThan(0);
    expect(validateUpserts(fragment, { 'fragment.ts#<module>': [{ tables: ['records'], order: 'keyed-immutable' }] })).toEqual([]);
  });
});
