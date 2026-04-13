import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,192,128,0.45)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[linear-gradient(135deg,#f7b36a,#f18b53)] px-4 py-2 text-[#20120d] shadow-[0_16px_40px_rgba(241,139,83,0.24)] hover:brightness-105',
        secondary: 'border border-[rgba(255,233,207,0.12)] bg-[rgba(255,244,230,0.06)] px-4 py-2 text-[#f8ebde] hover:bg-[rgba(255,244,230,0.11)]',
        ghost: 'px-3 py-2 text-[#cdb8a8] hover:bg-[rgba(255,244,230,0.08)] hover:text-[#fff2e5]',
        danger: 'border border-[rgba(255,143,112,0.28)] bg-[rgba(120,28,15,0.32)] px-4 py-2 text-[#ffc7bb] hover:bg-[rgba(120,28,15,0.45)]',
      },
      size: {
        sm: 'h-9',
        md: 'h-11',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);

Button.displayName = 'Button';
