import type { OkfGatherResult } from '@myco/okf/bundle.js';
import type { OkfDocument } from '@myco/okf/types.js';

/**
 * Test-injected stand-in for the Phase-2 agent-synthesis `renderDocuments`
 * seam. Turns gathered vault rows into a small, deterministic set of valid OKF
 * documents (six-key frontmatter) at stable bundle paths, so the OkfBundle
 * staging/atomic-replace/crash-recovery machinery can be exercised end-to-end
 * before real synthesis lands. The real spore/canopy content flows into the
 * document BODY (not frontmatter), so the publish-eligibility scanner still
 * sees any secrets a spore carries.
 */
const FIXED_TS = '2026-07-05T00:00:00Z';

export function fixtureRenderDocuments(gathered: OkfGatherResult): OkfDocument[] {
  const docs: OkfDocument[] = [];

  for (const spore of gathered.spores) {
    docs.push({
      path: `spores/decisions/${spore.id}.md`,
      frontmatter: {
        type: 'decision',
        title: spore.id,
        description: 'A project decision captured from the vault.',
        timestamp: FIXED_TS,
      },
      body: spore.content,
    });
  }

  for (const entry of gathered.canopyEntries) {
    docs.push({
      path: `canopy/files/${entry.path}.md`,
      frontmatter: {
        type: 'file',
        title: entry.path,
        description: 'A described repository file.',
        timestamp: FIXED_TS,
      },
      body: entry.llm_description ?? '',
    });
  }

  docs.push({
    path: 'guides/maintaining-this-bundle.md',
    frontmatter: {
      type: 'guide',
      title: 'Maintaining this bundle',
      description: 'How this knowledge bundle is regenerated.',
      timestamp: FIXED_TS,
    },
    body: 'Run maintain to regenerate this bundle from the vault.',
  });

  return docs;
}

/** A fixture whose single document fails `strict` validation (newline in title). */
export function invalidFixtureRenderDocuments(_gathered: OkfGatherResult): OkfDocument[] {
  return [
    {
      path: 'pages/broken.md',
      frontmatter: {
        type: 'note',
        title: 'Bad\nTitle',
        description: 'A page whose title breaks the generated index bullet.',
        timestamp: FIXED_TS,
      },
      body: 'Structurally unsafe frontmatter.',
    },
  ];
}
