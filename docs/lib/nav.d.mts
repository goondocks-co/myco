export interface NavItem {
  slug: string;
  title: string;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
}
export const NAV: NavGroup[];
export function allSlugs(): string[];
