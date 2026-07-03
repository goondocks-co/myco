// @vitest-environment jsdom

import { describe, expect, it } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { ReportCard } from '../../packages/myco/ui/src/components/agent/RunDetail';
import { PhaseTimeline } from '../../packages/myco/ui/src/components/agent/PhaseTimeline';
import type { ReportRow } from '../../packages/myco/ui/src/hooks/use-agent';

function makeReport(summary: string): ReportRow {
  return {
    id: 1,
    run_id: 'run-1',
    agent_id: 'agent-1',
    action: 'describe',
    summary,
    details: null,
    created_at: 1_700_000_000,
  };
}

// Mirrors the observed harness-health report shape: several distinct
// "label (n): text" segments joined by newlines — multi-line, well over the
// 200-char long-summary threshold.
const MULTI_LINE_SUMMARY = [
  'unpaired_events (1): a checkpoint fired without a matching completion event, which can indicate a dropped write in the phase pipeline.',
  'postcondition_failures (1): the verify phase postcondition did not hold after the run completed.',
  'cost_spikes (1): token cost for this run exceeded the rolling baseline by a wide margin.',
].join('\n');

const ONE_LINE_SUMMARY = 'short summary text that is nevertheless long enough to pass the two-hundred character long-summary threshold so that the show more expander renders for this single unbroken line of prose content, with no newlines in it at all.';

// Blank-line-separated so each line becomes its own <p> — the worst case for
// the block-stacking overlap bug (many separately-margined paragraph boxes
// crammed into a 3-line clamp).
const TEN_LINE_SUMMARY = Array.from({ length: 10 }, (_, i) => `line ${i + 1}: some report detail text here.`).join('\n\n');

describe('ReportCard summary clamp/expander', () => {
  it('renders collapsed with compact (inline-flattened) markdown so the clamp box has no block-level children', () => {
    const { container } = render(<ReportCard report={makeReport(MULTI_LINE_SUMMARY)} />);

    const clampDiv = container.querySelector('.line-clamp-3');
    expect(clampDiv).not.toBeNull();

    // The compact markdown variant must be active while collapsed: it flattens
    // headings/paragraphs to `display: inline` (see prose-myco-compact in
    // index.css) so the clamped box contains a single inline flow instead of
    // stacked block boxes with their own margins. Stacked block boxes are what
    // produced the painted-over/overlapping text next to the expander.
    const markdownRoot = clampDiv!.querySelector('.prose-myco-compact');
    expect(markdownRoot).not.toBeNull();
    expect(clampDiv!.querySelector('.prose-myco:not(.prose-myco-compact)')).toBeNull();

    // No paragraph produced by react-markdown should be block-level while
    // collapsed — that's the geometry that overlapped the "Show more" row.
    const paragraphs = clampDiv!.querySelectorAll('p');
    for (const p of Array.from(paragraphs)) {
      expect(p.className).not.toContain('prose-myco:not');
    }
  });

  it('renders the "Show more" control after the clamp container, never nested inside it', () => {
    const { container, getByText } = render(<ReportCard report={makeReport(MULTI_LINE_SUMMARY)} />);

    const clampDiv = container.querySelector('.line-clamp-3');
    const expander = getByText(/show more/i).closest('button');
    expect(expander).not.toBeNull();
    // The expander must be a sibling of the clamped block, not a descendant —
    // an absolutely-positioned overlay nested inside the clamp box is exactly
    // the interaction that painted over clamped text.
    expect(clampDiv!.contains(expander)).toBe(false);
    expect(expander!.parentElement).toBe(clampDiv!.parentElement);
  });

  it('expands to full (non-compact) markdown on click, removing the clamp class', () => {
    const { container, getByText } = render(<ReportCard report={makeReport(MULTI_LINE_SUMMARY)} />);

    fireEvent.click(getByText(/show more/i));

    expect(container.querySelector('.line-clamp-3')).toBeNull();
    expect(container.querySelector('.prose-myco-compact')).toBeNull();
    expect(container.querySelector('.prose-myco')).not.toBeNull();
    expect(getByText(/show less/i)).toBeDefined();
  });

  it('does not clamp or show an expander for a short (non-long) summary', () => {
    const { container, queryByText } = render(<ReportCard report={makeReport('all good, nothing to see here.')} />);

    expect(container.querySelector('.line-clamp-3')).toBeNull();
    expect(container.querySelector('.prose-myco-compact')).toBeNull();
    expect(queryByText(/show more/i)).toBeNull();
  });

  it('clamps a single long line the same way as a multi-line summary', () => {
    const { container } = render(<ReportCard report={makeReport(ONE_LINE_SUMMARY)} />);

    const clampDiv = container.querySelector('.line-clamp-3');
    expect(clampDiv).not.toBeNull();
    expect(clampDiv!.querySelector('.prose-myco-compact')).not.toBeNull();
  });

  it('clamps a ten-line summary without leaving block-level paragraphs in the collapsed box', () => {
    const { container } = render(<ReportCard report={makeReport(TEN_LINE_SUMMARY)} />);

    const clampDiv = container.querySelector('.line-clamp-3');
    expect(clampDiv).not.toBeNull();
    expect(clampDiv!.querySelector('.prose-myco-compact')).not.toBeNull();

    // react-markdown still produces one <p> per source line; compact CSS makes
    // them `display: inline`, but structurally they must still all live inside
    // the single clamp container (not escape it).
    const paragraphs = clampDiv!.querySelectorAll('p');
    expect(paragraphs.length).toBe(10);
  });
});

describe('PhaseTimeline summary clamp/expander', () => {
  it('renders phase summaries in compact mode while collapsed', () => {
    const { container } = render(
      <PhaseTimeline
        phases={[
          {
            name: 'verify',
            status: 'completed',
            turnsUsed: 3,
            tokensUsed: 500,
            costUsd: 0.001,
            summary: MULTI_LINE_SUMMARY,
          },
        ]}
      />,
    );

    const clampDiv = container.querySelector('.line-clamp-2');
    expect(clampDiv).not.toBeNull();
    expect(clampDiv!.querySelector('.prose-myco-compact')).not.toBeNull();
  });
});
