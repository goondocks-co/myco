/**
 * Shared base shape for the manifest-driven field control primitives in
 * this directory. Each kind-specific control narrows `value`/`onChange`
 * to its expected type and adds kind-specific extras.
 *
 * The label/scope-badge/note row sits OUTSIDE the control — the unified
 * Settings page composes that wrapper around these primitives.
 */
export interface BaseFieldControlProps<TValue = unknown, TNext = TValue> {
  /** Stable id for the input — must match the label's htmlFor. */
  id: string;
  /** Current value (kind-specific). */
  value: TValue;
  /** Called when the user commits a change. */
  onChange: (next: TNext) => void;
  /** Disable input (loading or in-flight write). */
  disabled?: boolean;
  /** Render as read-only display when truthy. */
  readonly?: boolean;
}
