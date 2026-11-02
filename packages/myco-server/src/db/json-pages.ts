/** JSON binds leave room below the store's string and row limits. */
export const STATEMENT_JSON_BYTES = 750_000;
export function jsonPages<T>(rows: readonly T[]): T[][] {
  const pages: T[][] = [];
  let page: T[] = [], bytes = 2;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (size > STATEMENT_JSON_BYTES) throw new Error('document_statistics_row_too_large');
    if (bytes + size > STATEMENT_JSON_BYTES) { pages.push(page); page = []; bytes = 2; }
    page.push(row); bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

