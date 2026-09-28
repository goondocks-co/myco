/**
 * Schema v52: whether a credential rotates, recorded by its issuer at mint (#1420).
 *
 * `member_credentials.rotates` is 1 for a credential that asks `/tokens/refresh` for its successor — every
 * row written before this step, and every credential a join mints — and 0 for one the issuer minted to be
 * read from a runtime's environment: an orchestrator hands the same token to every sandbox it starts, so no
 * holder may rotate it, and it is renewed by minting another. The value is set by the insert that mints the
 * row and never updated; a successor is only ever minted from a row whose value is 1, and only a row whose value is 1
 * rotates. The table carries no CHECK (#1416), so the value is held by its one writer, `memberTokenInsert`.
 */
export const V52_STATEMENTS: readonly string[] = [
  `ALTER TABLE member_credentials ADD COLUMN rotates INTEGER NOT NULL DEFAULT 1`,
];
