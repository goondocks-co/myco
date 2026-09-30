import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The design system's own scales, so a class given later overrides one given
 * earlier in the same property: `px-0` after `px-s4`, `h-[44px]` after
 * `h-control`, `t-body` after `t-control` or after `text-sm`, `leading-*` or
 * `font-mono`. Without them the merge keeps both,
 * and whichever the stylesheet happens to emit last wins.
 */
const twMerge = extendTailwindMerge<'type-scale'>({
  extend: {
    theme: {
      spacing: ['s1', 's2', 's3', 's4', 's5', 's6', 's8', 's10', 's12', 'gutter', 'control', 'control-sm', 'row', 'row-tight', 'tap', 'measure'],
      radius: ['chip', 'control', 'card', 'pill'],
    },
    classGroups: {
      'type-scale': ['t-display', 't-h2', 't-h3', 't-headline', 't-body', 't-small', 't-meta', 't-kicker', 't-control', 't-mono'],
    },
    // A type-scale class sets the family, size and line height at once, so it replaces any of them given earlier.
    conflictingClassGroups: {
      'type-scale': ['font-size', 'leading', 'font-family'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
