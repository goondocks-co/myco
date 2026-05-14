// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useListKeyboardNav } from '../../packages/myco/ui/src/hooks/use-list-keyboard-nav';

interface Row { id: string; label: string }
const ITEMS: Row[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
];

function Harness({
  selectedId,
  onActivate,
}: {
  selectedId?: string;
  onActivate: (id: string) => void;
}) {
  const filterRef = useRef<HTMLInputElement>(null);
  const nav = useListKeyboardNav({
    items: ITEMS,
    getId: (r) => r.id,
    selectedId,
    onActivate,
    filterInputRef: filterRef,
  });
  return (
    <div>
      <input ref={filterRef} data-testid="filter" />
      <div data-testid="list" {...nav.containerProps}>
        {ITEMS.map((row, i) => (
          <div
            key={row.id}
            ref={nav.setRowRef(i)}
            data-testid={`row-${row.id}`}
            data-cursor={nav.cursorIndex === i ? 'true' : 'false'}
          >
            {row.label}
          </div>
        ))}
      </div>
    </div>
  );
}

describe('useListKeyboardNav', () => {
  it('initializes cursor at selectedId index', () => {
    render(<Harness selectedId="b" onActivate={() => {}} />);
    expect(screen.getByTestId('row-b').dataset.cursor).toBe('true');
  });

  it('initializes cursor at 0 when selectedId is undefined', () => {
    render(<Harness onActivate={() => {}} />);
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
  });

  it('j / ArrowDown moves cursor forward', () => {
    render(<Harness onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'j' });
    expect(screen.getByTestId('row-b').dataset.cursor).toBe('true');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getByTestId('row-c').dataset.cursor).toBe('true');
  });

  it('k / ArrowUp moves cursor back', () => {
    render(<Harness selectedId="c" onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'k' });
    expect(screen.getByTestId('row-b').dataset.cursor).toBe('true');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
  });

  it('clamps at boundaries', () => {
    render(<Harness onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'k' });
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    expect(screen.getByTestId('row-c').dataset.cursor).toBe('true');
  });

  it('Enter calls onActivate with current row id', () => {
    const onActivate = mock(() => {});
    render(<Harness onActivate={onActivate} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]).toBe('b');
  });

  it('/ focuses the filter input', () => {
    render(<Harness onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: '/' });
    expect(document.activeElement).toBe(screen.getByTestId('filter'));
  });

  it('ignores capital J/K (shift modifier)', () => {
    render(<Harness onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'J', shiftKey: true });
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
  });

  it('ignores keys with meta/ctrl/alt modifiers', () => {
    render(<Harness onActivate={() => {}} />);
    const list = screen.getByTestId('list');
    fireEvent.keyDown(list, { key: 'j', metaKey: true });
    fireEvent.keyDown(list, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(list, { key: 'j', altKey: true });
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
  });

  it('resyncs cursor when selectedId changes externally', () => {
    const { rerender } = render(<Harness selectedId="a" onActivate={() => {}} />);
    expect(screen.getByTestId('row-a').dataset.cursor).toBe('true');
    rerender(<Harness selectedId="c" onActivate={() => {}} />);
    expect(screen.getByTestId('row-c').dataset.cursor).toBe('true');
  });
});
