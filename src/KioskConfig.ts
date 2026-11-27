import { getNativeKioskConfig } from './internal/nativeBridge.js';
import type {
  KioskConfigSpec,
  KioskDeviceConfig,
  KioskEnvironment,
} from './types.js';

const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set<KioskEnvironment>([
  'dev',
  'stage',
  'prod',
]);

function formatInvalidValue(value: unknown): string {
  if (typeof value === 'symbol') {
    return value.toString();
  }
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return typeof value;
    }
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `[@internal/kiosk-host] KioskConfig.getDeviceConfig() expected "${fieldName}" to be a string.`,
    );
  }
  if (value.trim().length === 0) {
    throw new RangeError(
      `[@internal/kiosk-host] KioskConfig.getDeviceConfig() expected "${fieldName}" to be a non-empty string.`,
    );
  }
  return value;
}

function getDeviceConfig(): Readonly<KioskDeviceConfig> {
  const raw: unknown = getNativeKioskConfig().getDeviceConfig();
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(
      '[@internal/kiosk-host] KioskConfig.getDeviceConfig() received a non-object response from native.',
    );
  }

  const record = raw as Record<string, unknown>;
  const storeId = assertNonEmptyString(record['storeId'], 'storeId');
  const kioskId = assertNonEmptyString(record['kioskId'], 'kioskId');
  const terminalId = assertNonEmptyString(record['terminalId'], 'terminalId');
  const envRaw = record['environment'];

  if (typeof envRaw !== 'string' || !VALID_ENVIRONMENTS.has(envRaw)) {
    throw new RangeError(
      `[@internal/kiosk-host] KioskConfig.getDeviceConfig() expected "environment" to be one of 'dev' | 'stage' | 'prod', received ${formatInvalidValue(envRaw)}.`,
    );
  }

  // Strict allowlisted projection & immutability
  return Object.freeze({
    storeId,
    kioskId,
    terminalId,
    environment: envRaw as KioskEnvironment,
  });
}

export const KioskConfig: KioskConfigSpec = Object.freeze({
  getDeviceConfig,
});
