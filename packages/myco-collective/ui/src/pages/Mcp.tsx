import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, Orbit, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { fetchCollectiveAccess, rotateCollectiveToken } from '../lib/api';

const COPY_RESET_MS = 2000;
const MCP_SERVER_NAME = 'myco-collective';
const TOKEN_VISIBLE_LABEL = 'Hide token';
const TOKEN_HIDDEN_LABEL = 'Reveal token';

function buildServerSlug(collectiveName: string): string {
  const normalized = collectiveName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || MCP_SERVER_NAME;
}

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    });
  }, []);

  return { copied, handleCopy };
}

function redactSecret(value: string): string {
  return `${value.slice(0, 8)}${'*'.repeat(Math.max(0, value.length - 12))}${value.slice(-4)}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { copied, handleCopy } = useCopyFeedback();

  return (
    <button
      type="button"
      onClick={() => handleCopy(value)}
      className="rounded p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function CopyableField({
  label,
  value,
  displayValue,
  mono = true,
}: {
  label: string;
  value: string;
  displayValue?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-start gap-2">
        <span className={`min-w-0 break-all text-sm text-on-surface ${mono ? 'font-mono' : ''}`}>{displayValue ?? value}</span>
        <div className="shrink-0">
          <CopyButton value={value} label={`Copy ${label}`} />
        </div>
      </div>
    </div>
  );
}

function RedactedField({
  label,
  value,
  visible,
  onToggle,
}: {
  label: string;
  value: string;
  visible: boolean;
  onToggle: () => void;
}) {
  const displayValue = visible ? value : redactSecret(value);

  return (
    <div className="space-y-1.5">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-start gap-2">
        <span className="min-w-0 break-all font-mono text-sm text-on-surface">{displayValue}</span>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 rounded p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          title={visible ? TOKEN_VISIBLE_LABEL : TOKEN_HIDDEN_LABEL}
          aria-label={visible ? TOKEN_VISIBLE_LABEL : TOKEN_HIDDEN_LABEL}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <div className="shrink-0">
          <CopyButton value={value} label={`Copy ${label}`} />
        </div>
      </div>
    </div>
  );
}

function SnippetCard({
  eyebrow,
  title,
  description,
  displayCode,
  clipboardCode,
  language,
}: {
  eyebrow: string;
  title: string;
  description: string;
  displayCode: string;
  clipboardCode: string;
  language: string;
}) {
  return (
    <Card className="p-6">
      <SectionHeader>{eyebrow}</SectionHeader>
      <h2 className="mt-2 font-serif text-xl text-on-surface">{title}</h2>
      <p className="mt-3 text-sm text-on-surface-variant">{description}</p>
      <div className="relative mt-5 overflow-hidden rounded-md border border-[var(--ghost-border)] bg-surface-container-low">
        <div className="flex items-center justify-between border-b border-[var(--ghost-border)] px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant">
            {language}
          </span>
          <CopyButton value={clipboardCode} label={`Copy ${title} snippet`} />
        </div>
        <pre className="overflow-x-auto px-4 py-4 text-xs text-on-surface-variant">{displayCode}</pre>
      </div>
    </Card>
  );
}

export default function Mcp() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const accessQuery = useQuery({ queryKey: ['collective-access'], queryFn: fetchCollectiveAccess });

  const rotateMutation = useMutation({
    mutationFn: () => rotateCollectiveToken('mcp'),
    onSuccess: async () => {
      setMessage('MCP access token rotated.');
      await queryClient.invalidateQueries({ queryKey: ['collective-access'] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Failed to rotate MCP token.');
    },
  });

  const collectiveName = accessQuery.data?.collective_name ?? 'Collective';
  const serverName = buildServerSlug(collectiveName);
  const rawToken = accessQuery.data?.mcp_token ?? null;

  const claudeAgentSnippets = useMemo(() => {
    if (!rawToken || !accessQuery.data?.mcp_endpoint) return null;
    const build = (token: string) => JSON.stringify({
      mcp_servers: [
        {
          name: serverName,
          type: 'url',
          url: accessQuery.data!.mcp_endpoint,
          authorization_token: token,
        },
      ],
    }, null, 2);
    return {
      clipboard: build(rawToken),
      display: build(tokenVisible ? rawToken : redactSecret(rawToken)),
    };
  }, [accessQuery.data?.mcp_endpoint, rawToken, serverName, tokenVisible]);

  const inspectorSnippets = useMemo(() => {
    if (!rawToken || !accessQuery.data?.mcp_endpoint) return null;
    const build = (token: string) => [
      'npx @modelcontextprotocol/inspector',
      '',
      '# Transport: Streamable HTTP',
      `# URL: ${accessQuery.data!.mcp_endpoint}`,
      `# Header: Authorization: Bearer ${token}`,
    ].join('\n');
    return {
      clipboard: build(rawToken),
      display: build(tokenVisible ? rawToken : redactSecret(rawToken)),
    };
  }, [accessQuery.data?.mcp_endpoint, rawToken, tokenVisible]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="MCP"
        title="Hosted MCP access for the Collective."
        subtitle="Use the cloud endpoint for Claude agent workflows now. Native Claude Code and Codex installation guidance will expand on this page as those integrations land."
        actions={(
          <Badge variant={accessQuery.data?.mcp_token_hash ? 'accent' : 'danger'}>
            MCP {accessQuery.data?.mcp_token_hash ? 'Ready' : 'Missing'}
          </Badge>
        )}
      />

      <section className="grid gap-4 xl:grid-cols-[0.95fr,1.05fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <Orbit className="h-5 w-5 text-primary" />
              <div>
                <SectionHeader>Hosted access</SectionHeader>
                <h2 className="mt-2 font-serif text-2xl text-on-surface">{collectiveName}</h2>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMessage(null);
                rotateMutation.mutate();
              }}
              disabled={rotateMutation.isPending || !accessQuery.data?.mcp_token}
            >
              {rotateMutation.isPending ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Rotating...
                </>
              ) : (
                'Rotate token'
              )}
            </Button>
          </div>

          <p className="mt-3 text-sm text-on-surface-variant">
            This is the shared read-only MCP surface for cross-project search, project discovery, and Collective settings across connected workers.
          </p>

          <div className="mt-5 space-y-4">
            {accessQuery.data?.mcp_endpoint && (
              <CopyableField label="MCP URL" value={accessQuery.data.mcp_endpoint} />
            )}
            {rawToken && (
              <RedactedField
                label="MCP Access Token"
                value={rawToken}
                visible={tokenVisible}
                onToggle={() => setTokenVisible((current) => !current)}
              />
            )}
            {rawToken && (
              <CopyableField
                label="Authorization Header"
                value={`Authorization: Bearer ${rawToken}`}
                displayValue={`Authorization: Bearer ${tokenVisible ? rawToken : redactSecret(rawToken)}`}
                mono
              />
            )}
            <CopyableField label="Transport" value="Streamable HTTP" />
          </div>

          {message && (
            <p className="mt-4 text-sm text-on-surface-variant">{message}</p>
          )}
        </Card>

        {claudeAgentSnippets && (
          <SnippetCard
            eyebrow="Claude agents"
            title="Managed agent MCP JSON"
            description="Paste this into Anthropic's remote MCP configuration so Claude can call the Collective directly with the hosted bearer token."
            displayCode={claudeAgentSnippets.display}
            clipboardCode={claudeAgentSnippets.clipboard}
            language="JSON"
          />
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr,1fr]">
        {inspectorSnippets && (
          <SnippetCard
            eyebrow="Verification"
            title="MCP Inspector"
            description="Use Inspector when you want to verify transport, auth, and the exposed tool list before wiring a production agent."
            displayCode={inspectorSnippets.display}
            clipboardCode={inspectorSnippets.clipboard}
            language="Shell"
          />
        )}

        <Card className="p-6">
          <SectionHeader>Native installs</SectionHeader>
          <h2 className="mt-2 font-serif text-xl text-on-surface">Reserved for agent-native setup</h2>
          <p className="mt-3 text-sm text-on-surface-variant">
            This page is where native install guidance and one-click setup will live once hosted Collective access is available directly inside local agent shells.
          </p>

          <div className="mt-5 space-y-3">
            {[
              {
                label: 'Claude Code plugin support',
                detail: 'Planned. This will become the native path instead of pasting remote MCP JSON by hand.',
              },
              {
                label: 'Codex plugin support',
                detail: 'Planned. Native config and plugin instructions will land here once the remote install flow is ready.',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-on-surface">{item.label}</div>
                    <p className="mt-1 text-sm text-on-surface-variant">{item.detail}</p>
                  </div>
                  <Badge variant="subtle">Planned</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
