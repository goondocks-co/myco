import { CloudOff } from 'lucide-react';
import { Panel } from './panel';
import { IconEyebrow } from './icon-eyebrow';
import { AccentSurface } from './accent-surface';
import { cn } from '../../lib/cn';
import { hostedUnavailableMessage, type HostedDegradedInfo } from '../../lib/degrade';

/**
 * The ONE uniform "unavailable for hosted projects" presentation
 * (plan-of-record 3.4) — every `degrade`-stamped route an attached project
 * hits (Canopy, git provenance, backup, embedding maintenance, Grove
 * lifecycle) renders through this component instead of a raw error toast or
 * a per-page bespoke message. Two sizes: `panel` replaces a whole page/section
 * body (a degraded feature page), `inline` fits inside an existing card or row
 * (a single degraded control within an otherwise-working page).
 */
export interface HostedUnavailableProps {
  info: HostedDegradedInfo;
  variant?: 'panel' | 'inline';
  className?: string;
}

export function HostedUnavailable({ info, variant = 'panel', className }: HostedUnavailableProps) {
  const message = hostedUnavailableMessage(info);

  if (variant === 'inline') {
    return (
      <AccentSurface
        accent="ochre"
        padded
        className={cn('flex items-center gap-2 text-sm text-on-surface-variant', className)}
        role="status"
      >
        <CloudOff className="size-4 shrink-0 text-ochre" aria-hidden />
        <span>{message}</span>
      </AccentSurface>
    );
  }

  return (
    <Panel
      tone="ochre"
      eyebrow={<IconEyebrow Icon={CloudOff} tone="ochre">Unavailable for hosted projects</IconEyebrow>}
      title={info.capability}
      className={className}
    >
      <p className="text-sm text-on-surface-variant m-0" role="status">{message}</p>
    </Panel>
  );
}
