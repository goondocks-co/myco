/**
 * The fixture's machine ids, in the shape a machine's id takes
 * (`<login>_<8 hex>`). The fixture seeds them and the screen checks assert
 * that none reaches a page. This module imports nothing, so a Playwright spec
 * can read it without the fixture's Bun-only imports.
 */
export const MACHINE_IDS = {
  studio: 'ada_3f9e21c4',
  buildbox: 'lin_8b02d6aa',
  unnamed: 'ada_7c1e9f02',
} as const;
