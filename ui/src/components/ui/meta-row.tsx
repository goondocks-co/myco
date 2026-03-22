/** Reusable metadata key-value row used in detail panels. */
export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground font-mono text-right break-all">{value}</span>
    </div>
  );
}
