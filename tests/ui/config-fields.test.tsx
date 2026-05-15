// @vitest-environment jsdom

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ListField,
  NumberField,
  SecretField,
  SelectField,
  TextField,
  ToggleField,
} from '../../packages/myco/ui/src/components/config';

describe('config field controls', () => {
  it('ToggleField commits the next boolean on click', () => {
    const onChange = mock((_next: boolean) => {});
    render(<ToggleField id="toggle" value={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(true);
  });

  it('NumberField commits a clamped value on blur', () => {
    const onChange = mock((_next: number) => {});
    render(
      <NumberField id="num" value={5} min={0} max={10} onChange={onChange} />,
    );

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(10);
  });

  it('TextField commits a trimmed value on blur', () => {
    const onChange = mock((_next: string) => {});
    render(<TextField id="text" value="" onChange={onChange} />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('hello');
  });

  it('ListField appends an entry on Enter and removes via the chip × button', () => {
    const onChange = mock((_next: string[]) => {});
    const { rerender } = render(
      <ListField id="list" value={[]} onChange={onChange} placeholder="path" />,
    );

    const input = screen.getByPlaceholderText('path') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'docs/spec.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(['docs/spec.md']);

    rerender(
      <ListField
        id="list"
        value={['docs/spec.md']}
        onChange={onChange}
        placeholder="path"
      />,
    );

    fireEvent.click(screen.getByLabelText('Remove docs/spec.md'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual([]);
  });

  it('SelectField renders the current value in the trigger', () => {
    const onChange = mock((_next: string) => {});
    render(
      <SelectField
        id="select"
        value="medium"
        options={['low', 'medium', 'high']}
        onChange={onChange}
      />,
    );

    // Radix Select reflects the current value inside the trigger button.
    expect(screen.getByRole('combobox')).toHaveTextContent('medium');
  });

  it('SelectField (readonly) renders a static chip with an optional label override and never calls onChange', () => {
    const onChange = mock((_next: string) => {});
    const { container } = render(
      <SelectField
        id="select-ro"
        value="medium"
        options={['low', 'medium', 'high']}
        optionLabels={{ medium: 'Medium' }}
        onChange={onChange}
        readonly
      />,
    );

    const node = container.querySelector('#select-ro');
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe('Medium');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('SecretField toggles between password and text on the reveal button and commits on blur', () => {
    const onChange = mock((_next: string) => {});
    const { container } = render(
      <SecretField id="secret" value="" onChange={onChange} placeholder="API key" />,
    );

    const input = screen.getByPlaceholderText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByLabelText('Reveal secret'));
    const revealed = container.querySelector('#secret') as HTMLInputElement;
    expect(revealed.type).toBe('text');

    fireEvent.change(revealed, { target: { value: 'sk-abc' } });
    fireEvent.blur(revealed);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('sk-abc');
  });

  it('SecretField shows a stored-in-keychain chip when configured', () => {
    render(
      <SecretField
        id="secret"
        value=""
        onChange={() => {}}
        configured
        source="keychain"
      />,
    );

    expect(screen.getByText('stored in keychain')).toBeInTheDocument();
  });
});
