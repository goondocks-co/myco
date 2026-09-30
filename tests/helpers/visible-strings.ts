/**
 * The words a dashboard source file can put in front of a reader: JSX text,
 * and every string or template literal that reads as prose, with each one's
 * line. Comments, identifiers, class names, import paths, type-level literals,
 * object keys, API paths and single code-like tokens (`lease_expired`,
 * `harness-runtime`) are left out, since none of them reaches the page as
 * words.
 */
import ts from 'typescript-v6';

export interface VisibleString {
  line: number;
  text: string;
}

/** Calls whose string arguments are class names, not words. */
const CLASS_CALLS = new Set(['cn', 'cva', 'clsx', 'twMerge', 'buttonVariants']);
/** JSX attributes whose values are never shown as words. */
const HIDDEN_ATTRIBUTES = /^(className|key|id|to|href|src|type|role|name|htmlFor|value|defaultValue|target|rel|method|action|download|data-[\w-]+|aria-(?!label$|description$|valuetext$|roledescription$)[\w-]+|autoComplete|inputMode|pattern|dateTime|form|lang|dir|side|align|variant|size|tone|as)$/;

/** Whether a literal reads as words: a letter-led run with a space in it, or one capitalised word. */
function readsAsWords(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || !/\p{L}/u.test(trimmed)) return false;
  // A path, a query, an id or key: `/api/...`, `?tab=`, `run_…`, `lease_expired`, `harness-runtime`, `t-small`.
  if (/^[/?#.]/.test(trimmed)) return false;
  if (!/\s/.test(trimmed)) return /^\p{Lu}[\p{Ll}’']+[.:!?]?$/u.test(trimmed);
  return true;
}

function isClassNameContext(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isJsxAttribute(at)) return HIDDEN_ATTRIBUTES.test(at.name.getText());
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && CLASS_CALLS.has(at.expression.text)) return true;
    if (ts.isPropertyAssignment(at) && /^(className|class)$/.test(at.name.getText())) return true;
    if (ts.isVariableDeclaration(at) || ts.isFunctionLike(at) || ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at)) return false;
  }
  return false;
}

function isCodeContext(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) || ts.isEnumMember(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isBinaryExpression(parent) && /^(===|!==|==|!=|in)$/.test(parent.operatorToken.getText())) return true;
  if (ts.isCaseClause(parent)) return true;
  // A regular expression's source, and the argument a string method matches against, are patterns, not words.
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
    && /^(includes|startsWith|endsWith|test|match|replace|split|getAttribute|setAttribute|querySelector|closest|get|has|set|delete|append)$/.test(parent.expression.name.text)) return true;
  return false;
}

/** Every string a reader could see in one source file, with its line. */
export function visibleStrings(fileName: string, source: string): VisibleString[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: VisibleString[] = [];
  const add = (node: ts.Node, text: string) => {
    if (readsAsWords(text)) out.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: text.trim().replace(/\s+/g, ' ') });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      add(node, node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isCodeContext(node) && !isClassNameContext(node)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isCodeContext(node) && !isClassNameContext(node)) {
        // The words around the substitutions, joined so a sentence split by `${…}` still reads as one.
        add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' … '));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
