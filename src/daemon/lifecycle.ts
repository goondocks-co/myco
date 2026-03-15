export interface SessionMetadata {
  started_at: string;
  branch?: string;
}

export interface RegisteredSession extends SessionMetadata {
  id: string;
}

interface RegistryOptions {
  gracePeriod: number;
  onEmpty: () => void;
}

export class SessionRegistry {
  private _sessions: Map<string, SessionMetadata> = new Map();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private gracePeriod: number;
  private onEmpty: () => void;

  constructor(options: RegistryOptions) {
    this.gracePeriod = options.gracePeriod;
    this.onEmpty = options.onEmpty;
  }

  get sessions(): string[] {
    return [...this._sessions.keys()];
  }

  register(sessionId: string, metadata?: SessionMetadata): void {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, metadata ?? { started_at: new Date().toISOString() });
    }
    this.cancelGrace();
  }

  getSession(sessionId: string): RegisteredSession | undefined {
    const meta = this._sessions.get(sessionId);
    if (!meta) return undefined;
    return { id: sessionId, ...meta };
  }

  unregister(sessionId: string): void {
    this._sessions.delete(sessionId);
    if (this._sessions.size === 0) {
      this.startGrace();
    }
  }

  destroy(): void {
    this.cancelGrace();
    this._sessions.clear();
  }

  private startGrace(): void {
    this.cancelGrace();
    this.graceTimer = setTimeout(() => {
      if (this._sessions.size === 0) {
        this.onEmpty();
      }
    }, this.gracePeriod * 1000);
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
