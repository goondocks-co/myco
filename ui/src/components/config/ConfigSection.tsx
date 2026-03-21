import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { cn } from '../../lib/cn';

interface ConfigSectionProps {
  title: string;
  description?: string;
  isDirty?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function ConfigSection({
  title,
  description,
  isDirty,
  defaultOpen = false,
  children,
}: ConfigSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            {isDirty && (
              <span className="h-2 w-2 rounded-full bg-primary" title="Unsaved changes" />
            )}
          </div>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
        </div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}
