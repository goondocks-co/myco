/**
 * Schema v53: who issued a GitHub link key, which decides when it may bind (#1448).
 *
 * `identity_link_authorities.issued_by` is NULL for a key a member's own credential minted, and for the first
 * administrator a self-hosted setup mints: such a key binds only while the Deployment has no live admin with a
 * GitHub account linked, so the first sign-in on a fresh Deployment is the only one a member credential can
 * choose. A key an admin created from the dashboard names that admin here, and binds only while that
 * member is still a live, linked admin. Every row written before this step is NULL, so a key minted before the
 * step is held to the first rule. The column is set by the insert that mints the row and never updated; it
 * carries no reference and no index, as every read of it goes through the row's own key hash.
 */
export const V53_STATEMENTS: readonly string[] = [
  `ALTER TABLE identity_link_authorities ADD COLUMN issued_by TEXT`,
];
