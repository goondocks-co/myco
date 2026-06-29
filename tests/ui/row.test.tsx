// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { Row } from '../../packages/myco/ui/src/components/ui/row';

describe('Row', () => {
  it('renders children with default chrome', () => {
    render(<Row>hello</Row>);
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('is non-interactive by default', () => {
    render(<Row>plain</Row>);
    const node = screen.getByText('plain');
    expect(node.getAttribute('tabindex')).toBeNull();
    expect(node.getAttribute('role')).toBeNull();
  });

  it('becomes interactive when onClick is provided', () => {
    const onClick = mock(() => {});
    render(<Row onClick={onClick}>clickable</Row>);
    const node = screen.getByText('clickable');
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(node.getAttribute('role')).toBe('row');
    fireEvent.click(node);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('triggers onClick on Enter and Space', () => {
    const onClick = mock(() => {});
    render(<Row onClick={onClick}>keyboard</Row>);
    const node = screen.getByText('keyboard');
    fireEvent.keyDown(node, { key: 'Enter' });
    fireEvent.keyDown(node, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('paints active stripe per accent when isActive', () => {
    const { container, rerender } = render(<Row isActive accent="sage">x</Row>);
    expect(container.firstChild).toHaveProperty('className');
    expect((container.firstChild as HTMLElement).className).toContain('bg-sage');
    rerender(<Row isActive accent="ochre">x</Row>);
    expect((container.firstChild as HTMLElement).className).toContain('bg-ochre');
    rerender(<Row isActive accent="terra">x</Row>);
    expect((container.firstChild as HTMLElement).className).toContain('bg-terracotta');
  });

  it('exposes data-active when active and aria-selected when interactive', () => {
    render(<Row isActive onClick={() => {}}>row</Row>);
    const node = screen.getByText('row');
    expect(node.getAttribute('data-active')).toBe('true');
    expect(node.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps selected styling dominant when the keyboard cursor is also on the row', () => {
    const { container } = render(<Row isActive isCursor accent="sage">selected cursor</Row>);
    const className = (container.firstChild as HTMLElement).className;
    expect(className).toContain('bg-sage');
    expect(className).not.toContain('ring-1');
  });

  it('renders cursor styling as focus chrome when the row is not selected', () => {
    const { container } = render(<Row isCursor accent="sage">cursor only</Row>);
    const className = (container.firstChild as HTMLElement).className;
    expect(className).toContain('ring-1');
    expect(className).toContain('ring-sage');
  });
});
