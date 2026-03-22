/**
 * Tests for myco_consolidate tool handler (Phase 1 stub).
 */

import { describe, it, expect } from 'vitest';
import { handleMycoConsolidate } from '@myco/mcp/tools/consolidate.js';

describe('myco_consolidate', () => {
  it('returns unavailable status in Phase 1', async () => {
    const result = await handleMycoConsolidate({
      spore_ids: ['spore-1', 'spore-2', 'spore-3'],
    });

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('Phase 2');
  });
});
