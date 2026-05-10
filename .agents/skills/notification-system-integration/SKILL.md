---
name: myco:notification-system-integration
description: |
  Comprehensive procedures for implementing and maintaining Myco's notification
  system across all architectural layers. Covers database schema design for
  notification tables, domain event emission point integration across
  daemon/vault/symbiont/UI domains, browser notification APIs with annoyance
  prevention, React component architecture for notification display,
  registry-driven notification configuration, and multi-mode delivery
  coordination. Use when implementing new notification types, integrating event
  emission into existing domains, building notification UI components, or
  coordinating notification delivery across multiple channels, even if the user
  doesn't explicitly ask for notification system architecture.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Notification System Integration and Event Architecture

Myco's notification system provides user feedback across multiple domains (daemon processes, vault intelligence, symbiont capture, UI operations) through coordinated database persistence, event emission, and multi-modal delivery. This skill covers the complete implementation stack from database schema to browser APIs to React components.

## Prerequisites

- Understanding of Myco's four-domain architecture (daemon, vault, symbiont, UI)
- Familiarity with SQLite schema patterns and database constraints  
- Knowledge of React state management and component lifecycle
- Access to browser Notification API for push notification implementation
- Understanding of TypeScript interfaces and registry patterns
- Access to `myco.yaml` for notification configuration
- Knowledge of the `notify()` function API for emission

## Procedure A: Notification Schema Design and Database Integration

Create notification tables with proper constraints and nullable project scoping:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  project_id TEXT,  -- NULL for daemon-scoped notifications
  user_id TEXT,
  status TEXT DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed')),
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER,
  metadata TEXT,  -- JSON payload
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,  -- 'ui_banner', 'browser_push', 'email'
  delivered_at INTEGER DEFAULT (unixepoch()),
  acknowledged_at INTEGER,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
);

-- Auto-cleanup for expired notifications
CREATE TRIGGER cleanup_expired_notifications 
AFTER INSERT ON notifications
BEGIN
  DELETE FROM notifications 
  WHERE expires_at IS NOT NULL AND expires_at < unixepoch();
END;
```

Design consistent event payload structures:

```typescript
interface NotificationEvent {
  type: string;
  title: string;
  message: string;
  projectId?: string;  // Null for daemon notifications
  userId?: string;
  metadata?: Record<string, any>;
  expiresAt?: number;
  deliveryModes: NotificationDeliveryMode[];
}
```

## Procedure B: Domain Registry Wiring and Notification Emission

Register new domains and implement emission points using the domain registry pattern:

1. **Define domain descriptor** in your domain module:
   ```typescript
   import { NotificationDomainDescriptor } from '../notifications/types.js';
   
   export const YOUR_DOMAIN_DESCRIPTOR: NotificationDomainDescriptor = {
     domain: 'your-domain',
     label: 'Your Domain',
     types: [
       { 
         id: 'your-domain.action.success', 
         label: 'Action completed', 
         defaultMode: 'banner', 
         defaultLevel: 'success' 
       },
       { 
         id: 'your-domain.action.error', 
         label: 'Action failed', 
         defaultMode: 'banner', 
         defaultLevel: 'error' 
       }
     ]
   };
   ```

2. **Register domain and emit notifications**:
   ```typescript
   import { register } from '../notifications/registry.js';
   import { notify } from '../notifications/notify.js';
   
   // Register during initialization
   register(YOUR_DOMAIN_DESCRIPTOR);
   
   // Emit in domain logic
   export async function performDomainAction(entityId: string): Promise<void> {
     const vaultDir = getVaultDir();
     
     try {
       // ... perform domain logic
       
       notify(vaultDir, {
         domain: 'your-domain',
         type: 'your-domain.action.success',
         title: 'Action Completed',
         message: `Successfully processed ${entityId}`,
         link: `/domain/${entityId}`,
         metadata: { entityId, timestamp: Date.now() }
       });
     } catch (error) {
       notify(vaultDir, {
         domain: 'your-domain',
         type: 'your-domain.action.error',
         title: 'Action Failed',
         message: error.message,
         level: 'error',
         metadata: { entityId, error: error.message }
       });
       throw error;
     }
   }
   ```

3. **Configure batching and delivery modes** in `myco.yaml`:
   ```yaml
   notifications:
     enabled: true
     modes:
       your-domain.action.error: banner    # Immediate
       your-domain.status.update: summary  # Batched
     levels:
       your-domain.action.success: success
       your-domain.action.error: error
   ```

## Procedure C: Domain Event Emission Point Integration

### Daemon and Agent Task Integration

Integrate emission points at key system boundaries:

```typescript
// Daemon lifecycle events
class DaemonLifecycle {
  async processingComplete(results: ProcessingResults) {
    if (results.newSpores > 0) {
      await this.emitNotification({
        type: 'intelligence_complete',
        title: 'Intelligence Processing Complete',
        message: `Processed ${results.newSpores} new observations`,
        projectId: this.config.projectId,
        metadata: { sporeCount: results.newSpores },
        deliveryModes: ['ui_banner', 'browser_push']
      });
    }
  }
}

// Agent task execution
export async function executeAgentTask(task: AgentTask, vaultDir: string): Promise<TaskResult> {
  try {
    const result = await doExecuteTask(task);
    
    notify(vaultDir, {
      domain: 'agents',
      type: 'agents.task.completed',
      title: `${task.type} Task Completed`,
      message: `Task completed successfully`,
      level: 'success',
      link: `/agents/runs/${result.runId}`,
      metadata: { taskId: task.id, duration: result.duration }
    });
    
    return result;
  } catch (error) {
    notify(vaultDir, {
      domain: 'agents', 
      type: 'agents.task.error',
      title: `${task.type} Task Failed`,
      message: error.message,
      level: 'error',
      metadata: { taskId: task.id, error: error.message }
    });
    throw error;
  }
}
```

### High-Importance Spore and Session Events

```typescript
// Vault intelligence 
class VaultIntelligence {
  async createSpore(sporeData: SporeCreationData) {
    const spore = await this.vault.createSpore(sporeData);
    
    // Emit for high-importance spores
    if (spore.importance >= 7) {
      await this.emitNotification({
        type: 'high_importance_spore',
        title: 'Significant Discovery',
        message: `New ${spore.observationType}: ${spore.content.substring(0, 100)}...`,
        projectId: this.projectId,
        deliveryModes: ['ui_banner', 'browser_push']
      });
    }
    
    return spore;
  }
}

// Session lifecycle
export async function createSession(params: SessionCreateParams, vaultDir: string): Promise<Session> {
  const session = await doCreateSession(params);
  
  notify(vaultDir, {
    domain: 'sessions',
    type: 'sessions.created',
    title: 'New Session Started',
    message: `Session ${session.id.substring(0, 8)} created`,
    level: 'info',
    link: `/sessions/${session.id}`,
    metadata: { sessionId: session.id, agentType: params.agentType }
  });
  
  return session;
}
```

## Procedure D: Browser Notification Patterns and Annoyance Prevention

Implement progressive permission requests and rate limiting:

```typescript
class BrowserNotificationManager {
  private permissionRequested = false;
  private lastRequestTime = 0;
  private readonly REQUEST_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

  async requestPermissionIfNeeded(): Promise<NotificationPermission> {
    const currentPermission = Notification.permission;
    if (currentPermission !== 'default') return currentPermission;
    
    // Avoid rapid permission requests
    const now = Date.now();
    if (this.permissionRequested && (now - this.lastRequestTime) < this.REQUEST_COOLDOWN) {
      return 'default';
    }
    
    this.permissionRequested = true;
    this.lastRequestTime = now;
    return await Notification.requestPermission();
  }

  async showNotificationSafely(title: string, options: NotificationOptions) {
    const permission = await this.requestPermissionIfNeeded();
    if (permission === 'granted') {
      return new Notification(title, {
        ...options,
        tag: options.tag || 'myco-notification',
        requireInteraction: false
      });
    }
    return this.showUIFallback(title, options);
  }
}

class NotificationRateLimiter {
  private readonly recentNotifications = new Map<string, number[]>();
  private readonly MAX_PER_HOUR = 10;
  private readonly MAX_PER_TYPE_PER_HOUR = 3;

  canShowNotification(type: string): boolean {
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);
    
    // Check global and per-type rate limits
    const allRecent = Array.from(this.recentNotifications.values())
      .flat()
      .filter(time => time > hourAgo);
    if (allRecent.length >= this.MAX_PER_HOUR) return false;
    
    const typeRecent = (this.recentNotifications.get(type) || [])
      .filter(time => time > hourAgo);
    return typeRecent.length < this.MAX_PER_TYPE_PER_HOUR;
  }
}
```

## Procedure E: Notification Display Architecture and React State Management

Build notification display components with proper state management:

```tsx
export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [dismissTimers, setDismissTimers] = useState<Map<string, NodeJS.Timeout>>(new Map());

  const addNotification = useCallback((notification: Omit<Notification, 'id'>) => {
    const id = crypto.randomUUID();
    const newNotification = { ...notification, id };
    
    setNotifications(prev => [newNotification, ...prev]);
    
    // Auto-dismiss after delay if configured
    if (notification.autoDismissMs) {
      const timer = setTimeout(() => dismissNotification(id), notification.autoDismissMs);
      setDismissTimers(prev => new Map(prev.set(id, timer)));
    }
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    const timer = dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      setDismissTimers(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [dismissTimers]);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, dismissNotification }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const NotificationBanner: React.FC<{
  notification: Notification;
  onDismiss: () => void;
  onAction?: () => void;
}> = ({ notification, onDismiss, onAction }) => {
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(onDismiss, 300);
  };

  return (
    <div 
      className={`notification-banner ${isVisible ? 'notification-banner--visible' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <div className="notification-banner__content">
        <span className="notification-banner__icon">
          {notification.type === 'skill_generated' ? '🎯' : 'ℹ️'}
        </span>
        <div className="notification-banner__text">
          <h4 className="notification-banner__title">{notification.title}</h4>
          <p className="notification-banner__message">{notification.message}</p>
        </div>
      </div>
      <div className="notification-banner__actions">
        {onAction && <button onClick={onAction}>View</button>}
        <button onClick={handleDismiss}>×</button>
      </div>
    </div>
  );
};
```

## Procedure F: Registry-Driven Notification Configuration

Create configurable notification behavior through type registries:

```typescript
interface NotificationTypeConfig {
  displayName: string;
  defaultDeliveryModes: NotificationDeliveryMode[];
  autoDismissMs?: number;
  priority: 'low' | 'medium' | 'high';
  userConfigurable: boolean;
  template: {
    titleTemplate?: string;
    messageTemplate?: string;
  };
}

export const NOTIFICATION_TYPE_REGISTRY: Record<string, NotificationTypeConfig> = {
  skill_generated: {
    displayName: 'Skill Generated',
    defaultDeliveryModes: ['ui_banner', 'browser_push'],
    autoDismissMs: 10000,
    priority: 'medium',
    userConfigurable: true,
    template: {
      titleTemplate: 'New Skill: {{skillName}}',
      messageTemplate: 'Generated from {{sourceSporeCount}} observations'
    }
  },
  high_importance_spore: {
    displayName: 'Significant Discovery',
    defaultDeliveryModes: ['ui_banner', 'browser_push'],
    priority: 'high',
    userConfigurable: false,
    template: {
      titleTemplate: 'Discovery: {{observationType}}',
      messageTemplate: '{{content}}'
    }
  }
};

class NotificationTemplateEngine {
  private static interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => String(data[key] || match));
  }

  static generateNotificationContent(type: string, baseData: Partial<NotificationEvent>): NotificationEvent {
    const config = NOTIFICATION_TYPE_REGISTRY[type];
    if (!config) throw new Error(`Unknown notification type: ${type}`);

    const metadata = baseData.metadata || {};
    const interpolationData = { ...baseData, ...metadata };

    return {
      type,
      title: config.template.titleTemplate 
        ? this.interpolate(config.template.titleTemplate, interpolationData)
        : baseData.title || config.displayName,
      message: config.template.messageTemplate
        ? this.interpolate(config.template.messageTemplate, interpolationData)
        : baseData.message || '',
      projectId: baseData.projectId,
      userId: baseData.userId,
      metadata,
      deliveryModes: baseData.deliveryModes || config.defaultDeliveryModes
    };
  }
}
```

## Procedure G: Multi-Mode Notification Delivery Coordination

Coordinate notification delivery across multiple channels with priority and fallback:

```typescript
class NotificationDeliveryCoordinator {
  constructor(
    private rateLimiter: NotificationRateLimiter,
    private browserManager: BrowserNotificationManager
  ) {}

  async deliverNotification(event: NotificationEvent): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    
    // Check rate limiting
    if (!this.rateLimiter.canShowNotification(event.type)) {
      return [{ mode: 'rate_limited', success: false, reason: 'Rate limit exceeded' }];
    }
    
    // Attempt delivery through each requested mode
    for (const mode of event.deliveryModes) {
      try {
        await this.deliverToMode(event, mode);
        results.push({ mode, success: true });
        this.rateLimiter.recordNotification(event.type);
      } catch (error) {
        results.push({ mode, success: false, reason: error.message });
      }
    }
    
    // Fallback to UI banner if all modes failed
    if (results.every(r => !r.success) && !event.deliveryModes.includes('ui_banner')) {
      try {
        await this.deliverToMode(event, 'ui_banner');
        results.push({ mode: 'ui_banner_fallback', success: true });
      } catch (error) {
        results.push({ mode: 'ui_banner_fallback', success: false });
      }
    }
    
    return results;
  }

  private async deliverToMode(event: NotificationEvent, mode: string): Promise<void> {
    switch (mode) {
      case 'ui_banner':
        const notificationContext = getNotificationContext();
        notificationContext.addNotification({
          type: event.type,
          title: event.title,
          message: event.message,
          metadata: event.metadata,
          autoDismissMs: NOTIFICATION_TYPE_REGISTRY[event.type]?.autoDismissMs
        });
        break;
      case 'browser_push':
        const notification = await this.browserManager.showNotificationSafely(event.title, {
          body: event.message,
          tag: `myco-${event.type}`,
          data: { type: event.type, metadata: event.metadata }
        });
        if (!notification) throw new Error('Browser notification delivery failed');
        break;
      default:
        throw new Error(`Unknown delivery mode: ${mode}`);
    }
  }
}
```

## Procedure H: Notification Delivery Debugging and Troubleshooting

Debug notification delivery failures and trace flow from emission to display:

```typescript
// Debug wrapper for notify calls
export function debugNotify(
  vaultDir: string | undefined,
  payload: CreateNotificationPayload,
  context?: string
): string | null {
  console.debug(`[Notifications] Emitting from ${context}:`, {
    domain: payload.domain,
    type: payload.type,
    title: payload.title,
    vaultDir: vaultDir ? 'present' : 'undefined'
  });
  
  const id = notify(vaultDir, payload);
  console.debug(`[Notifications] Result:`, { id: id || 'suppressed' });
  return id;
}

// Debug notification flow
export async function debugNotificationFlow(domain: string, type: string): Promise<void> {
  const vaultDir = getVaultDir();
  const id = notify(vaultDir, {
    domain, type,
    title: 'Debug Test Notification',
    message: 'Testing notification system'
  });
  
  if (!id) {
    console.log('Notification suppressed - checking config...');
    const config = await loadMergedConfig(vaultDir);
    console.log('Notifications enabled:', config.notifications?.enabled);
    console.log('Domain registered:', getDomain(domain) ? 'yes' : 'no');
  }
}
```

**Database verification commands**:
```bash
# Check recent notifications
sqlite3 .myco/vault.db "SELECT domain, type, title, created_at FROM notifications ORDER BY created_at DESC LIMIT 10;"

# Debug WebSocket delivery
curl http://localhost:20915/api/status | jq '.websocket'
curl http://localhost:20915/api/notifications | jq '.data | length'
```

## Cross-Cutting Gotchas

**Emission Point Timing**: Call `notify()` AFTER core operations succeed, not before. Failed operations shouldn't generate success notifications, but always emit error notifications in catch blocks.

**VaultDir Resolution**: Always pass correct `vaultDir` to `notify()`. Use `getVaultDir()` or undefined for no-op behavior. Never hardcode vault paths.

**Registry Timing**: Register notification domains during application initialization, not on-demand. Registry must be populated before first `notify()` call.

**Browser Permission Timing**: Never request notification permissions on page load without user interaction. Modern browsers block aggressive permission requests permanently.

**Rate Limiting Scope**: Implement rate limiting per notification type AND globally. Type-specific limits prevent spam, global limits prevent system overload.

**Database Transaction Scope**: Wrap notification creation and delivery recording in same transaction to ensure consistency.

**React State Batching**: Use React's batching mechanisms when adding multiple notifications rapidly to prevent display flickering.

**Memory Leak Prevention**: Always clear notification timers and event listeners when components unmount.

**Fallback Delivery Chain**: Design delivery modes with clear fallback priorities. If high-priority delivery fails, automatically attempt lower-priority modes rather than losing notifications.