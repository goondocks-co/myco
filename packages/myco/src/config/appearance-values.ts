/**
 * Appearance enum values shared between the Zod schema (server) and the UI.
 *
 * This file MUST stay free of Node built-ins and other server-only imports
 * so it can be consumed by browser code without pulling in the full schema
 * dependency graph.
 */

export const APPEARANCE_THEMES = ['sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate'] as const;
export const APPEARANCE_MODES = ['light', 'dark', 'system'] as const;
export const APPEARANCE_FONTS = ['default', 'geist-mono', 'system', 'sf-mono', 'fira-code', 'jetbrains-mono'] as const;
export const APPEARANCE_DENSITIES = ['compact', 'normal', 'comfy'] as const;

export type AppearanceTheme = typeof APPEARANCE_THEMES[number];
export type AppearanceMode = typeof APPEARANCE_MODES[number];
export type AppearanceFont = typeof APPEARANCE_FONTS[number];
export type AppearanceDensity = typeof APPEARANCE_DENSITIES[number];

export interface AppearanceValues {
  theme: AppearanceTheme;
  mode: AppearanceMode;
  font: AppearanceFont;
  density: AppearanceDensity;
}
