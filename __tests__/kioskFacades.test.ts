import {
  KioskAssociate,
  KioskConfig,
  KioskSession,
  __resetKioskNativeModulesForTesting,
  __setKioskNativeModulesForTesting,
} from '../src/index.js';
import type {
  AssociateProfile,
  KioskDeviceConfig,
  KioskHostConfig,
  SessionEndReason,
} from '../src/index.js';

interface GlobalWithTurboProxy {
  __turboModuleProxy?: (name: string) => unknown;
}

describe('Kiosk TurboModule Facades (KioskAssociate, KioskConfig, KioskSession)', () => {
  const globalHost = globalThis as unknown as GlobalWithTurboProxy;
  let originalTurboProxy: ((name: string) => unknown) | undefined;

  beforeEach(() => {
    originalTurboProxy = globalHost.__turboModuleProxy;
    delete globalHost.__turboModuleProxy;
    __resetKioskNativeModulesForTesting();
  });

  afterEach(() => {
    __resetKioskNativeModulesForTesting();
    if (originalTurboProxy !== undefined) {
      globalHost.__turboModuleProxy = originalTurboProxy;
    } else {
      delete globalHost.__turboModuleProxy;
    }
  });

  describe('Singleton immutability & public surface', () => {
    it('exports frozen singletons matching PRD §6 surface without leaking reportFatalError', () => {
      expect(Object.isFrozen(KioskAssociate)).toBe(true);
      expect(Object.isFrozen(KioskConfig)).toBe(true);
      expect(Object.isFrozen(KioskSession)).toBe(true);
      expect('reportFatalError' in KioskSession).toBe(false);

      const sessionIdDesc = Object.getOwnPropertyDescriptor(
        KioskSession,
        'sessionId',
      );
      expect(sessionIdDesc).toBeDefined();
      expect(typeof sessionIdDesc?.get).toBe('function');
      expect(sessionIdDesc?.set).toBeUndefined();
      expect(sessionIdDesc?.enumerable).toBe(true);
      expect(sessionIdDesc?.configurable).toBe(false);

      expect(() => {
        (KioskSession as { sessionId: string }).sessionId = 'tampered';
      }).toThrow(TypeError);
    });

    it('supports full PRD §6 KioskHostConfig type shape', () => {
      const cfg: KioskHostConfig = {
        pfed: {
          issuerUrl: 'https://sso.internal.example',
          authorizationEndpoint: 'https://sso.internal.example/as/authorization.oauth2',
          tokenEndpoint: 'https://sso.internal.example/as/token.oauth2',
          revocationEndpoint: 'https://sso.internal.example/as/revoke_token.oauth2',
          clientId: 'pos-kiosk-client',
          redirectUri: 'kiosk-pos://oauth/callback',
          scopes: ['openid', 'profile', 'pos:transact'],
        },
        timeclock: {
          statusEndpointUrl: 'https://ta.internal.example/api/v1/shift/status',
          deviceBindEndpointUrl: 'https://ta.internal.example/api/v1/device/bind',
          pollIntervalMs: 300_000,
          offlineLogoutThresholdMs: 900_000,
          maxDrainDurationMs: 300_000,
        },
        network: {
          allowedInternalDomains: ['api.internal.example'],
          allowedPublicAssetDomains: ['cdn.public.example'],
          proactiveRefreshBufferSec: 30,
        },
        customerSession: {
          hardIdleTimeoutMs: 60_000,
          maxHoldDurationMs: 90_000,
          crashCircuitBreakerCount: 3,
          crashCircuitBreakerWindowMs: 30_000,
        },
        onHostMetric: (_name, _attrs) => {},
      };
      expect(cfg.customerSession.hardIdleTimeoutMs).toBe(60_000);
    });
  });

  describe('KioskAssociate', () => {
    it('projects only allowlisted fields, strips OAuth tokens, defensively copies arrays, and freezes snapshot', () => {
      const sourceRoles = ['cashier', 'supervisor'];
      const sourcePermissions = ['pos.sell', 'pos.void'];
      const logoutSpy = jest.fn();

      __setKioskNativeModulesForTesting({
        KioskAssociate: {
          getAssociateProfile: () =>
            ({
              associateId: 'assoc-42',
              displayName: 'Ada Lovelace',
              roles: sourceRoles,
              permissions: sourcePermissions,
              storeId: 'store-0104',
              // Hostile extra fields that MUST NEVER leak into JS
              accessToken: 'eyJ-raw-access-token',
              refreshToken: 'rt-secret-value',
              idToken: 'id-secret-value',
              authorization: 'Bearer top-secret',
            }) as unknown as AssociateProfile,
          requestAssociateLogout: logoutSpy,
        },
      });

      const profile = KioskAssociate.getAssociateProfile();
      expect(profile).toEqual({
        associateId: 'assoc-42',
        displayName: 'Ada Lovelace',
        roles: ['cashier', 'supervisor'],
        permissions: ['pos.sell', 'pos.void'],
        storeId: 'store-0104',
      });

      // Zero raw OAuth token exposure
      expect(Object.keys(profile).sort()).toEqual([
        'associateId',
        'displayName',
        'permissions',
        'roles',
        'storeId',
      ]);
      expect('accessToken' in profile).toBe(false);
      expect('refreshToken' in profile).toBe(false);
      expect('idToken' in profile).toBe(false);
      expect('authorization' in profile).toBe(false);

      // Deep immutability & defensive array copies
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.roles)).toBe(true);
      expect(Object.isFrozen(profile.permissions)).toBe(true);
      sourceRoles.push('mutated-later');
      sourcePermissions.pop();
      expect(profile.roles).toEqual(['cashier', 'supervisor']);
      expect(profile.permissions).toEqual(['pos.sell', 'pos.void']);

      expect(() => {
        (profile.roles as string[]).push('hack');
      }).toThrow(TypeError);

      KioskAssociate.requestAssociateLogout();
      expect(logoutSpy).toHaveBeenCalledTimes(1);
    });

    it.each<[string, unknown, ErrorConstructor]>([
      ['null response', null, TypeError],
      ['primitive response', 'bad', TypeError],
      [
        'empty associateId',
        {
          associateId: '   ',
          displayName: 'Ada',
          roles: [],
          permissions: [],
          storeId: 's1',
        },
        RangeError,
      ],
      [
        'non-string displayName',
        {
          associateId: 'a1',
          displayName: 123,
          roles: [],
          permissions: [],
          storeId: 's1',
        },
        TypeError,
      ],
      [
        'empty storeId',
        {
          associateId: 'a1',
          displayName: 'Ada',
          roles: [],
          permissions: [],
          storeId: '',
        },
        RangeError,
      ],
      [
        'non-array roles',
        {
          associateId: 'a1',
          displayName: 'Ada',
          roles: 'cashier',
          permissions: [],
          storeId: 's1',
        },
        TypeError,
      ],
      [
        'non-string permission element',
        {
          associateId: 'a1',
          displayName: 'Ada',
          roles: ['cashier'],
          permissions: ['pos.sell', 42],
          storeId: 's1',
        },
        TypeError,
      ],
    ])(
      'rejects malformed native profile (%s)',
      (_label, badResponse, expectedError) => {
        __setKioskNativeModulesForTesting({
          KioskAssociate: {
            getAssociateProfile: () => badResponse as AssociateProfile,
            requestAssociateLogout: jest.fn(),
          },
        });
        expect(() => KioskAssociate.getAssociateProfile()).toThrow(
          expectedError,
        );
      },
    );
  });

  describe('KioskConfig', () => {
    it.each<KioskDeviceConfig['environment']>(['dev', 'stage', 'prod'])(
      'returns frozen allowlisted device config for environment "%s"',
      (env) => {
        __setKioskNativeModulesForTesting({
          KioskConfig: {
            getDeviceConfig: () =>
              ({
                storeId: 'store-0104',
                kioskId: 'kiosk-07',
                terminalId: 'term-07A',
                environment: env,
                internalSecret: 'must-strip',
              }) as unknown as KioskDeviceConfig,
          },
        });

        const cfg = KioskConfig.getDeviceConfig();
        expect(cfg).toEqual({
          storeId: 'store-0104',
          kioskId: 'kiosk-07',
          terminalId: 'term-07A',
          environment: env,
        });
        expect(Object.isFrozen(cfg)).toBe(true);
        expect('internalSecret' in cfg).toBe(false);
      },
    );

    it.each<[string, unknown, ErrorConstructor]>([
      ['null response', null, TypeError],
      [
        'invalid environment "production"',
        { storeId: 's1', kioskId: 'k1', terminalId: 't1', environment: 'production' },
        RangeError,
      ],
      [
        'uppercase environment "PROD"',
        { storeId: 's1', kioskId: 'k1', terminalId: 't1', environment: 'PROD' },
        RangeError,
      ],
      [
        'blank storeId',
        { storeId: '  ', kioskId: 'k1', terminalId: 't1', environment: 'prod' },
        RangeError,
      ],
      [
        'non-string kioskId',
        { storeId: 's1', kioskId: 7, terminalId: 't1', environment: 'prod' },
        TypeError,
      ],
      [
        'empty terminalId',
        { storeId: 's1', kioskId: 'k1', terminalId: '', environment: 'prod' },
        RangeError,
      ],
    ])(
      'rejects malformed native device config (%s)',
      (_label, badResponse, expectedError) => {
        __setKioskNativeModulesForTesting({
          KioskConfig: {
            getDeviceConfig: () => badResponse as KioskDeviceConfig,
          },
        });
        expect(() => KioskConfig.getDeviceConfig()).toThrow(expectedError);
      },
    );
  });

  describe('KioskSession', () => {
    it('resolves sessionId across full getConstants() / getSessionId() fallback matrix', () => {
      const baseMethods = {
        endSession: jest.fn(),
        setHoldTeardown: jest.fn(),
        notifyActivity: jest.fn(),
      };

      // 1. Only getConstants() present
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => ({ sessionId: 'sess-from-constants' }),
        },
      });
      expect(KioskSession.sessionId).toBe('sess-from-constants');

      // 2. Only getSessionId() present
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getSessionId: () => 'sess-from-method',
        },
      });
      expect(KioskSession.sessionId).toBe('sess-from-method');

      // 3. Both present -> prefers getConstants().sessionId
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => ({ sessionId: 'sess-primary' }),
          getSessionId: () => 'sess-secondary',
        },
      });
      expect(KioskSession.sessionId).toBe('sess-primary');

      // 4. getConstants() returns blank -> falls back to getSessionId()
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => ({ sessionId: '   ' }),
          getSessionId: () => 'sess-fallback-uuid',
        },
      });
      expect(KioskSession.sessionId).toBe('sess-fallback-uuid');

      // 5. Both missing or blank -> throws clear error
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => ({ sessionId: '' }),
          getSessionId: () => '   ',
        },
      });
      expect(() => KioskSession.sessionId).toThrow(/sessionId/);
    });

    it('validates endSession reasons strictly before calling native', () => {
      const endSessionSpy = jest.fn();
      __setKioskNativeModulesForTesting({
        KioskSession: {
          getConstants: () => ({ sessionId: 'sess-1' }),
          endSession: endSessionSpy,
          setHoldTeardown: jest.fn(),
          notifyActivity: jest.fn(),
        },
      });

      const validReasons: SessionEndReason[] = ['COMPLETED', 'CANCELED', 'ERROR'];
      for (const r of validReasons) {
        KioskSession.endSession(r);
      }
      expect(endSessionSpy).toHaveBeenCalledTimes(3);
      expect(endSessionSpy).toHaveBeenNthCalledWith(1, 'COMPLETED');
      expect(endSessionSpy).toHaveBeenNthCalledWith(2, 'CANCELED');
      expect(endSessionSpy).toHaveBeenNthCalledWith(3, 'ERROR');

      endSessionSpy.mockClear();

      for (const invalid of ['CANCELLED', 'completed', '', null, undefined, 123]) {
        expect(() =>
          KioskSession.endSession(invalid as unknown as SessionEndReason),
        ).toThrow(RangeError);
      }
      expect(endSessionSpy).not.toHaveBeenCalled();
    });

    it('validates setHoldTeardown boolean strictly and delegates notifyActivity', () => {
      const holdSpy = jest.fn();
      const activitySpy = jest.fn();
      __setKioskNativeModulesForTesting({
        KioskSession: {
          getConstants: () => ({ sessionId: 'sess-2' }),
          endSession: jest.fn(),
          setHoldTeardown: holdSpy,
          notifyActivity: activitySpy,
        },
      });

      KioskSession.setHoldTeardown(true);
      KioskSession.setHoldTeardown(false);
      expect(holdSpy).toHaveBeenNthCalledWith(1, true);
      expect(holdSpy).toHaveBeenNthCalledWith(2, false);

      holdSpy.mockClear();
      for (const invalid of ['true', 1, 0, null, undefined, {}]) {
        expect(() =>
          KioskSession.setHoldTeardown(invalid as unknown as boolean),
        ).toThrow(TypeError);
      }
      expect(holdSpy).not.toHaveBeenCalled();

      KioskSession.notifyActivity();
      expect(activitySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('globalThis.__turboModuleProxy opaque-box fallback & missing module errors', () => {
    it('resolves all three facades through globalThis.__turboModuleProxy when no test override is set', () => {
      const modules: Record<string, unknown> = {
        KioskAssociate: {
          getAssociateProfile: () => ({
            associateId: 'a-proxy',
            displayName: 'Grace Hopper',
            roles: ['lead'],
            permissions: ['pos.refund'],
            storeId: 's-99',
          }),
          requestAssociateLogout: jest.fn(),
        },
        KioskConfig: {
          getDeviceConfig: () => ({
            storeId: 's-99',
            kioskId: 'k-01',
            terminalId: 't-01',
            environment: 'stage',
          }),
        },
        KioskSession: {
          getConstants: () => ({ sessionId: 'proxy-sess-01' }),
          endSession: jest.fn(),
          setHoldTeardown: jest.fn(),
          notifyActivity: jest.fn(),
        },
      };

      globalHost.__turboModuleProxy = (name: string) => modules[name];

      expect(KioskAssociate.getAssociateProfile().associateId).toBe('a-proxy');
      expect(KioskConfig.getDeviceConfig().environment).toBe('stage');
      expect(KioskSession.sessionId).toBe('proxy-sess-01');
    });

    it('fails loudly with actionable message when neither RN module nor proxy is present', () => {
      expect(() => KioskAssociate.getAssociateProfile()).toThrow(
        /Native TurboModule "KioskAssociate" could not be found/,
      );
      expect(() => KioskConfig.getDeviceConfig()).toThrow(
        /Native TurboModule "KioskConfig" could not be found/,
      );
      expect(() => KioskSession.notifyActivity()).toThrow(
        /Native TurboModule "KioskSession" could not be found/,
      );
    });
  });

  describe('React Native TurboModuleRegistry.getEnforcing Codegen integration', () => {
    afterEach(() => {
      jest.dontMock('react-native');
    });

    it('loads Codegen specs via TurboModuleRegistry.getEnforcing when react-native is available', () => {
      const getEnforcing = jest.fn((name: string) => {
        if (name === 'KioskAssociate') {
          return {
            getAssociateProfile: () => ({
              associateId: 'rn-a1',
              displayName: 'RN Associate',
              roles: ['cashier'],
              permissions: ['pos.sell'],
              storeId: 'rn-s1',
            }),
            requestAssociateLogout: jest.fn(),
          };
        }
        if (name === 'KioskConfig') {
          return {
            getDeviceConfig: () => ({
              storeId: 'rn-s1',
              kioskId: 'rn-k1',
              terminalId: 'rn-t1',
              environment: 'prod',
            }),
          };
        }
        if (name === 'KioskSession') {
          return {
            getConstants: () => ({ sessionId: 'rn-sess-1' }),
            getSessionId: () => 'rn-sess-1',
            endSession: jest.fn(),
            setHoldTeardown: jest.fn(),
            notifyActivity: jest.fn(),
            reportFatalError: jest.fn(),
          };
        }
        throw new Error(`Unexpected module: ${name}`);
      });

      jest.isolateModules(() => {
        jest.doMock(
          'react-native',
          () => ({
            TurboModuleRegistry: {
              get: getEnforcing,
              getEnforcing,
            },
          }),
          { virtual: true },
        );

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../src/index.js') as typeof import('../src/index.js');

        expect(mod.KioskAssociate.getAssociateProfile().associateId).toBe(
          'rn-a1',
        );
        expect(mod.KioskConfig.getDeviceConfig().kioskId).toBe('rn-k1');
        expect(mod.KioskSession.sessionId).toBe('rn-sess-1');
        expect(getEnforcing).toHaveBeenCalledWith('KioskAssociate');
        expect(getEnforcing).toHaveBeenCalledWith('KioskConfig');
        expect(getEnforcing).toHaveBeenCalledWith('KioskSession');
      });
    });

    it('propagates real TurboModuleRegistry.getEnforcing invariant violations instead of swallowing them', () => {
      jest.isolateModules(() => {
        jest.doMock(
          'react-native',
          () => ({
            TurboModuleRegistry: {
              getEnforcing: (name: string) => {
                throw new Error(
                  `Invariant Violation: TurboModuleRegistry.getEnforcing(...): '${name}' could not be found.`,
                );
              },
            },
          }),
          { virtual: true },
        );

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../src/index.js') as typeof import('../src/index.js');
        expect(() => mod.KioskSession.notifyActivity()).toThrow(
          /Invariant Violation: TurboModuleRegistry\.getEnforcing/,
        );
      });
    });
  });

  describe('Iteration 2 hostile input, fallback, and null-override regressions', () => {
    it('throws RangeError (never TypeError or custom toString errors) for null-prototype and throwing-toString values', () => {
      const endSessionSpy = jest.fn();
      __setKioskNativeModulesForTesting({
        KioskSession: {
          getConstants: () => ({ sessionId: 'sess-hostile' }),
          endSession: endSessionSpy,
          setHoldTeardown: jest.fn(),
          notifyActivity: jest.fn(),
        },
      });

      const nullProto = Object.create(null) as unknown;
      const throwingToString = {
        toString() {
          throw new Error('boom-toString');
        },
      };
      const hostileSymbol = Symbol('bad-reason');

      expect(() =>
        KioskSession.endSession(nullProto as unknown as SessionEndReason),
      ).toThrow(RangeError);
      expect(() =>
        KioskSession.endSession(throwingToString as unknown as SessionEndReason),
      ).toThrow(RangeError);
      expect(() =>
        KioskSession.endSession(hostileSymbol as unknown as SessionEndReason),
      ).toThrow(RangeError);
      expect(endSessionSpy).not.toHaveBeenCalled();

      for (const badEnv of [nullProto, throwingToString, hostileSymbol]) {
        __setKioskNativeModulesForTesting({
          KioskConfig: {
            getDeviceConfig: () =>
              ({
                storeId: 's1',
                kioskId: 'k1',
                terminalId: 't1',
                environment: badEnv,
              }) as unknown as KioskDeviceConfig,
          },
        });
        expect(() => KioskConfig.getDeviceConfig()).toThrow(RangeError);
      }
    });

    it('falls back to getSessionId() when getConstants() or its sessionId getter throws', () => {
      const baseMethods = {
        endSession: jest.fn(),
        setHoldTeardown: jest.fn(),
        notifyActivity: jest.fn(),
      };

      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => {
            throw new Error('constants unavailable');
          },
          getSessionId: () => 'fallback-after-throw',
        },
      });
      expect(KioskSession.sessionId).toBe('fallback-after-throw');

      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => ({
            get sessionId(): string {
              throw new Error('getter boom');
            },
          }),
          getSessionId: () => 'fallback-after-getter-throw',
        },
      });
      expect(KioskSession.sessionId).toBe('fallback-after-getter-throw');

      // When getSessionId is absent, getConstants() throw still propagates
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          getConstants: () => {
            throw new Error('no fallback available');
          },
        },
      });
      expect(() => KioskSession.sessionId).toThrow('no fallback available');

      // Throwing property getter for native.getConstants itself falls back cleanly to getSessionId()
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          get getConstants(): () => { sessionId: string } {
            throw new Error('getConstants property getter boom');
          },
          getSessionId: () => 'fallback-after-prop-getter-throw',
        },
      });
      expect(KioskSession.sessionId).toBe('fallback-after-prop-getter-throw');

      // And propagates when getSessionId is absent
      __setKioskNativeModulesForTesting({
        KioskSession: {
          ...baseMethods,
          get getConstants(): () => { sessionId: string } {
            throw new Error('getConstants prop boom no fallback');
          },
        },
      });
      expect(() => KioskSession.sessionId).toThrow(
        'getConstants prop boom no fallback',
      );
    });

    it('ignores null module override entries instead of dereferencing null', () => {
      __setKioskNativeModulesForTesting({
        KioskAssociate: null as unknown as never,
      });

      // Without fallback proxy -> clean missing-module error (not TypeError reading property of null)
      expect(() => KioskAssociate.getAssociateProfile()).toThrow(
        /Native TurboModule "KioskAssociate" could not be found/,
      );

      // With __turboModuleProxy fallback -> resolves cleanly through proxy
      globalHost.__turboModuleProxy = (name: string) => {
        if (name === 'KioskAssociate') {
          return {
            getAssociateProfile: () => ({
              associateId: 'proxy-fallback-id',
              displayName: 'Proxy User',
              roles: ['cashier'],
              permissions: ['pos.sell'],
              storeId: 's-1',
            }),
            requestAssociateLogout: jest.fn(),
          };
        }
        return undefined;
      };
      expect(KioskAssociate.getAssociateProfile().associateId).toBe(
        'proxy-fallback-id',
      );
    });

    it('Iteration 4: prevents Object.prototype pollution from hijacking partial test overrides', () => {
      __setKioskNativeModulesForTesting({
        KioskConfig: {
          getDeviceConfig: () => ({
            storeId: 's-own',
            kioskId: 'k-own',
            terminalId: 't-own',
            environment: 'prod',
          }),
        },
      });

      const protoRecord = Object.prototype as Record<string, unknown>;
      protoRecord['KioskAssociate'] = {
        getAssociateProfile: () => ({
          associateId: 'hijacked-proto',
          displayName: 'Polluted',
          roles: ['admin'],
          permissions: ['all'],
          storeId: 's-bad',
        }),
        requestAssociateLogout: jest.fn(),
      };
      try {
        expect(() => KioskAssociate.getAssociateProfile()).toThrow(
          /Native TurboModule "KioskAssociate" could not be found/,
        );
        expect(KioskConfig.getDeviceConfig().storeId).toBe('s-own');
      } finally {
        delete protoRecord['KioskAssociate'];
      }
    });

    it('Iteration 5: prevents Object.prototype.default pollution from hijacking unwrapDefaultExport', () => {
      const protoRecord = Object.prototype as Record<string, unknown>;
      protoRecord['default'] = {
        getDeviceConfig: () => ({
          storeId: 'hijacked-default',
          kioskId: 'k-bad',
          terminalId: 't-bad',
          environment: 'dev',
        }),
      };
      try {
        jest.isolateModules(() => {
          jest.doMock(
            'react-native',
            () => ({
              TurboModuleRegistry: {
                getEnforcing: (name: string) => {
                  if (name === 'KioskConfig') {
                    return {
                      getDeviceConfig: () => ({
                        storeId: 'real-store',
                        kioskId: 'real-kiosk',
                        terminalId: 'real-term',
                        environment: 'prod',
                      }),
                    };
                  }
                  return null;
                },
              },
            }),
            { virtual: true },
          );
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require('../src/index.js') as typeof import('../src/index.js');
          expect(mod.KioskConfig.getDeviceConfig().storeId).toBe('real-store');
        });
      } finally {
        delete protoRecord['default'];
        jest.dontMock('react-native');
      }
    });
  });
});
