// Navigation for the sidebar, sitemap and published Markdown.
export const NAV = [
  {
    group: 'Getting started',
    items: [
      { slug: 'quickstart', title: 'Join a Myco' },
      { slug: 'self-hosting', title: 'Run your own Myco' },
      { slug: 'upgrade', title: 'Updating Myco' },
    ],
  },
  {
    group: 'Using Myco',
    items: [
      { slug: 'agents', title: 'Agents' },
      { slug: 'agent-tools', title: 'Agent tools' },
      { slug: 'external-agents', title: 'External agents' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { slug: 'architecture/actors-and-boundaries', title: 'Actors & boundaries' },
      { slug: 'architecture/platform-packages', title: 'Platform packages' },
    ],
  },
];

export function allSlugs() {
  return NAV.flatMap((group) => group.items.map((item) => item.slug));
}
