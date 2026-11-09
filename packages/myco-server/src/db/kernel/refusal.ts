declare const refusalBrand: unique symbol;

/** A named reason an in-batch assertion stops its whole batch; only `refusalCode` produces one. */
export type RefusalCode<Code extends string = string> = Code & { readonly [refusalBrand]: true };

const CODE_FORM = /^[a-z][a-z0-9_]*$/;
const MAX_CAUSE_DEPTH = 8;
/** Every store names the rejected path; older SQLite words the same report as `JSON path error near '[code]'`. */
const REPORTED = /JSON path[^']*'\$?\[([a-z][a-z0-9_]*)(?::([^\]']*))?\]'/;

/** Families export these beside the assertion that raises them. */
export function refusalCode<const Code extends string>(code: Code): RefusalCode<Code> {
  if (!CODE_FORM.test(code)) throw new Error(`refusal code must match ${CODE_FORM}: ${code}`);
  return code as RefusalCode<Code>;
}

/** The expression that stops a statement and names the refusal; a `detail` of NULL still stops it, and is reported without `]` or `'`. */
export function abortSql(refusal: RefusalCode, detail?: string): string {
  return detail === undefined ? `json_extract('[]','$[${refusal}]')`
    : `json_extract('[]','$[${refusal}:' || replace(replace(COALESCE((${detail}),''),']',''),'''','') || ']')`;
}

/** What the assertion reported alongside `code`, `''` when it reported nothing more, or null when `error` is not that refusal. */
export function refusalDetail(error: unknown, code: RefusalCode): string | null {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const reported = REPORTED.exec(current.message);
    if (reported?.[1] === code) return reported[2] ?? '';
    current = current.cause;
  }
  return null;
}

/** The one way to recognise a refusal, on any store and through any wrapper that keeps `cause`. */
export const refused = (error: unknown, code: RefusalCode): boolean => refusalDetail(error, code) !== null;
