// Types for nav.mjs, the docs site's navigation manifest.
export interface NavItem { slug: string; title: string }
export interface NavGroup { group: string; items: NavItem[] }
export declare const NAV: NavGroup[];
export declare function allSlugs(): string[];
