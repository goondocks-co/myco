export const EXEMPT_DIRECTORY: string;
export const PRODUCT_ROOT: RegExp;

export function isTestFile(file: string): boolean;
export function isProductFile(file: string): boolean;
export function checkedFile(file: string): boolean;

export interface StatementFacts {
  productTables: () => ReadonlySet<string>;
  productFiles: ReadonlySet<string>;
}

export interface StatementFinding {
  rule: string;
  message: string;
}

export function statementFindings(
  statement: { file: string; line?: number; code: string; text: string },
  facts: StatementFacts,
): StatementFinding[];
