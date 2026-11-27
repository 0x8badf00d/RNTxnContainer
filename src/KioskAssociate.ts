import { getNativeKioskAssociate } from './internal/nativeBridge.js';
import type { AssociateProfile, KioskAssociateSpec } from './types.js';

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `[@internal/kiosk-host] KioskAssociate.getAssociateProfile() expected "${fieldName}" to be a string.`,
    );
  }
  if (value.trim().length === 0) {
    throw new RangeError(
      `[@internal/kiosk-host] KioskAssociate.getAssociateProfile() expected "${fieldName}" to be a non-empty string.`,
    );
  }
  return value;
}

function assertStringArray(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `[@internal/kiosk-host] KioskAssociate.getAssociateProfile() expected "${fieldName}" to be an array of strings.`,
    );
  }
  const copy: string[] = new Array<string>(value.length);
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') {
      throw new TypeError(
        `[@internal/kiosk-host] KioskAssociate.getAssociateProfile() expected "${fieldName}[${i}]" to be a string.`,
      );
    }
    copy[i] = item;
  }
  return Object.freeze(copy);
}

function getAssociateProfile(): Readonly<AssociateProfile> {
  const raw: unknown = getNativeKioskAssociate().getAssociateProfile();
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(
      '[@internal/kiosk-host] KioskAssociate.getAssociateProfile() received a non-object response from native.',
    );
  }

  const record = raw as Record<string, unknown>;
  const associateId = assertNonEmptyString(record['associateId'], 'associateId');
  const displayName = record['displayName'];
  if (typeof displayName !== 'string') {
    throw new TypeError(
      '[@internal/kiosk-host] KioskAssociate.getAssociateProfile() expected "displayName" to be a string.',
    );
  }
  const storeId = assertNonEmptyString(record['storeId'], 'storeId');
  const roles = assertStringArray(record['roles'], 'roles');
  const permissions = assertStringArray(record['permissions'], 'permissions');

  // Strict allowlisted projection: strips any unexpected fields (e.g. raw OAuth tokens)
  // and freezes both the returned profile object and nested arrays.
  return Object.freeze({
    associateId,
    displayName,
    roles,
    permissions,
    storeId,
  });
}

function requestAssociateLogout(): void {
  getNativeKioskAssociate().requestAssociateLogout();
}

export const KioskAssociate: KioskAssociateSpec = Object.freeze({
  getAssociateProfile,
  requestAssociateLogout,
});
