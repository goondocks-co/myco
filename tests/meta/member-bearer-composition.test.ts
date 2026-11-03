/** Gate: member calls compose protocol and identity headers through the shared owner. */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** The one module that composes a member request's headers. */
const MEMBER_COMPOSER = 'myco-shared/src/member-protocol.ts';
const MEMBER_COMPATIBILITY = 'member/constants.ts';

/** Calls to APIs outside Myco, with what each talks to. Adding one is a reviewed act. */
const FOREIGN: Readonly<Record<string, string>> = {
  'server/backup-credential.ts': 'the Cloudflare D1 export API',
  'server/cloudflare.ts': 'the Cloudflare R2 object API',
  'upgrade/release-assets.ts': 'the GitHub release assets API',
};

function composesBearer(text: string): boolean {
  const source = ts.createSourceFile('headers.ts', text, ts.ScriptTarget.Latest, true);
  const header = (node: ts.Node): boolean => /^(?:authorization|['"]authorization['"])$/i.test(node.getText(source));
  const bearer = (node: ts.Node): boolean => {
    if (ts.isStringLiteralLike(node)) return /^Bearer\s/i.test(node.text);
    if (ts.isTemplateExpression(node)) return /^Bearer\s/i.test(node.head.text);
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && bearer(node.left);
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && header(node.name) && bearer(node.initializer)) found = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const key = ts.isPropertyAccessExpression(node.left) ? node.left.name : ts.isElementAccessExpression(node.left) ? node.left.argumentExpression : undefined;
      if (key && header(key) && bearer(node.right)) found = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['set', 'append'].includes(node.expression.name.text)
      && node.arguments[0] && header(node.arguments[0]) && node.arguments[1] && bearer(node.arguments[1])) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false });

/** The module's code without its comments, so prose naming a header is not a composition. */
function codeOf(file: string): string {
  return transpiler.transformSync(fs.readFileSync(file, 'utf-8'));
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const key = (file: string): string => path.relative(SRC_ROOT, file).split(path.sep).join('/');

interface Composer {
  module: string;
  /** Which protocol the file declares alongside the bearer, or null when it declares none. */
  kind: 'member-composer' | 'foreign' | 'undeclared';
}

/** Every header composer the composer module exports, read from its own source. */
function composerNames(): string[] {
  const code = codeOf(path.resolve(REPO_ROOT, 'packages', MEMBER_COMPOSER));
  return [...code.matchAll(/export function ([A-Za-z][A-Za-z0-9]*Headers)\s*\(/g)].map((m) => m[1]!);
}

function composers(): Composer[] {
  const out: Composer[] = [];
  for (const file of [...listTs(SRC_ROOT), path.join(REPO_ROOT, 'packages/myco-shared/src/member-protocol.ts')]) {
    const code = codeOf(file);
    if (!composesBearer(code)) continue;
    const module = file.endsWith('myco-shared/src/member-protocol.ts') ? MEMBER_COMPOSER : key(file);
    out.push({
      module,
      kind: module === MEMBER_COMPOSER ? 'member-composer'
        : module in FOREIGN ? 'foreign'
            : 'undeclared',
    });
  }
  return out;
}

describe('one composer for a member request\'s headers', () => {
  it('admits no bearer header that declares neither protocol nor a foreign API', () => {
    const found = composers();
    const undeclared = found.filter((c) => c.kind === 'undeclared').map((c) => c.module);
    if (undeclared.length > 0) {
      throw new Error(
        'these modules compose an `authorization: Bearer` header without declaring which protocol it speaks.\n'
        + 'A Deployment refuses a member request carrying no protocol header with 409 on every route, so such a call reaches nothing:\n'
        + `${undeclared.map((m) => `  ${m}`).join('\n')}\n`
        + `Compose member headers through memberHeaders() in ${MEMBER_COMPOSER}, or name the foreign API in FOREIGN.`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  it('finds the member composer, and exactly one of it', () => {
    // An empty or collapsed scan passes the gate above trivially. This holds that
    // the scan still sees the composer it exists to protect, and that the worker
    // and MCP call sites no longer write their own.
    const found = composers();
    expect(found.filter((c) => c.kind === 'member-composer').map((c) => c.module)).toEqual([MEMBER_COMPOSER]);
    expect(codeOf(path.join(SRC_ROOT, MEMBER_COMPATIBILITY))).toContain('@goondocks/myco-shared/member-protocol');
    for (const module of ['runner/loop.ts', 'runner/mcp-config.ts', 'mcp/deployment-upstream.ts', 'member/transport.ts']) {
      expect({ module, composes: found.some((c) => c.module === module) }).toEqual({ module, composes: false });
    }
  });

  it('every member-side call to a Deployment routes its headers through a composer the composer module exports', () => {
    // The composers are read OUT of the composer module rather than named here:
    // a gate that hard-codes one name is a second copy of it, and passes a call
    // site that stopped using the composers while it still spells that one name.
    const composers = composerNames();
    expect(composers.length).toBeGreaterThan(1);
    for (const module of ['runner/loop.ts', 'runner/mcp-config.ts', 'mcp/deployment-upstream.ts', 'member/transport.ts']) {
      const code = codeOf(path.join(SRC_ROOT, module));
      const used = composers.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
      expect({ module, routed: used.length > 0 }).toEqual({ module, routed: true });
    }
  });

  it('reads code, not comments, and sees both the property and the assignment form', () => {
    expect(composesBearer('const headers = { authorization: `Bearer ${t}`, a: 1 }')).toBe(true);
    expect(composesBearer('headers.authorization = `Bearer ${t}`;')).toBe(true);
    expect(composesBearer("headers['Authorization'] = `Bearer ${t}`;")).toBe(true);
    expect(composesBearer('headers.set("Authorization", "Bearer " + token);')).toBe(true);
    expect(composesBearer('headers.append("authorization", `Bearer ${token}`);')).toBe(true);
    expect(composesBearer('const parsed = parseBearer(headers.authorization);')).toBe(false);
    expect(composesBearer('// authorization: `Bearer x`\nexport const a = 1;')).toBe(false);
  });

  it('names every foreign API it exempts, so an exemption cannot be an empty entry', () => {
    for (const [module, talksTo] of Object.entries(FOREIGN)) {
      expect({ module, exists: fs.existsSync(path.join(SRC_ROOT, module)), named: talksTo.length > 0 })
        .toEqual({ module, exists: true, named: true });
    }
  });
});
