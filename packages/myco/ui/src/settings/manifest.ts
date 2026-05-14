export type SettingScope = 'project' | 'grove' | 'machine';
export type SettingKind = 'toggle' | 'select' | 'number' | 'secret' | 'list' | 'text';

export interface SettingField {
  /** Dotted path matching the Zod schema. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Real backend scope. */
  scope: SettingScope;
  /** Control kind. */
  kind: SettingKind;
  /** Category label for the TOC rail. */
  category: string;
  /** Lucide icon name for the group header. */
  icon: string;
  /** Optional helper text. */
  note?: string;
  /** Read-only display (derived values). */
  readonly?: boolean;
  /** Options for `kind: 'select'`. */
  options?: readonly string[];
  /** Min/max for `kind: 'number'`. */
  min?: number;
  max?: number;
}

export interface SettingGroup {
  /** URL anchor + dedupe key. */
  id: string;
  /** Group label shown in the card header. */
  label: string;
  /** Short description. */
  desc: string;
  /** Top-level category (matches `SettingField.category`). */
  category: string;
  /** Group-level Lucide icon. */
  icon: string;
  fields: SettingField[];
}

export const SETTINGS_GROUPS: readonly SettingGroup[] = [];
