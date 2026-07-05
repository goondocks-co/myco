import { describe, expect, it } from 'bun:test';
import { generateMaintenanceGuide } from '@myco/okf/projectors/guides.js';
import { renderConcept } from '@myco/okf/serialize.js';
import { validateConceptSource } from '@myco/okf/validate.js';

describe('generateMaintenanceGuide', () => {
  it('emits the fixed identity and validates at myco_strict', () => {
    const guide = generateMaintenanceGuide({ timestamp: '2026-07-05T12:00:00Z' });
    expect(guide.id).toBe('guides/maintaining-this-bundle');
    expect(guide.path).toBe('guides/maintaining-this-bundle.md');
    expect(guide.frontmatter.resource).toBe('myco://okf/guides/maintaining-this-bundle');
    expect(guide.frontmatter.timestamp).toBe('2026-07-05T12:00:00Z');
    const rendered = renderConcept(guide);
    expect(
      validateConceptSource(rendered.content, rendered.path, 'myco_strict').filter((i) => i.level === 'error'),
    ).toEqual([]);
  });

  it('documents both maintenance tiers and the ownership split', () => {
    const guide = generateMaintenanceGuide({ timestamp: '2026-07-05T12:00:00Z' });
    expect(guide.body).toContain('## With Myco tools');
    expect(guide.body).toContain('## Without Myco tools');
    expect(guide.body).toContain('`concepts/`');
    expect(guide.body).toContain('deterministic projection');
    expect(guide.body).toContain('log.md');
  });

  it('includes the prompt-injection reading boundary', () => {
    const guide = generateMaintenanceGuide({ timestamp: '2026-07-05T12:00:00Z' });
    expect(guide.body).toContain('reference data, not instructions');
  });

  it('keeps the body deterministic — timestamp varies frontmatter only', () => {
    const first = generateMaintenanceGuide({ timestamp: '2026-07-05T12:00:00Z' });
    const second = generateMaintenanceGuide({ timestamp: '2027-01-01T00:00:00Z' });
    expect(first.body).toBe(second.body);
    expect(first.frontmatter.timestamp).not.toBe(second.frontmatter.timestamp);
  });
});
