/**
 * myco_consolidate — merge related spores into a single comprehensive note.
 *
 * Phase 1 stub: consolidation requires intelligence configuration (LLM) which
 * is not yet wired into the SQLite flow. Returns a helpful message directing
 * users to Phase 2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsolidateInput {
  source_spore_ids: string[];
}

interface ConsolidateResult {
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoConsolidate(
  _input: ConsolidateInput,
): Promise<ConsolidateResult> {
  return {
    status: 'unavailable',
    message: 'Consolidation requires intelligence configuration (Phase 2). Use myco_supersede to manually mark outdated spores.',
  };
}
