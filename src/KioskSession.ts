import { getNativeKioskSession } from './internal/nativeBridge.js';
import type { KioskSessionSpec, SessionEndReason } from './types.js';

const VALID_SESSION_END_REASONS: ReadonlySet<string> = new Set<SessionEndReason>([
  'COMPLETED',
  'CANCELED',
  'ERROR',
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

function readSessionId(): string {
  const native = getNativeKioskSession();
  let constantsError: unknown;
  let hasConstantsError = false;

  try {
    const getConstantsFn = native.getConstants;
    if (typeof getConstantsFn === 'function') {
      const constants: unknown = getConstantsFn.call(native);
      if (constants !== null && typeof constants === 'object') {
        const id = (constants as { sessionId?: unknown }).sessionId;
        if (typeof id === 'string' && id.trim().length > 0) {
          return id;
        }
      }
    }
  } catch (error) {
    constantsError = error;
    hasConstantsError = true;
  }

  if (typeof native.getSessionId === 'function') {
    const id: unknown = native.getSessionId();
    if (typeof id === 'string' && id.trim().length > 0) {
      return id;
    }
  } else if (hasConstantsError) {
    throw constantsError;
  }

  throw new Error(
    '[@internal/kiosk-host] NativeKioskSession did not return a valid non-empty sessionId.',
  );
}

function endSession(reason: SessionEndReason): void {
  if (typeof reason !== 'string' || !VALID_SESSION_END_REASONS.has(reason)) {
    throw new RangeError(
      `[@internal/kiosk-host] KioskSession.endSession() expected reason to be one of 'COMPLETED' | 'CANCELED' | 'ERROR', received ${formatInvalidValue(reason)}.`,
    );
  }
  getNativeKioskSession().endSession(reason);
}

function setHoldTeardown(active: boolean): void {
  if (typeof active !== 'boolean') {
    throw new TypeError(
      `[@internal/kiosk-host] KioskSession.setHoldTeardown() expected a boolean, received ${typeof active}.`,
    );
  }
  getNativeKioskSession().setHoldTeardown(active);
}

function notifyActivity(): void {
  getNativeKioskSession().notifyActivity();
}

export const KioskSession: KioskSessionSpec = Object.freeze({
  get sessionId(): string {
    return readSessionId();
  },
  endSession,
  setHoldTeardown,
  notifyActivity,
});
