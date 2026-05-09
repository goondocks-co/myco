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

## Procedure A: Notification Schema Design and Database Integration

### Database Schema Implementation

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
```

### Event Payload Structure Design

Design consistent event payload structures for different notification types:

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

interface SkillGeneratedEvent extends NotificationEvent {
  type: 'skill_generated';
  metadata: {
    skillName: string;
    candidateId: string;
    sourceSporeCount: number;
  };
}
```

### Database Constraint Patterns

Implement lifecycle constraints to prevent notification data corruption:

```sql
-- Ensure expired notifications are cleaned up
CREATE TRIGGER cleanup_expired_notifications 
AFTER INSERT ON notifications
BEGIN
  DELETE FROM notifications 
  WHERE expires_at IS NOT NULL AND expires_at < unixepoch();
END;
```

## Procedure B: Domain Event Emission Point Integration

### Daemon Domain Event Emission

Integrate notification emission at daemon lifecycle boundaries:

```typescript
class DaemonLifecycle {
  async startDaemon() {
    await this.emitNotification({
      type: 'daemon_started',
      title: 'Myco Daemon Started',
      message: 'Intelligence pipeline is now active',
      projectId: null,  // Daemon-scoped
      deliveryModes: ['ui_banner']
    });
  }

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
```

### Vault Intelligence Domain Integration

Place emission points at vault operation boundaries:

```typescript
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
        metadata: { 
          sporeId: spore.id, 
          importance: spore.importance 
        },
        deliveryModes: ['ui_banner', 'browser_push']
      });
    }
    
    return spore;
  }
}
```

### UI Operation Domain Integration

Emit events for user-initiated operations:

```typescript
class UIOperations {
  async approveSkillCandidate(candidateId: string) {
    const candidate = await this.vault.updateSkillCandidate(candidateId, { 
      status: 'approved' 
    });
    
    await this.emitNotification({
      type: 'skill_candidate_approved',
      title: 'Skill Generation Queued',
      message: `"${candidate.topic}" approved for skill generation`,
      projectId: this.projectId,
      metadata: { candidateId, topic: candidate.topic },
      deliveryModes: ['ui_banner']
    });
  }
}
```

## Procedure C: Browser Notification Patterns and Annoyance Prevention

### Permission Request Flow Implementation

Implement progressive permission requests to avoid notification blocking:

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
    if (this.permissionRequested && 
        (now - this.lastRequestTime) < this.REQUEST_COOLDOWN) {
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
    
    // Fall back to UI banner if permission denied
    return this.showUIFallback(title, options);
  }
}
```

### Rate Limiting Implementation

Implement notification rate limiting to prevent annoyance:

```typescript
class NotificationRateLimiter {
  private readonly recentNotifications = new Map<string, number[]>();
  private readonly MAX_PER_HOUR = 10;
  private readonly MAX_PER_TYPE_PER_HOUR = 3;

  canShowNotification(type: string): boolean {
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);
    
    // Check global rate limit
    const allRecent = Array.from(this.recentNotifications.values())
      .flat()
      .filter(time => time > hourAgo);
    
    if (allRecent.length >= this.MAX_PER_HOUR) return false;
    
    // Check per-type rate limit
    const typeRecent = (this.recentNotifications.get(type) || [])
      .filter(time => time > hourAgo);
    
    return typeRecent.length < this.MAX_PER_TYPE_PER_HOUR;
  }

  recordNotification(type: string) {
    const now = Date.now();
    const existing = this.recentNotifications.get(type) || [];
    existing.push(now);
    this.recentNotifications.set(type, existing);
  }
}
```

## Procedure D: Notification Display Architecture and React State Management

### React Notification Queue Component

Build notification display components with proper state management:

```tsx
export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ 
  children 
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [dismissTimers, setDismissTimers] = useState<Map<string, NodeJS.Timeout>>(
    new Map()
  );

  const addNotification = useCallback((notification: Omit<Notification, 'id'>) => {
    const id = crypto.randomUUID();
    const newNotification = { ...notification, id };
    
    setNotifications(prev => [newNotification, ...prev]);
    
    // Auto-dismiss after delay if configured
    if (notification.autoDismissMs) {
      const timer = setTimeout(() => {
        dismissNotification(id);
      }, notification.autoDismissMs);
      
      setDismissTimers(prev => new Map(prev.set(id, timer)));
    }
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    
    // Clear auto-dismiss timer
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
    <NotificationContext.Provider value={{
      notifications,
      addNotification,
      dismissNotification
    }}>
      {children}
    </NotificationContext.Provider>
  );
};
```

### Notification Banner Component

Implement notification display with interaction patterns:

```tsx
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

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'skill_generated': return '🎯';
      case 'session_completed': return '✅';
      case 'high_importance_spore': return '💡';
      default: return 'ℹ️';
    }
  };

  return (
    <div 
      className={`notification-banner ${isVisible ? 'notification-banner--visible' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <div className="notification-banner__content">
        <span className="notification-banner__icon">
          {getTypeIcon(notification.type)}
        </span>
        <div className="notification-banner__text">
          <h4 className="notification-banner__title">{notification.title}</h4>
          <p className="notification-banner__message">{notification.message}</p>
        </div>
      </div>
      
      <div className="notification-banner__actions">
        {onAction && (
          <button onClick={onAction} aria-label="Take action">View</button>
        )}
        <button onClick={handleDismiss} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
};
```

## Procedure E: Registry-Driven Notification Configuration

### Notification Type Registry Implementation

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
  
  session_completed: {
    displayName: 'Session Captured',
    defaultDeliveryModes: ['ui_banner'],
    autoDismissMs: 8000,
    priority: 'low',
    userConfigurable: true,
    template: {
      titleTemplate: 'Session Complete',
      messageTemplate: '{{sessionTitle}} - {{activityCount}} activities captured'
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
```

### Template-Driven Notification Content

Generate notification content from templates and metadata:

```typescript
class NotificationTemplateEngine {
  private static interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return String(data[key] || match);
    });
  }

  static generateNotificationContent(
    type: string, 
    baseData: Partial<NotificationEvent>
  ): NotificationEvent {
    const config = NOTIFICATION_TYPE_REGISTRY[type];
    if (!config) {
      throw new Error(`Unknown notification type: ${type}`);
    }

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

## Procedure F: Multi-Mode Notification Delivery Coordination

### Delivery Mode Coordination

Coordinate notification delivery across multiple channels with priority and fallback:

```typescript
class NotificationDeliveryCoordinator {
  constructor(
    private preferenceManager: NotificationPreferenceManager,
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
    
    // If all delivery modes failed, try UI banner as fallback
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
        return this.deliverUIBanner(event);
      case 'browser_push':
        return this.deliverBrowserPush(event);
      default:
        throw new Error(`Unknown delivery mode: ${mode}`);
    }
  }

  private async deliverUIBanner(event: NotificationEvent): Promise<void> {
    const notificationContext = getNotificationContext();
    notificationContext.addNotification({
      type: event.type,
      title: event.title,
      message: event.message,
      metadata: event.metadata,
      autoDismissMs: NOTIFICATION_TYPE_REGISTRY[event.type]?.autoDismissMs
    });
  }

  private async deliverBrowserPush(event: NotificationEvent): Promise<void> {
    const notification = await this.browserManager.showNotificationSafely(
      event.title,
      {
        body: event.message,
        tag: `myco-${event.type}`,
        data: { type: event.type, metadata: event.metadata }
      }
    );
    
    if (!notification) {
      throw new Error('Browser notification delivery failed');
    }
  }
}
```

## Cross-Cutting Gotchas

**Database Transaction Scope**: Always wrap notification creation and delivery recording in the same transaction to ensure consistency. If delivery fails after database insert, you'll have orphaned notification records.

**Browser Permission Timing**: Never request notification permissions immediately on page load or without user interaction. Modern browsers block aggressive permission requests, leading to permanent "denied" states.

**React State Update Batching**: When adding multiple notifications rapidly (e.g., batch processing results), use React's batching mechanisms to prevent excessive re-renders that can cause notification display flickering.

**Notification Deduplication**: Use notification `tag` attributes for browser notifications and in-memory deduplication for UI banners to prevent showing identical notifications multiple times during rapid event emission.

**Memory Leak Prevention**: Always clear notification timers and event listeners when components unmount. Browser notifications persist beyond component lifecycle and can accumulate event handlers.

**Rate Limiting Scope**: Implement rate limiting per notification type AND globally. Type-specific limits prevent spam of particular events, while global limits prevent notification overload during system issues.

**Fallback Delivery Chain**: Design delivery modes with clear fallback priorities. If high-priority delivery (browser push) fails, automatically attempt lower-priority modes (UI banner) rather than losing the notification entirely.