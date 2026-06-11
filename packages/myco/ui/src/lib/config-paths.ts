import type { MycoConfig } from '../hooks/use-config';

/**
 * Dotted-path type utilities for MycoConfig.
 *
 * `DotPaths<T>` is the union of all valid dotted paths into `T`. Used to
 * constrain the `path` prop on `<ScopedField>` and the `path` argument on
 * `useScopedConfig().setField()` / `resetField()` so a
 * typo at the call site is a compile error.
 *
 * `PathValue<T, P>` walks a dotted path and yields the leaf type — letting
 * `<ScopedField>` infer the value type from the path so callers don't have
 * to repeat it via the explicit `<T>` generic.
 *
 * `ConfigPath = DotPaths<MycoConfig> | (string & {})`
 *   The `(string & {})` intersection is the standard TypeScript trick for
 *   "literal autocomplete + arbitrary string": IDE suggests the known paths
 *   (e.g. 'daemon.log_level'), but the dynamic notification-domain paths
 *   (`notifications.domains.<id>.enabled`) and any future records still
 *   compile. Without the escape hatch the dynamic-key paths would be
 *   compile errors.
 */

type Primitive = string | number | boolean | null | undefined;

// Recursive walk: for each key K of T, emit `K` plus (if T[K] is an object)
// every dotted continuation `K.<sub>`. Bottoms out at primitives and arrays.
type DotPathsOf<T, Depth extends number = 5> =
  Depth extends 0
    ? never
    : T extends Primitive
      ? never
      : T extends ReadonlyArray<unknown>
        ? never
        : {
            [K in keyof T & string]:
              | K
              | (T[K] extends object
                  ? T[K] extends ReadonlyArray<unknown>
                    ? never
                    : `${K}.${DotPathsOf<NonNullable<T[K]>, Decrement<Depth>>}`
                  : never);
          }[keyof T & string];

// TS template-literal recursion has no native arithmetic; use a small lookup.
type Decrement<N extends number> =
  N extends 5 ? 4 : N extends 4 ? 3 : N extends 3 ? 2 : N extends 2 ? 1 : N extends 1 ? 0 : 0;

export type DotPaths<T> = DotPathsOf<T>;

/** Walk a dotted path through T and produce the leaf value type. */
export type PathValue<T, P extends string> =
  P extends `${infer K}.${infer R}`
    ? K extends keyof T
      ? PathValue<NonNullable<T[K]>, R>
      : unknown
    : P extends keyof T
      ? T[P]
      : unknown;

/**
 * Path prop type for ScopedField and useScopedConfig writes. Accepts the
 * known static union from `DotPaths<MycoConfig>` (autocompletes in editors)
 * AND any string (so dynamic paths like `notifications.domains.<id>.enabled`
 * still compile).
 */
export type ConfigPath = DotPaths<MycoConfig> | (string & {});

/**
 * Value type for a known config path; falls back to `unknown` for dynamic
 * paths the type system can't statically resolve.
 */
export type ConfigValueAt<P extends string> = PathValue<MycoConfig, P>;
