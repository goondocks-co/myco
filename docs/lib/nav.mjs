// docs/lib/nav.mjs
// Single source of truth for doc navigation: sidebar groups, ordering,
// sitemap entries, and the index grid (see build.mjs and index.html).
// slug -> source docs/<slug>.md, output _site/<slug>.html, URL /<slug>.
export const NAV = [
  {
    group: 'Getting started',
    items: [
      { slug: 'quickstart', title: 'Quickstart' },
      { slug: 'upgrade-from-v1', title: 'Upgrading from 1.4' },
      { slug: 'self-hosting', title: 'Self-hosting' },
    ],
  },
  {
    group: 'Using Myco',
    items: [
      { slug: 'intelligence', title: 'How Myco learns' },
      { slug: 'agents', title: 'Agents' },
      { slug: 'agent-tools', title: 'Agent tools' },
      { slug: 'external-agents', title: 'External agents' },
      { slug: 'configuration', title: 'Configuration' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { slug: 'architecture/actors-and-boundaries', title: 'Actors & boundaries' },
      { slug: 'architecture/platform-packages', title: 'Platform packages' },
      { slug: 'architecture/ci', title: 'CI' },
      { slug: 'architecture/worker-smoke-rig', title: 'Worker smoke rig' },
    ],
  },
];

export function allSlugs() {
  return NAV.flatMap((group) => group.items.map((item) => item.slug));
}
