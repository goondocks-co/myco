// docs/lib/nav.mjs
// Single source of truth for doc navigation: sidebar groups, ordering,
// sitemap entries, and the index grid (see build.mjs and index.html).
// slug -> source docs/<slug>.md, output _site/<slug>.html, URL /<slug>.
export const NAV = [
  {
    group: 'Getting started',
    items: [
      { slug: 'quickstart', title: 'Quickstart' },
      { slug: 'migrating-from-oak', title: 'Migrating from OAK' },
      { slug: 'upgrade', title: 'Upgrading Myco' },
    ],
  },
  {
    group: 'Core',
    items: [
      { slug: 'lifecycle', title: 'Local service lifecycle' },
      { slug: 'groves', title: 'Grove management' },
      { slug: 'skills', title: 'Skills' },
      { slug: 'canopy', title: 'Canopy' },
      { slug: 'symbionts', title: 'Symbionts' },
      { slug: 'agent-harness', title: 'Agent harness' },
      { slug: 'agent-tools', title: 'Agent MCP tools' },
    ],
  },
  {
    group: 'Team',
    items: [
      { slug: 'team-sync', title: 'Team Sync' },
      { slug: 'cloud-mcp', title: 'Cloud MCP' },
      { slug: 'collective', title: 'Collective' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { slug: 'agent-teams', title: 'Agent teams' },
      { slug: 'architecture/actors-and-boundaries', title: 'Actors & boundaries' },
      { slug: 'architecture/platform-packages', title: 'Platform packages' },
    ],
  },
];

export function allSlugs() {
  return NAV.flatMap((group) => group.items.map((item) => item.slug));
}
