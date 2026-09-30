import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonProps } from './Button';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** The text placed on the clipboard. */
  value: string;
  /** The button's words, such as "Copy id" or "Copy resume command". */
  label?: string;
}

/** Copies a value and says so for two seconds. */
export function CopyButton({ value, label = 'Copy', variant = 'ghost', size = 'sm', ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? <Check aria-hidden className="size-s4 text-ok" /> : <Copy aria-hidden className="size-s4" />}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}
      {...props}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}
