import ts from 'typescript-v6';

export type UpsertRule = 'event-rank' | 'writer-revision' | 'reporter-stamp' | 'keyed-immutable' | 'monotonic';
export interface UpsertDeclaration { tables: string[]; order: UpsertRule }
export interface UpsertOccurrence { owner: string; table: string | null }

/** Inventory literal conflict updates by their nearest named function or module fragment. */
export function upsertOccurrences(file: string, source: string): UpsertOccurrence[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const occurrences: UpsertOccurrence[] = [];
  const ownerOf = (node: ts.Node): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
        if (parent.name) return parent.name.getText(parsed);
      }
      if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText(parsed);
    }
    return '<module>';
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
      const text = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => span.literal.text).join('') : node.text;
      const updates = [...text.matchAll(/\bDO\s+UPDATE\b/gi)];
      if (updates.length > 0) {
        const table = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-zA-Z_][a-zA-Z_0-9]*)\b/i.exec(text)?.[1] ?? null;
        for (const _ of updates) occurrences.push({ owner: `${file}#${ownerOf(node)}`, table });
      }
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return occurrences;
}

export function validateUpserts(occurrences: UpsertOccurrence[], manifest: Record<string, UpsertDeclaration[]>): string[] {
  const groups = new Map<string, UpsertOccurrence[]>();
  for (const occurrence of occurrences) groups.set(occurrence.owner, [...groups.get(occurrence.owner) ?? [], occurrence]);
  const errors: string[] = [];
  for (const owner of new Set([...groups.keys(), ...Object.keys(manifest)])) {
    const sites = groups.get(owner) ?? [];
    const declarations = manifest[owner] ?? [];
    if (sites.length !== declarations.length) errors.push(`${owner}: ${sites.length} occurrences, ${declarations.length} declarations`);
    sites.forEach((site, i) => {
      const declared = declarations[i];
      if (declared === undefined || declared.tables.length === 0 || declared.tables.some(t => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(t))) errors.push(`${owner}[${i}]: unresolved tables`);
      else if (site.table !== null && !declared.tables.includes(site.table)) errors.push(`${owner}[${i}]: undeclared table ${site.table}`);
    });
  }
  return errors;
}
