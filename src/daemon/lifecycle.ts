interface RegistryOptions {
  gracePeriod: number;
  onEmpty: () => void;
}

export class SessionRegistry {
  private _sessions: Set<string> = new Set();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private gracePeriod: number;
  private onEmpty: () => void;

  constructor(options: RegistryOptions) {
    this.gracePeriod = options.gracePeriod;
    this.onEmpty = options.onEmpty;
  }

  get sessions(): string[] {
    return [...this._sessions];
  }

  register(sessionId: string): void {
    this._sessions.add(sessionId);
    this.cancelGrace();
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
