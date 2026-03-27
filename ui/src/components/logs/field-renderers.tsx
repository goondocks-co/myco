import { Link } from 'react-router-dom';
import { Badge } from '../ui/badge';

// ---------------------------------------------------------------------------
// Individual renderers
// ---------------------------------------------------------------------------

function SessionLink({ value }: { value: unknown }) {
  const id = String(value);
  const short = id.slice(0, 8);
  return (
    <Link
      to={`/sessions/${id}`}
      className="font-mono text-primary hover:underline"
    >
      {short}...
    </Link>
  );
}

function SporeList({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return <span>{String(value)}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {value.map((title, i) => (
        <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0">
          {String(title)}
        </Badge>
      ))}
    </span>
  );
}

function ScorePills({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return <span>{String(value)}</span>;
  return (
    <span className="flex gap-1">
      {value.map((score, i) => (
        <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0 tabular-nums">
          {String(score)}
        </Badge>
      ))}
    </span>
  );
}

function ErrorBlock({ value }: { value: unknown }) {
  return (
    <span className="rounded bg-tertiary/10 px-2 py-0.5 text-tertiary font-mono text-[11px]">
      {String(value)}
    </span>
  );
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-32 overflow-auto rounded bg-surface-container-lowest px-2 py-1 text-[11px] font-mono text-on-surface-variant whitespace-pre-wrap">
      {String(value)}
    </pre>
  );
}

function RelativeTime({ value }: { value: unknown }) {
  const date = new Date(String(value));
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  let relative: string;
  if (diffMin < 1) relative = 'just now';
  else if (diffMin < 60) relative = `${diffMin}m ago`;
  else if (diffHr < 24) relative = `${diffHr}h ago`;
  else relative = `${diffDay}d ago`;

  return (
    <span className="tabular-nums" title={date.toISOString()}>
      {relative}
    </span>
  );
}

function DefaultValue({ value }: { value: unknown }) {
  if (typeof value === 'object' && value !== null) {
    return (
      <pre className="text-[11px] font-mono text-on-surface-variant whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span>{String(value)}</span>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const FIELD_RENDERERS: Record<string, React.ComponentType<{ value: unknown }>> = {
  session_id: SessionLink,
  spore_titles: SporeList,
  scores: ScorePills,
  error: ErrorBlock,
  preview: CodeBlock,
  generated_at: RelativeTime,
  text: CodeBlock,
};

/** Structural fields that should not be rendered in the metadata section. */
const STRUCTURAL_FIELDS = new Set([
  'id', 'timestamp', 'level', 'kind', 'component', 'message',
]);

/**
 * Render a metadata field value using the appropriate renderer.
 */
export function renderField(key: string, value: unknown): React.ReactNode {
  const Renderer = FIELD_RENDERERS[key] ?? DefaultValue;
  return <Renderer value={value} />;
}

/**
 * Check if a key is a structural field (not metadata).
 */
export function isStructuralField(key: string): boolean {
  return STRUCTURAL_FIELDS.has(key);
}

/**
 * Get display-friendly metadata entries from a log entry's data object.
 */
export function getMetadataEntries(data: Record<string, unknown> | null): [string, unknown][] {
  if (!data) return [];
  return Object.entries(data).filter(([k]) => !isStructuralField(k));
}
