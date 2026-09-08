/**
 * The native artifacts this target's storage needs, as resolved paths.
 *
 * Two of them, and the deployment supplies both or neither:
 *
 *   - an extension-enabled `libsqlite3`, registered before the first connection
 *     opens; the runtime's built-in library loads no extension;
 *   - the `vec0` extension itself, loaded into each connection that queries
 *     vectors.
 *
 * A deployment that supplies them reads them from wherever it holds them. One
 * that supplies neither falls back to locating them on the host, which is what
 * a checkout and a container image do.
 *
 * Paths, not handles: this is `platform/bun/`, the one place the self-hosted
 * server names a filesystem path.
 */

export interface NativeSqlite {
  /** An extension-enabled `libsqlite3`, or null to locate one on the host. */
  library: string | null;
  /** The `vec0` extension, or null to locate it on the host. */
  vec0: string | null;
}
