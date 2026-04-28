import ts from 'typescript';
import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

const TOP_COMMENT_MAX = 240;

/**
 * Mechanical parser for `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts` files.
 *
 * Walks a non-typechecked SourceFile to extract named exports, import module
 * specifiers, and the leading JSDoc/banner comment. Defensive against parse
 * errors: any throw in the AST path falls back to a minimal result with a
 * first-line topComment so the row is still useful.
 */
export const typescriptParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  try {
    return parse(input);
  } catch {
    return {
      language: 'typescript',
      exports: [],
      imports: [],
      topComment: firstNonEmptyLine(input.content),
    };
  }
};

function parse(input: CanopyParserInput): CanopyParserOutput {
  const scriptKind = pickScriptKind(input.path);
  const source = ts.createSourceFile(
    input.path,
    input.content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const exports = new Set<string>();
  const imports = new Set<string>();

  for (const stmt of source.statements) {
    collectExports(stmt, exports);
    collectImports(stmt, imports);
  }

  return {
    language: 'typescript',
    exports: [...exports],
    imports: [...imports],
    topComment: extractTopComment(input.content) ?? firstNonEmptyLine(input.content),
  };
}

function pickScriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  // Cast to any-shaped accessor to avoid the ts.canHaveModifiers type narrowing
  // on the broad ts.Statement union; the property is read defensively.
  const modifiers = (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function collectExports(stmt: ts.Statement, out: Set<string>): void {
  // export { a, b } from '...'  /  export { a, b }
  if (ts.isExportDeclaration(stmt)) {
    if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) out.add(el.name.text);
    } else if (stmt.moduleSpecifier && !stmt.exportClause) {
      // export * from '...'  -- record the module as the export marker
      out.add(`* from ${stripQuotes(stmt.moduleSpecifier.getText())}`);
    }
    return;
  }

  // export = ...  /  export default ...
  if (ts.isExportAssignment(stmt)) {
    out.add(stmt.isExportEquals ? 'export=' : 'default');
    return;
  }

  if (!hasExportModifier(stmt)) return;

  if (ts.isFunctionDeclaration(stmt) && stmt.name) out.add(stmt.name.text);
  else if (ts.isClassDeclaration(stmt) && stmt.name) out.add(stmt.name.text);
  else if (ts.isInterfaceDeclaration(stmt)) out.add(stmt.name.text);
  else if (ts.isTypeAliasDeclaration(stmt)) out.add(stmt.name.text);
  else if (ts.isEnumDeclaration(stmt)) out.add(stmt.name.text);
  else if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
    out.add(stmt.name.text);
  } else if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      collectBindingNames(decl.name, out);
    }
  }
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    collectBindingNames(el.name, out);
  }
}

function collectImports(stmt: ts.Statement, out: Set<string>): void {
  if (ts.isImportDeclaration(stmt)) {
    out.add(stripQuotes(stmt.moduleSpecifier.getText()));
    return;
  }
  // import x = require('...')
  if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
    out.add(stripQuotes(stmt.moduleReference.expression.getText()));
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function extractTopComment(content: string): string | null {
  const ranges = ts.getLeadingCommentRanges(content, 0);
  if (!ranges || ranges.length === 0) return null;
  // Block comments stand alone; consecutive line comments form a banner so
  // gather the run of SingleLineCommentTrivia entries that touch the start.
  const first = ranges[0];
  if (first.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    return cleanComment(content.slice(first.pos, first.end));
  }
  const lineGroup: ts.CommentRange[] = [];
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break;
    lineGroup.push(r);
  }
  const raw = lineGroup.map((r) => content.slice(r.pos, r.end)).join('\n');
  return cleanComment(raw);
}

function cleanComment(raw: string): string {
  let s = raw;
  if (s.startsWith('/**') || s.startsWith('/*')) {
    s = s.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
  } else if (s.startsWith('//')) {
    s = s
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\/\/\s?/, ''))
      .join(' ');
  }
  s = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, TOP_COMMENT_MAX);
}

function firstNonEmptyLine(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed.slice(0, TOP_COMMENT_MAX);
  }
  return null;
}
