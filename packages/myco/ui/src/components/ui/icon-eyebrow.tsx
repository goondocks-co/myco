import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Eyebrow, type EyebrowProps } from './eyebrow';

export interface IconEyebrowProps extends EyebrowProps {
  Icon: LucideIcon;
  children: ReactNode;
}

/**
 * Eyebrow with a leading 12px Lucide icon. Use anywhere the Eyebrow rhythm
 * needs a category glyph (Panel header eyebrow, MetricCard label, etc.).
 */
export function IconEyebrow({ Icon, children, ...rest }: IconEyebrowProps) {
  return (
    <Eyebrow {...rest}>
      <Icon className="h-3 w-3 mr-1.5" aria-hidden />
      {children}
    </Eyebrow>
  );
}
