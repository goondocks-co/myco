// Navigation for the sidebar, sitemap and published Markdown.
export const NAV = [
  {
    group: 'Getting started',
    items: [
      { slug: 'quickstart', title: 'Join a Myco' },
      { slug: 'self-hosting', title: 'Run your own Myco' },
      { slug: 'runners', title: 'Runners' },
      { slug: 'upgrade', title: 'Updating Myco' },
    ],
  },
  {
    group: 'Using Myco',
    items: [
      { slug: 'dashboard', title: 'The dashboard' },
      { slug: 'how-myco-learns', title: 'How Myco learns' },
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
    ],
  },
];

export function allSlugs() {
  return NAV.flatMap((group) => group.items.map((item) => item.slug));
}
