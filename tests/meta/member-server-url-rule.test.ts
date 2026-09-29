/**
 * Meta gate: a member admits a server URL by one rule, `member/server-url.ts`.
 *
 *   1. No member-side module outside the rule tests a URL's scheme. The scan
 *      reads each module's syntax tree, so the shape of the test does not
 *      matter: a `.protocol` read, a scheme string compared or searched for, a
 *      regular expression naming http, or one built from a string.
 *   2. Each function that admits a member's server URL calls the rule,
 *      through whatever local name its import gives it.
 *   3. The CLI entry keeps loopback dials off a configured proxy before it
 *      does anything else.
 *
 * Static source scan.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';

const SRC = fileURLToPath(new URL('../../packages/myco/src/', import.meta.url));

/** The member-side trees: what a hook, a member verb, a bridge, the installer or the worker runner runs. */
const MEMBER_TREES = ['member', 'cli', 'hooks', 'mcp', 'symbionts', 'runner', 'install'] as const;

const RULE = 'member/server-url.ts';
const RULE_EXPORTS = { admit: 'admitMemberServerUrl', bypass: 'keepLoopbackOffProxy' } as const;
/** The modules the rule's exports are imported from. */
const RULE_MODULE = /(^|\/)(server-url|loopback-proxy)\.js$/;

/** Scheme tests that admit no member server URL, each with why. */
const ADMITTED: Record<string, string> = {
  'member/diagnostics.ts': 'strips userinfo, query and fragment from a URL it exports in a support bundle; it admits nothing',
};

/** The functions that admit a member's server URL, and so must call the rule. */
const ADMITTERS: ReadonlyArray<{ file: string; fn: string; admits: string }> = [
  { file: 'member/credential.ts', fn: 'resolveCredential', admits: 'a registry entry' },
  { file: 'member/credential.ts', fn: 'joinCodeCredential', admits: 'the membership a join code redeemed' },
  { file: 'member/credential.ts', fn: 'envCredential', admits: 'MYCO_SERVER_URL' },
  { file: 'member/join-code.ts', fn: 'parseJoinCode', admits: '`myco login` and MYCO_JOIN_CODE' },
  { file: 'cli/member.ts', fn: 'runJoin', admits: '`myco member join`' },
  { file: 'cli/member.ts', fn: 'runMcpHeaders', admits: 'the Deployment membership `mcp-headers` serves' },
  { file: 'symbionts/installer.ts', fn: 'deploymentNamed', admits: 'the Deployment a member MCP entry names' },
];

/** Methods whose string argument tests a URL for its scheme. */
const SEARCHING_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'test', 'replace', 'split', 'localeCompare']);
const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });

const parse = (name: string, text: string): ts.SourceFile => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const isStringy = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** A string that is, or begins with, a URL scheme: `https:`, `http://…`. */
const SCHEME = /^https?:/i;

/**
 * Whether `node` is being tested: compared, searched for or searched in, or
 * switched on. A value that is only built, stored or passed along tests nothing.
 */
function tested(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent) || (ts.isSwitchStatement(parent) && parent.expression === node)) return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)
    && ts.isPropertyAccessExpression(parent.expression) && SEARCHING_METHODS.has(parent.expression.name.text)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && SEARCHING_METHODS.has(parent.name.text)) return true;
  // An element of a list that is itself searched: `['http:', 'https:'].includes(…)`.
  return ts.isArrayLiteralExpression(parent) && tested(parent);
}

/** Every scheme test in a module, as `line: source text`. */
function schemeTests(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const flag = (node: ts.Node): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(`${line}: ${node.getText(source).replace(/\s+/g, ' ').slice(0, 120)}`);
  };
  const visit = (node: ts.Node): void => {
    // A URL's scheme, read and then tested.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'protocol' && tested(node)) flag(node);
    else if (ts.isElementAccessExpression(node) && isStringy(node.argumentExpression) && node.argumentExpression.text === 'protocol' && tested(node)) flag(node);
    // Any regular expression that names http, whatever it is used for.
    else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && /http/i.test(node.getText(source))) flag(node);
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp'
      && (node.arguments ?? []).some((a) => isStringy(a) && /http/i.test(a.text))) flag(node);
    // A scheme string that something is tested against.
    else if (isStringy(node) && SCHEME.test(node.text) && tested(node)) flag(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The local names this module gives an export of the rule, through any alias. */
function localNamesOf(source: ts.SourceFile, exported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!RULE_MODULE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === exported) names.add(element.name.text);
    }
  }
  return names;
}

/** The body of the function, method or function-valued variable named `fn`, or null. */
function functionNamed(source: ts.SourceFile, fn: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && node.name.getText(source) === fn) found = node;
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fn && node.initializer !== undefined) found = node.initializer;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether `scope` calls one of `names`. */
function calls(scope: ts.Node, names: Set<string>): boolean {
  let called = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) called = true;
    if (!called) ts.forEachChild(node, visit);
  };
  visit(scope);
  return called;
}

/** Whether `fn` in `source` calls the rule's export under the name its import gives it. */
function callsRule(source: ts.SourceFile, fn: string, exported: string): boolean {
  const scope = functionNamed(source, fn);
  return scope !== null && calls(scope, localNamesOf(source, exported));
}

const read = (rel: string): ts.SourceFile => parse(rel, readFileSync(join(SRC, rel), 'utf8'));

describe('the member server URL rule', () => {
  it('recognises every shape of scheme test, and passes over what only names a URL', () => {
    const planted = [
      "if (new URL(v).protocol === 'https:') return true;",
      "if (url['protocol'] !== 'http:') return null;",
      "if (url.protocol.startsWith('http')) ok();",
      "return ['http:', 'https:'].includes(url.protocol);",
      "if (!value.startsWith('https://')) refuse();",
      "if (value.indexOf('http://') === 0) refuse();",
      "if ('https:' === scheme) ok();",
      "switch (scheme) { case 'https:': ok(); }",
      'const ok = /^https:\\/\\//.test(value);',
      'if (/^http:|^https:/.test(membership.serverUrl)) ok();',
      "const ok = new RegExp('^https?:').test(value);",
    ];
    for (const line of planted) expect({ line, found: schemeTests(parse('planted.ts', line)).length > 0 }).toEqual({ line, found: true });
    const innocent = [
      "const example = 'https://myco.example.com/join#<key>';",
      "console.log(`myco login https://myco.example.com/join#${key}`);",
      "// a comment naming url.protocol === 'https:' tests nothing",
      "const u = new URL('/mcp', base);",
      "this.protocol = opts.protocol; headers[PROTOCOL] = String(this.protocol);",
      "if (entry.type === 'http') return 'http';",
    ];
    for (const line of innocent) expect({ line, found: schemeTests(parse('innocent.ts', line)) }).toEqual({ line, found: [] });
  });

  it('is the only scheme test in member-side code', () => {
    const offenders: string[] = [];
    for (const tree of MEMBER_TREES) {
      for (const file of allFiles(join(SRC, tree)).filter((f) => f.endsWith('.ts'))) {
        const rel = relative(SRC, file);
        if (rel === RULE || rel in ADMITTED) continue;
        for (const hit of schemeTests(parse(rel, readFileSync(file, 'utf8')))) offenders.push(`${rel}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the rule through an aliased import, and only through an import of the rule', () => {
    const aliased = parse('aliased.ts', "import { admitMemberServerUrl as acceptable } from './server-url.js';\nfunction runJoin(u: string) { return acceptable(u); }");
    expect(callsRule(aliased, 'runJoin', RULE_EXPORTS.admit)).toBe(true);
    const shadowed = parse('shadowed.ts', "import { admitMemberServerUrl as acceptable } from './other.js';\nfunction runJoin(u: string) { return acceptable(u); }");
    expect(callsRule(shadowed, 'runJoin', RULE_EXPORTS.admit)).toBe(false);
    const elsewhere = parse('elsewhere.ts', "import { admitMemberServerUrl } from './server-url.js';\nfunction other(u: string) { return admitMemberServerUrl(u); }\nfunction runJoin(u: string) { return u; }");
    expect(callsRule(elsewhere, 'runJoin', RULE_EXPORTS.admit)).toBe(false);
  });

  it('is called by every function that admits a member server URL', () => {
    const missing = ADMITTERS.filter(({ file, fn }) => !callsRule(read(file), fn, RULE_EXPORTS.admit)).map(({ file, fn, admits }) => `${file} ${fn} (${admits})`);
    expect(missing).toEqual([]);
  });

  it('keeps loopback off a proxy at the CLI entry', () => {
    expect(callsRule(read('cli.ts'), 'main', RULE_EXPORTS.bypass)).toBe(true);
  });

  it('admits only files that still exist and still test a scheme', () => {
    for (const rel of Object.keys(ADMITTED)) expect({ rel, tests: schemeTests(read(rel)).length > 0 }).toEqual({ rel, tests: true });
  });
});
