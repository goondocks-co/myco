import fs from 'node:fs';
import path from 'node:path';

export interface LineageLink {
  parent: string;
  child: string;
  signal: 'plan_reference' | 'branch_continuity' | 'plan_mode_exit' | 'explicit';
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

  getLinks(): LineageLink[] { return [...this.state.links]; }
  getChildren(sessionId: string): string[] { return this.state.links.filter((l) => l.parent === sessionId).map((l) => l.child); }
  getParent(sessionId: string): string | undefined { return this.state.links.find((l) => l.child === sessionId)?.parent; }

  private load(): LineageState {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')); }
    catch { return { links: [], sessionPlans: {} }; }
  }

  private persist(): void {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
