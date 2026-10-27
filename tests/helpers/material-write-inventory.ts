import ts from 'typescript-v6';
import { preparationOwner } from './statement-recorder.js';
import { materialWriteTargets, DYNAMIC_MATERIAL_TARGET } from './material-write-classification.js';

/** Literal and generated material targets retain their exact expression and owning definition. */
export function materialWriteInventory(file: string, source: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
    rows: { file: string; owner: string; expression: string; table: string; operation: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => DYNAMIC_MATERIAL_TARGET + span.literal.text).join('')
        : node.text;
      for (const target of materialWriteTargets(text, true))
        rows.push({ file, owner: preparationOwner(ts, node, tree), expression: node.getText(tree), ...target });
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
}


type MaterialWrite = ReturnType<typeof materialWriteInventory>[number];

export function materialWriteAnchor(row: MaterialWrite): string {
  return JSON.stringify([row.file, row.owner, row.expression, row.table, row.operation]);
}

export function canonicalMaterialWrites<T extends MaterialWrite>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = materialWriteAnchor(a), right = materialWriteAnchor(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
