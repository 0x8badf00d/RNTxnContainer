export interface KioskHostConfig {
  pfed: {
    issuerUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
  };
  timeclock: {
    statusEndpointUrl: string;
    deviceBindEndpointUrl?: string;
    pollIntervalMs: number;
    offlineLogoutThresholdMs: number;
    maxDrainDurationMs: number;
  };
  network: {
    allowedInternalDomains: string[];
    allowedPublicAssetDomains: string[];
    proactiveRefreshBufferSec: number;
  };
  customerSession: {
    hardIdleTimeoutMs: number;
    maxHoldDurationMs: number;
    crashCircuitBreakerCount: number;
    crashCircuitBreakerWindowMs: number;
  };
  onHostMetric?: (
    name: string,
    attributes: Record<string, string | number | boolean>,
  ) => void;
}

export type KioskEnvironment = 'dev' | 'stage' | 'prod';

export interface AssociateProfile {
  readonly associateId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly storeId: string;
}

export interface KioskDeviceConfig {
  readonly storeId: string;
  readonly kioskId: string;
  readonly terminalId: string;
  readonly environment: 'dev' | 'stage' | 'prod';
}

export type SessionEndReason = 'COMPLETED' | 'CANCELED' | 'ERROR';

export interface KioskAssociateSpec {
  getAssociateProfile(): Readonly<AssociateProfile>;
  requestAssociateLogout(): void;
}

export interface KioskConfigSpec {
  getDeviceConfig(): Readonly<KioskDeviceConfig>;
}

export interface KioskSessionSpec {
  readonly sessionId: string;
  endSession(reason: SessionEndReason): void;
  setHoldTeardown(active: boolean): void;
  notifyActivity(): void;
}

export interface KioskErrorGuardOptions {
  /** Maximum character length of sanitized error messages sent to native. Default: 512. */
  maxMessageLength?: number;
  /** Invoke previously registered ErrorUtils global handler after reporting to native. Default: false. */
  chainPreviousHandler?: boolean;
}

export interface KioskErrorGuardHandle {
  /** Restores all previously installed global error & unhandled rejection handlers. Idempotent. */
  dispose(): void;
  /** Alias for dispose(). Idempotent. */
  uninstall(): void;
  /** True while this guard installation remains active. */
  isInstalled(): boolean;
}
