// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { SlideoutDetailPanel } from '../../packages/myco/ui/src/components/ui/slideout-detail-panel';

describe('SlideoutDetailPanel', () => {
  it('renders children when open', () => {
    render(
      <SlideoutDetailPanel open onClose={() => {}}>
        <div>panel body</div>
      </SlideoutDetailPanel>,
    );
    expect(screen.getByText('panel body')).toBeDefined();
  });

  it('does not render when closed', () => {
    render(
      <SlideoutDetailPanel open={false} onClose={() => {}}>
        <div>panel body</div>
      </SlideoutDetailPanel>,
    );
    expect(screen.queryByText('panel body')).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = mock(() => {});
    render(
      <SlideoutDetailPanel open onClose={onClose}>
        <div>panel body</div>
      </SlideoutDetailPanel>,
    );
    screen.getByRole('button', { name: /close detail/i }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = mock(() => {});
    render(
      <SlideoutDetailPanel open onClose={onClose}>
        <div>panel body</div>
      </SlideoutDetailPanel>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onClose when Escape fires while closed', () => {
    const onClose = mock(() => {});
    render(
      <SlideoutDetailPanel open={false} onClose={onClose}>
        <div>panel body</div>
      </SlideoutDetailPanel>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
