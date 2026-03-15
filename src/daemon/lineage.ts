import fs from 'node:fs';
import path from 'node:path';
import type { RegisteredSession } from './lifecycle.js';

export const LINEAGE_IMMEDIATE_GAP_SECONDS = 5;
export const LINEAGE_FALLBACK_MAX_HOURS = 24;
export const LINEAGE_SIMILARITY_THRESHOLD = 0.7;
export const LINEAGE_SIMILARITY_HIGH_CONFIDENCE = 0.9;
export const LINEAGE_SIMILARITY_CANDIDATES = 3;
export const LINEAGE_SIMILARITY_MAX_TOKENS = 8; // expects a single float score

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;

interface RecentSession {
  id: string;
  ended?: string;
  branch?: string;
}

interface SessionContext {
  started_at: string;
  branch?: string;
}

export interface LineageLink {
  parent: string;
  child: string;
  signal: 'clear' | 'clear_active' | 'inferred' | 'plan_reference' | 'semantic_similarity';
  confidence: 'high' | 'medium' | 'low';
  timestamp?: string;
}

interface LineageState {
  links: LineageLink[];
  sessionPlans: Record<string, string[]>;
}

export class LineageGraph {
  private state: LineageState;
  private filePath: string;

  constructor(vaultDir: string) {
    this.filePath = path.join(vaultDir, 'lineage.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.load();
  }

  addLink(link: LineageLink): void {
    if (this.state.links.some((l) => l.parent === link.parent && l.child === link.child)) return;
    this.state.links.push({ ...link, timestamp: link.timestamp ?? new Date().toISOString() });
    this.persist();
  }

  registerPlanForSession(sessionId: string, planId: string): void {
    if (!this.state.sessionPlans[sessionId]) this.state.sessionPlans[sessionId] = [];
    if (!this.state.sessionPlans[sessionId].includes(planId)) {
      this.state.sessionPlans[sessionId].push(planId);
      this.persist();
    }
  }

  detectLineage(childSessionId: string, firstPrompt: string): LineageLink | null {
    for (const [sessionId, planIds] of Object.entries(this.state.sessionPlans)) {
      if (sessionId === childSessionId) continue;
      for (const planId of planIds) {
        if (firstPrompt.includes(planId)) {
          const link: LineageLink = { parent: sessionId, child: childSessionId, signal: 'plan_reference', confidence: 'high' };
          this.addLink(link);
          return link;
        }
      }
    }
    return null;
  }

  detectHeuristicParent(
    childSessionId: string,
    context: SessionContext,
    recentSessions: RecentSession[],
    activeSessions: RegisteredSession[],
    firstPrompt?: string,
  ): LineageLink | null {
    const startedAt = new Date(context.started_at).getTime();

    // Tier 1: session ended within LINEAGE_IMMEDIATE_GAP_SECONDS
    for (const session of recentSessions) {
      if (!session.ended) continue;
      const endedAt = new Date(session.ended).getTime();
      const gapSeconds = (startedAt - endedAt) / MS_PER_SECOND;
      if (gapSeconds >= 0 && gapSeconds <= LINEAGE_IMMEDIATE_GAP_SECONDS) {
        const link: LineageLink = { parent: session.id, child: childSessionId, signal: 'clear', confidence: 'high' };
        this.addLink(link);
        return link;
      }
    }

    // Tier 2: active session (race condition)
    for (const session of activeSessions) {
      if (session.id === childSessionId) continue;
      const link: LineageLink = { parent: session.id, child: childSessionId, signal: 'clear_active', confidence: 'high' };
      this.addLink(link);
      return link;
    }

    // Tier 3: recently completed session on same branch within LINEAGE_FALLBACK_MAX_HOURS
    if (context.branch) {
      for (const session of recentSessions) {
        if (!session.ended || !session.branch) continue;
        if (session.branch !== context.branch) continue;
        const endedAt = new Date(session.ended).getTime();
        const hoursAgo = (startedAt - endedAt) / MS_PER_HOUR;
        if (hoursAgo >= 0 && hoursAgo <= LINEAGE_FALLBACK_MAX_HOURS) {
          const link: LineageLink = { parent: session.id, child: childSessionId, signal: 'inferred', confidence: 'medium' };
          this.addLink(link);
          return link;
        }
      }
    }

    // Plan-reference detection (existing method)
    if (firstPrompt) {
      return this.detectLineage(childSessionId, firstPrompt);
    }

    return null;
  }

  getLinks(): LineageLink[] { return [...this.state.links]; }
  getChildren(sessionId: string): string[] { return this.state.links.filter((l) => l.parent === sessionId).map((l) => l.child); }
  getParent(sessionId: string): string | undefined { return this.state.links.find((l) => l.child === sessionId)?.parent; }

  private load(): LineageState {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')); }
    catch { return { links: [], sessionPlans: {} }; }
  }

  private persist(): void {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
