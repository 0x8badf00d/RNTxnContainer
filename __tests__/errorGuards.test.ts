import {
  DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  __resetKioskNativeModulesForTesting,
  __setKioskNativeModulesForTesting,
  installKioskErrorGuards,
  sanitizeErrorMessage,
} from '../src/index.js';

interface TestGlobalHooks {
  ErrorUtils?: {
    getGlobalHandler?: () => ((err: unknown, isFatal?: boolean) => void) | undefined;
    setGlobalHandler?: (fn: (err: unknown, isFatal?: boolean) => void) => void;
  };
  HermesInternal?: {
    enablePromiseRejectionTracker?: (opts: {
      allRejections: boolean;
      onUnhandled: (id: number, error: unknown) => void;
      onHandled?: (id: number) => void;
    }) => void;
  };
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void;
  onunhandledrejection?: ((ev: unknown) => void) | null;
}

describe('installKioskErrorGuards & sanitizeErrorMessage', () => {
  const host = globalThis as unknown as TestGlobalHooks;
  let reportFatalError: jest.Mock;
  let endSession: jest.Mock;

  beforeEach(() => {
    reportFatalError = jest.fn();
    endSession = jest.fn();
    __setKioskNativeModulesForTesting({
      KioskSession: {
        getConstants: () => ({ sessionId: 'err-sess-1' }),
        endSession,
        setHoldTeardown: jest.fn(),
        notifyActivity: jest.fn(),
        reportFatalError,
      },
    });
  });

  afterEach(() => {
    delete host.ErrorUtils;
    delete host.HermesInternal;
    delete host.addEventListener;
    delete host.removeEventListener;
    delete host.onunhandledrejection;
    __resetKioskNativeModulesForTesting();
  });

  describe('sanitizeErrorMessage PII & secret redaction', () => {
    it('redacts Authorization headers, Bearer/Basic tokens, JWTs, and secret key-value pairs', () => {
      const sampleJwt =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhc3NvYy0xMjMiLCJlbWFpbCI6InNlY3JldEBleGFtcGxlLmNvbSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const msg = sanitizeErrorMessage(
        new Error(
          `Request failed: Authorization: Bearer superSecretToken123; Basic dXNlcjpwYXNz; jwt=${sampleJwt}; access_token=tok_abc999; refresh_token="rt_secret_val"; client_secret=cs_12345; password=hunter2`,
        ),
      );

      expect(msg).not.toContain('superSecretToken123');
      expect(msg).not.toContain('dXNlcjpwYXNz');
      expect(msg).not.toContain('eyJhbGciOiJSUzI1NiIs');
      expect(msg).not.toContain('tok_abc999');
      expect(msg).not.toContain('rt_secret_val');
      expect(msg).not.toContain('cs_12345');
      expect(msg).not.toContain('hunter2');
      expect(msg).toContain('[REDACTED]');
      expect(msg).toContain('[REDACTED_JWT]');
    });

    it('redacts URL query strings & fragments across HTTPS, custom OAuth schemes, and relative paths', () => {
      const msg = sanitizeErrorMessage(
        'Redirect failed https://sso.example.com/auth?code=AUTH123&state=XYZ#id_token=SECRET and myapp-kiosk://oauth/callback?code=999&nonce=abc and /api/v1/checkout?card=4111',
      );

      expect(msg).toContain('https://sso.example.com/auth?[REDACTED]#[REDACTED]');
      expect(msg).toContain('myapp-kiosk://oauth/callback?[REDACTED]');
      expect(msg).toContain('/api/v1/checkout?[REDACTED]');
      expect(msg).not.toContain('AUTH123');
      expect(msg).not.toContain('999');
      expect(msg).not.toContain('SECRET');
    });

    it('redacts emails, PANs (13-19 digits plain/hyphen/space), SSNs, and phone numbers while preserving UUIDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const numericUuid = '12345678-1234-1234-1234-123456789012';
      const msg = sanitizeErrorMessage(
        `Session ${uuid} corr ${numericUuid} failed for customer jane.doe@shopper.example card 4111-1111-1111-1111 amex 3782 822463 10005 raw 1234567890123 ssn 123-45-6789 phone (555) 867-5309`,
      );

      expect(msg).toContain(uuid);
      expect(msg).toContain(numericUuid);
      expect(msg).toContain('[REDACTED_EMAIL]');
      expect(msg).toContain('[REDACTED_PAN]');
      expect(msg).toContain('[REDACTED_ID]');
      expect(msg).toContain('[REDACTED_PHONE]');
      expect(msg).not.toContain('jane.doe@shopper.example');
      expect(msg).not.toContain('4111-1111-1111-1111');
      expect(msg).not.toContain('3782 822463 10005');
      expect(msg).not.toContain('1234567890123');
      expect(msg).not.toContain('123-45-6789');
      expect(msg).not.toContain('867-5309');
    });

    it('handles hostile throwing getters, symbols, null/undefined, control chars, and strict maxMessageLength', () => {
      const hostile = {};
      Object.defineProperty(hostile, 'message', {
        get() {
          throw new Error('getter explosion');
        },
      });
      Object.defineProperty(hostile, 'toString', {
        value() {
          throw new Error('toString explosion');
        },
      });

      expect(() => sanitizeErrorMessage(hostile)).not.toThrow();
      expect(sanitizeErrorMessage(hostile)).toBe('UnknownError');
      expect(sanitizeErrorMessage(null)).toBe('UnknownError');
      expect(sanitizeErrorMessage(undefined)).toBe('UnknownError');
      expect(sanitizeErrorMessage(Symbol('sym'))).toBe('Symbol(sym)');
      expect(sanitizeErrorMessage('line1\r\n\t\x00line2')).toBe('line1 line2');

      const longMsg = 'A'.repeat(DEFAULT_MAX_ERROR_MESSAGE_LENGTH + 200);
      const clampedDefault = sanitizeErrorMessage(longMsg);
      expect(clampedDefault.length).toBe(DEFAULT_MAX_ERROR_MESSAGE_LENGTH);
      expect(clampedDefault.endsWith('...')).toBe(true);

      const clampedTiny = sanitizeErrorMessage('abcdef', 3);
      expect(clampedTiny).toBe('abc');
      expect(sanitizeErrorMessage('abcdef', 5)).toBe('ab...');
    });
  });

  describe('ErrorUtils, Hermes/Web/Node rejection hooks, idempotency & dispose()', () => {
    it('hooks ErrorUtils, forwards fatal & non-fatal errors, is idempotent, and restores previous handler on dispose()', () => {
      const prevHandler = jest.fn();
      let currentHandler: ((err: unknown, isFatal?: boolean) => void) | undefined =
        prevHandler;

      host.ErrorUtils = {
        getGlobalHandler: () => currentHandler,
        setGlobalHandler: (fn) => {
          currentHandler = fn;
        },
      };

      const handle1 = installKioskErrorGuards({ chainPreviousHandler: true });
      const handle2 = installKioskErrorGuards();
      expect(handle2).toBe(handle1);
      expect(handle1.isInstalled()).toBe(true);
      expect(currentHandler).not.toBe(prevHandler);

      currentHandler!(
        new Error('Crash for bob@example.com with Bearer secretXYZ'),
        true,
      );
      currentHandler!(new Error('Non-fatal warning'), false);

      expect(reportFatalError).toHaveBeenCalledTimes(2);
      expect(reportFatalError).toHaveBeenNthCalledWith(
        1,
        'Error: Crash for [REDACTED_EMAIL] with Bearer [REDACTED]',
        true,
      );
      expect(reportFatalError).toHaveBeenNthCalledWith(
        2,
        'Error: Non-fatal warning',
        false,
      );
      expect(prevHandler).toHaveBeenCalledTimes(2);

      // dispose() restores exact previous handler and is idempotent
      handle1.dispose();
      handle1.uninstall();
      expect(handle1.isInstalled()).toBe(false);
      expect(currentHandler).toBe(prevHandler);

      // Re-installing after dispose works cleanly
      const handle3 = installKioskErrorGuards({ chainPreviousHandler: false });
      expect(handle3).not.toBe(handle1);
      expect(handle3.isInstalled()).toBe(true);
      currentHandler!(new Error('Second install crash'), true);
      expect(reportFatalError).toHaveBeenCalledTimes(3);
      expect(prevHandler).toHaveBeenCalledTimes(2); // chainPreviousHandler is false
      handle3.uninstall();
    });

    it('hooks HermesInternal.enablePromiseRejectionTracker when present and disables it on dispose()', () => {
      const trackerCalls: Array<{
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
      }> = [];
      host.HermesInternal = {
        enablePromiseRejectionTracker: (opts) => {
          trackerCalls.push(opts);
        },
      };

      const handle = installKioskErrorGuards();
      expect(trackerCalls).toHaveLength(1);
      expect(trackerCalls[0]?.allRejections).toBe(true);

      trackerCalls[0]?.onUnhandled(1, new Error('Hermes rejection card 4111111111111111'));
      expect(reportFatalError).toHaveBeenCalledWith(
        'Error: Hermes rejection card [REDACTED_PAN]',
        true,
      );

      handle.dispose();
      expect(trackerCalls).toHaveLength(2);
      expect(trackerCalls[1]?.allRejections).toBe(false);
    });

    it('hooks Web addEventListener/removeEventListener when HermesInternal is absent', () => {
      const listeners = new Map<string, Set<(ev: unknown) => void>>();
      host.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      };
      host.removeEventListener = (type, fn) => {
        listeners.get(type)?.delete(fn);
      };

      const handle = installKioskErrorGuards();
      const set = listeners.get('unhandledrejection');
      expect(set?.size).toBe(1);

      const preventDefault = jest.fn();
      for (const fn of set!) {
        fn({ reason: new Error('Web rejection password=topsecret'), preventDefault });
      }
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(reportFatalError).toHaveBeenCalledWith(
        'Error: Web rejection password=[REDACTED]',
        true,
      );

      handle.dispose();
      expect(listeners.get('unhandledrejection')?.size).toBe(0);
    });

    it('hooks globalThis.onunhandledrejection and Node process unhandledRejection cleanly and restores both', () => {
      // Save Jest's own unhandledRejection listeners while exercising real process.on/off
      const savedNodeListeners = process.listeners('unhandledRejection');
      process.removeAllListeners('unhandledRejection');

      try {
        expect(
          Object.prototype.hasOwnProperty.call(globalThis, 'onunhandledrejection'),
        ).toBe(false);

        const handle = installKioskErrorGuards();
        expect(typeof host.onunhandledrejection).toBe('function');
        expect(process.listenerCount('unhandledRejection')).toBe(1);

        // Trigger globalThis.onunhandledrejection
        host.onunhandledrejection!({
          reason: new Error('Global rejection email=test@example.com'),
        });
        expect(reportFatalError).toHaveBeenCalledWith(
          'Error: Global rejection email=[REDACTED_EMAIL]',
          true,
        );

        // Trigger real Node process unhandledRejection
        process.emit(
          'unhandledRejection',
          new Error('Node rejection Bearer abc123xyz'),
          Promise.resolve(),
        );
        expect(reportFatalError).toHaveBeenCalledWith(
          'Error: Node rejection Bearer [REDACTED]',
          true,
        );

        handle.dispose();
        expect(
          Object.prototype.hasOwnProperty.call(globalThis, 'onunhandledrejection'),
        ).toBe(false);
        expect(process.listenerCount('unhandledRejection')).toBe(0);
      } finally {
        for (const listener of savedNodeListeners) {
          process.on(
            'unhandledRejection',
            listener as NodeJS.UnhandledRejectionListener,
          );
        }
      }
    });

    it('falls back to endSession("ERROR") if reportFatalError is unavailable and NEVER throws even if native throws', () => {
      let currentHandler: ((err: unknown, isFatal?: boolean) => void) | undefined;
      host.ErrorUtils = {
        getGlobalHandler: () => currentHandler,
        setGlobalHandler: (fn) => {
          currentHandler = fn;
        },
      };

      const fallbackEndSession = jest.fn();
      __setKioskNativeModulesForTesting({
        KioskSession: {
          getConstants: () => ({ sessionId: 'fallback-sess' }),
          endSession: fallbackEndSession,
          setHoldTeardown: jest.fn(),
          notifyActivity: jest.fn(),
        },
      });

      const handle = installKioskErrorGuards();
      currentHandler!(new Error('Fatal without reportFatalError'), true);
      expect(fallbackEndSession).toHaveBeenCalledWith('ERROR');

      // Non-fatal should NOT trigger endSession fallback
      fallbackEndSession.mockClear();
      currentHandler!(new Error('Non-fatal'), false);
      expect(fallbackEndSession).not.toHaveBeenCalled();

      // Native throwing inside reportFatalError must NEVER escape global handler
      __setKioskNativeModulesForTesting({
        KioskSession: {
          getConstants: () => ({ sessionId: 'throw-sess' }),
          endSession: jest.fn(),
          setHoldTeardown: jest.fn(),
          notifyActivity: jest.fn(),
          reportFatalError: () => {
            throw new Error('Native bridge crashed');
          },
        },
      });

      expect(() => currentHandler!(new Error('Boom'), true)).not.toThrow();

      // Missing native module completely must also NEVER throw out of handler
      __resetKioskNativeModulesForTesting();
      expect(() => currentHandler!(new Error('Boom2'), true)).not.toThrow();

      handle.dispose();
    });

    it('restores undefined previous ErrorUtils global handler on dispose() and survives throwing setGlobalHandler', () => {
      // 1. Previous handler is undefined -> dispose() must restore back to undefined
      let currentHandler: ((err: unknown, isFatal?: boolean) => void) | undefined =
        undefined;
      const setCalls: Array<unknown> = [];
      host.ErrorUtils = {
        getGlobalHandler: () => currentHandler,
        setGlobalHandler: (fn) => {
          setCalls.push(fn);
          currentHandler = fn;
        },
      };

      const handle = installKioskErrorGuards();
      expect(typeof currentHandler).toBe('function');
      handle.dispose();
      expect(currentHandler).toBeUndefined();
      expect(setCalls).toHaveLength(2);
      expect(setCalls[1]).toBeUndefined();

      // 2. Frozen/throwing ErrorUtils.setGlobalHandler must NOT crash install and must still hook Hermes/Web/Node
      const trackerCalls: Array<{
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
      }> = [];
      host.ErrorUtils = {
        getGlobalHandler: () => {
          throw new Error('ErrorUtils get frozen');
        },
        setGlobalHandler: () => {
          throw new Error('ErrorUtils set frozen');
        },
      };
      host.HermesInternal = {
        enablePromiseRejectionTracker: (opts) => {
          trackerCalls.push(opts);
        },
      };

      let handle2!: ReturnType<typeof installKioskErrorGuards>;
      expect(() => {
        handle2 = installKioskErrorGuards();
      }).not.toThrow();
      expect(handle2.isInstalled()).toBe(true);
      expect(trackerCalls).toHaveLength(1);

      trackerCalls[0]?.onUnhandled(7, new Error('Rejected despite frozen ErrorUtils'));
      expect(reportFatalError).toHaveBeenCalledWith(
        'Error: Rejected despite frozen ErrorUtils',
        true,
      );

      expect(() => handle2.dispose()).not.toThrow();
      expect(trackerCalls).toHaveLength(2);
      expect(trackerCalls[1]?.allRejections).toBe(false);
    });
  });

  describe('Iteration 2 security & ReDoS regression suite', () => {
    it('redacts camelCase/JSON secret keys, quoted Bearer/Basic, JWT edge cases, and opaque RFC 3986 URIs without false positives', () => {
      // 1. CamelCase + JSON-quoted secret keys
      const camelJson = sanitizeErrorMessage(
        'Auth failure: {"accessToken":"acc_secret_val_123","refreshToken":"ref_secret_val_456","idToken":"id_secret_val_789","clientSecret":"cs_secret_val_000","apiKey":"ak_secret_val_111"} refreshToken=raw_rt_1 refreshToken: raw_rt_2',
      );
      for (const leaked of [
        'acc_secret_val_123',
        'ref_secret_val_456',
        'id_secret_val_789',
        'cs_secret_val_000',
        'ak_secret_val_111',
        'raw_rt_1',
        'raw_rt_2',
      ]) {
        expect(camelJson).not.toContain(leaked);
      }
      expect(camelJson).toContain('[REDACTED]');

      // 2. Quoted Authorization / Bearer / Basic credentials
      const quotedCreds = sanitizeErrorMessage(
        `Authorization: Bearer "quotedSecret123" | Authorization: Bearer 'quotedSecret456' | header Bearer "bareQuoted789" | Bearer 'bareQuoted000' | Basic "dXNlcjpwYXNz" | Basic 'YWJjOmRlZg=='`,
      );
      for (const leaked of [
        'quotedSecret123',
        'quotedSecret456',
        'bareQuoted789',
        'bareQuoted000',
        'dXNlcjpwYXNz',
        'YWJjOmRlZg==',
      ]) {
        expect(quotedCreds).not.toContain(leaked);
      }

      // 3. JWT edge cases: padded, short 3rd segment, unsigned (alg: none), hyphen-terminated, long 3-segment
      const paddedJwt =
        'eyJhbGciOiJIUzI1NiJ9=.eyJzdWIiOiIxMjM0NTY3ODkwIn0=.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c=';
      const shortSigJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig';
      const unsignedJwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.';
      const hyphenEndJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc-';
      const genericLong = 'aaaaaaaaaa1.bbbbbbbbbb2.cccccccccc3=';

      expect(sanitizeErrorMessage(`err ${paddedJwt}`)).toBe('err [REDACTED_JWT]');
      expect(sanitizeErrorMessage(`err ${shortSigJwt}`)).toBe('err [REDACTED_JWT]');
      expect(sanitizeErrorMessage(`err ${unsignedJwt} next`)).toBe(
        'err [REDACTED_JWT] next',
      );
      expect(sanitizeErrorMessage(`err ${hyphenEndJwt} done`)).toBe(
        'err [REDACTED_JWT] done',
      );
      expect(sanitizeErrorMessage(`err ${genericLong}`)).toBe('err [REDACTED_JWT]');

      // Non-corruption of normal identifiers and RFC 4122 UUIDs
      const safeIdent =
        'Module foo.bar.baz called KioskSession.endSession for 550e8400-e29b-41d4-a716-446655440000';
      expect(sanitizeErrorMessage(safeIdent)).toBe(safeIdent);

      // 4. Opaque RFC 3986 custom OAuth URIs without '//'
      const opaqueUri = sanitizeErrorMessage(
        'Redirect com.retail.kiosk:callback?code=OPAQUE_SECRET&state=S2 and urn:kiosk:cb#id_token=FRAG_SECRET and uri=com.retail.kiosk:cb?code=EQ_SECRET#f=1',
      );
      expect(opaqueUri).toContain('com.retail.kiosk:callback?[REDACTED]');
      expect(opaqueUri).toContain('urn:kiosk:cb#[REDACTED]');
      expect(opaqueUri).toContain('uri=com.retail.kiosk:cb?[REDACTED]#[REDACTED]');
      expect(opaqueUri).not.toContain('OPAQUE_SECRET');
      expect(opaqueUri).not.toContain('S2');
      expect(opaqueUri).not.toContain('FRAG_SECRET');
      expect(opaqueUri).not.toContain('EQ_SECRET');
    });

    it('never throws on revoked Proxy or Proxy with throwing getPrototypeOf trap', () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      expect(() => sanitizeErrorMessage(revocable.proxy)).not.toThrow();
      expect(sanitizeErrorMessage(revocable.proxy)).toBe('UnknownError');

      const hostileProtoProxy = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('proto-boom');
          },
        },
      );
      expect(() => sanitizeErrorMessage(hostileProtoProxy)).not.toThrow();
      expect(sanitizeErrorMessage(hostileProtoProxy)).toBe('UnknownError');
    });

    it('executes in strictly linear O(N) time (< 50 ms) on 100KB adversarial ReDoS inputs', () => {
      const N = 100_000;
      const payloads: Array<[string, string]> = [
        ['100KB slashes', '/'.repeat(N)],
        ['100KB slashes + query', `${'/'.repeat(N)}?secret=1`],
        ['100KB a- repeats', 'a-'.repeat(N / 2)],
        ['100KB a- + query', `${'a-'.repeat(N / 2)}?k=1`],
        ['100KB a- + hash', `${'a-'.repeat(N / 2)}#k=1`],
        ['100KB a. repeats', 'a.'.repeat(N / 2)],
        ['100KB a. + at-sign', `${'a.'.repeat(N / 2)}@`],
        ['100KB aaaaaaaaaa- repeats', 'aaaaaaaaaa-'.repeat(Math.floor(N / 11))],
        [
          '100KB aaaaaaaaaa- + dot',
          `${'aaaaaaaaaa-'.repeat(Math.floor(N / 11))}.`,
        ],
        ['100KB a@ repeats', 'a@'.repeat(N / 2)],
        ['100KB a@ + a. domain', `a@${'a.'.repeat(N / 2)}`],
        ['100KB Authorization spaces', `Authorization${' '.repeat(N)}:`],
        ['100KB token spaces', `token${' '.repeat(N)}:`],
        [
          '2500 repeated numeric UUIDs',
          '12345678-1234-1234-1234-123456789012 '.repeat(2500),
        ],
      ];

      // Warm up JIT once before measuring
      sanitizeErrorMessage('warmup a-a.a@ /x?y=1');

      for (const [label, payload] of payloads) {
        const start = performance.now();
        const out = sanitizeErrorMessage(payload);
        const elapsedMs = performance.now() - start;
        expect(typeof out).toBe('string');
        expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_ERROR_MESSAGE_LENGTH);
        expect({ label, elapsedMs: elapsedMs < 50 }).toEqual({
          label,
          elapsedMs: true,
        });
      }
    });
  });

  describe('Iteration 3 rejection-hook resilience, escaped-quote/URI/prefixed-key/JWE redaction & ReDoS suite', () => {
    it('never throws out of webRejectionListener or globalThis.onunhandledrejection on revoked Proxy or throwing .reason getter', () => {
      // 1. Web addEventListener('unhandledrejection') path
      const listeners = new Set<(ev: unknown) => void>();
      host.addEventListener = (_type, fn) => {
        listeners.add(fn);
      };
      host.removeEventListener = (_type, fn) => {
        listeners.delete(fn);
      };

      const webHandle = installKioskErrorGuards();
      const [webListener] = Array.from(listeners);
      expect(typeof webListener).toBe('function');

      const rev1 = Proxy.revocable({}, {});
      rev1.revoke();
      expect(() => webListener!(rev1.proxy)).not.toThrow();
      expect(reportFatalError).toHaveBeenLastCalledWith('UnknownError', true);

      const throwingReasonEvt = {
        get reason(): unknown {
          throw new Error('reason-getter-boom');
        },
      };
      expect(() => webListener!(throwingReasonEvt)).not.toThrow();
      expect(reportFatalError).toHaveBeenLastCalledWith('UnknownError', true);

      webHandle.dispose();
      delete host.addEventListener;
      delete host.removeEventListener;

      // 2. globalThis.onunhandledrejection fallback path
      reportFatalError.mockClear();
      const globalHandle = installKioskErrorGuards();
      expect(typeof host.onunhandledrejection).toBe('function');

      const rev2 = Proxy.revocable({}, {});
      rev2.revoke();
      expect(() => host.onunhandledrejection!(rev2.proxy)).not.toThrow();
      expect(reportFatalError).toHaveBeenLastCalledWith('UnknownError', true);

      expect(() => host.onunhandledrejection!(throwingReasonEvt)).not.toThrow();
      expect(reportFatalError).toHaveBeenLastCalledWith('UnknownError', true);

      globalHandle.dispose();
    });

    it('redacts escaped JSON secrets, escaped quotes inside quoted values/Bearer headers, backtick/delimited/multi-= URIs, prefixed keys, and 5-segment JWEs', () => {
      // 1. Escaped JSON-stringified body & escaped Authorization Token
      const escJson = sanitizeErrorMessage(
        'HTTP 500 body="{\\"accessToken\\":\\"ESC_ACC_123\\",\\"refreshToken\\":\\"ESC_REF_456\\",\\"clientSecret\\":\\"ESC_CS_789\\"}"',
      );
      expect(escJson).not.toContain('ESC_ACC_123');
      expect(escJson).not.toContain('ESC_REF_456');
      expect(escJson).not.toContain('ESC_CS_789');

      const escAuth = sanitizeErrorMessage(
        'payload="{\\"Authorization\\":\\"Token ESC_AUTH_TOK_999\\"}"',
      );
      expect(escAuth).not.toContain('ESC_AUTH_TOK_999');
      expect(escAuth).toContain('[REDACTED]');

      // 2. Escaped quotes inside quoted password & Bearer values (plus trailing escaped backslash)
      const escPass = sanitizeErrorMessage(
        '{"password": "pass\\"AFTER_ESC_QUOTE_LEAK"}',
      );
      expect(escPass).toBe('{"password": "[REDACTED]"}');
      expect(escPass).not.toContain('AFTER_ESC_QUOTE_LEAK');

      const trailingBsPass = sanitizeErrorMessage(
        '{"password": "pass\\\\"} next="keep"',
      );
      expect(trailingBsPass).toBe('{"password": "[REDACTED]"} next="keep"');

      const escJsonBearer = sanitizeErrorMessage(
        '{"Authorization": "Bearer \\"BEARER_ESC_SECRET\\""}',
      );
      expect(escJsonBearer).toBe('{"Authorization": "[REDACTED]"}');
      expect(escJsonBearer).not.toContain('BEARER_ESC_SECRET');

      const quotedBearerEsc = sanitizeErrorMessage(
        'Authorization: Bearer "tok\\"LEAKED_BEARER_TAIL"',
      );
      expect(quotedBearerEsc).toBe('Authorization: [REDACTED]');
      expect(quotedBearerEsc).not.toContain('LEAKED_BEARER_TAIL');

      // 3. Backtick-wrapped, comma, markdown-paren, and multi-= URIs + query-internal commas
      const btHttps = sanitizeErrorMessage(
        'Redirect failed for `https://pfed.internal/cb?code=BT_OAUTH_CODE&state=BT_STATE`',
      );
      expect(btHttps).toBe(
        'Redirect failed for `https://pfed.internal/cb?[REDACTED]`',
      );

      const btRel = sanitizeErrorMessage(
        'Fetch failed on `/api/v1/checkout?sessionSecret=REL_BT_SECRET`',
      );
      expect(btRel).toBe('Fetch failed on `/api/v1/checkout?[REDACTED]`');

      const btOpaque = sanitizeErrorMessage(
        'Callback `com.retail.kiosk:callback?code=OPQ_BT_SECRET` failed',
      );
      expect(btOpaque).toBe(
        'Callback `com.retail.kiosk:callback?[REDACTED]` failed',
      );

      const chainUri = sanitizeErrorMessage(
        'step=1&redirect_uri=https://pfed.internal/cb?code=CHAIN_OAUTH_CODE',
      );
      expect(chainUri).toBe(
        'step=1&redirect_uri=https://pfed.internal/cb?[REDACTED]',
      );

      const mdUri = sanitizeErrorMessage(
        'See [callback](https://pfed.internal/cb?code=MD_OAUTH_CODE)',
      );
      expect(mdUri).toBe('See [callback](https://pfed.internal/cb?[REDACTED])');

      const commaUri = sanitizeErrorMessage(
        'failed,https://pfed.internal/cb?code=COMMA_OAUTH_CODE',
      );
      expect(commaUri).toBe('failed,https://pfed.internal/cb?[REDACTED]');

      const commaInsideQuery = sanitizeErrorMessage(
        'https://pfed.internal/cb?scope=openid,profile&code=COMMA_IN_QUERY_SECRET',
      );
      expect(commaInsideQuery).toBe('https://pfed.internal/cb?[REDACTED]');
      expect(commaInsideQuery).not.toContain('COMMA_IN_QUERY_SECRET');

      // Non-URI punctuation preserved untouched
      expect(sanitizeErrorMessage('Question foo?bar and item#42? stayed')).toBe(
        'Question foo?bar and item#42? stayed',
      );

      // 4. Prefixed snake_case, kebab-case & camelCase secret keys
      const prefixed = sanitizeErrorMessage(
        'oauth_access_token=PREF_1 pfed_client_secret=PREF_2 oauth-access-token=PREF_H authToken=PREF_3 userPassword=PREF_4 sessionSecret=PREF_5 myApiKey=PREF_6',
      );
      for (const secret of [
        'PREF_1',
        'PREF_2',
        'PREF_H',
        'PREF_3',
        'PREF_4',
        'PREF_5',
        'PREF_6',
      ]) {
        expect(prefixed).not.toContain(secret);
      }
      expect(prefixed).toBe(
        'oauth_access_token=[REDACTED] pfed_client_secret=[REDACTED] oauth-access-token=[REDACTED] authToken=[REDACTED] userPassword=[REDACTED] sessionSecret=[REDACTED] myApiKey=[REDACTED]',
      );

      // 5. 5-segment JWE tokens (standard RSA-OAEP and direct empty-key dir)
      const rsaJwe =
        'eyJhbGciOiJSU0EtT0FFUCJ9.encryptedKey12345.iv1234567890.ciphertextSecret999.authTag12345';
      const dirJwe =
        'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..iv1234567890.ciphertextDir999.authTagDir123';
      expect(sanitizeErrorMessage(`jwe=${rsaJwe}`)).toBe('jwe=[REDACTED_JWT]');
      expect(sanitizeErrorMessage(`jwe=${dirJwe}`)).toBe('jwe=[REDACTED_JWT]');
    });

    it('executes in strictly linear O(N) time (< 50 ms) on new 100KB escaped-quote, delimiter, and JWE ReDoS payloads', () => {
      const payloads: Array<[string, string]> = [
        ['100KB escaped quotes', '\\"'.repeat(50_000)],
        ['100KB backslashes', '\\'.repeat(100_000)],
        ['100KB password="\\ repeats', 'password="\\'.repeat(10_000)],
        ['100KB Bearer " repeats', 'Bearer "'.repeat(12_000)],
        [
          '100KB Authorization: Bearer \\" repeats',
          'Authorization: Bearer \\"'.repeat(4_000),
        ],
        ['100KB URI delimiter storm', `${'`=,('.repeat(25_000)}?#`],
        ['100KB 4-segment eyJ storm', 'eyJaaaa.bbbb.cccc.'.repeat(5_000)],
        ['100KB camelCase Token spaces', `authToken${' '.repeat(99_990)}:`],
      ];

      sanitizeErrorMessage('warmup password="a\\"b" `https://x/y?z=1`');

      for (const [label, payload] of payloads) {
        const start = performance.now();
        const out = sanitizeErrorMessage(payload);
        const elapsedMs = performance.now() - start;
        expect(typeof out).toBe('string');
        expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_ERROR_MESSAGE_LENGTH);
        expect({ label, elapsedMs: elapsedMs < 50 }).toEqual({
          label,
          elapsedMs: true,
        });
      }
    });

    it('Iteration 4: redacts earlier-?/# multi-segment URIs, colon-prefixed URIs, sentinel-prefixed secrets, ApiKey, 4-seg JWEs, double-stringified quotes, bracket passwords, and handles fractional maxLength', () => {
      // 1. Earlier ? / # before delimiter in same whitespace token
      const uriCases: Array<[string, string[]]> = [
        [
          'See [section#1](https://pfed.internal/cb?code=MD_HASH_SECRET&state=S1)',
          ['MD_HASH_SECRET', 'S1'],
        ],
        [
          'See [why?](https://pfed.internal/cb?code=MD_Q_SECRET&state=S2)',
          ['MD_Q_SECRET', 'S2'],
        ],
        ['retry?(https://pfed.internal/cb?code=PAREN_Q_SECRET)', ['PAREN_Q_SECRET']],
        ['error#500,https://pfed.internal/cb?code=COMMA_HASH_SECRET', ['COMMA_HASH_SECRET']],
        ['ok?,/api/v1/checkout?code=REL_COMMA_SECRET', ['REL_COMMA_SECRET']],
        ['status=ok#1;redirect=https://pfed.internal/cb?code=SEMI_HASH_SECRET', ['SEMI_HASH_SECRET']],
        ['tag=foo#1&redirect_uri=https://pfed.internal/cb?code=AMP_HASH_SECRET', ['AMP_HASH_SECRET']],
        // Colon-prefixed non-scheme URIs
        ['redirect_uri:https://pfed.internal/cb?code=COLON_KEY_SECRET', ['COLON_KEY_SECRET']],
        ['callback_url:/api/v1/checkout?code=COLON_REL_SECRET', ['COLON_REL_SECRET']],
        ['42:https://pfed.internal/cb?code=NUM_COLON_SECRET', ['NUM_COLON_SECRET']],
        ['14:26:30:https://pfed.internal/cb?code=TIME_COLON_SECRET', ['TIME_COLON_SECRET']],
        ['auth_callback:com.retail.kiosk:callback?code=OPQ_COLON_SECRET', ['OPQ_COLON_SECRET']],
        ['err_1:/api/v1/checkout#code=FRAG_COLON_SECRET', ['FRAG_COLON_SECRET']],
      ];
      for (const [input, secrets] of uriCases) {
        const out = sanitizeErrorMessage(input);
        for (const s of secrets) {
          expect(out).not.toContain(s);
        }
        expect(out).toContain('[REDACTED]');
      }

      // Benign non-URIs preserved
      expect(sanitizeErrorMessage('err_1:foo?bar and foo?bar and item#42?')).toBe(
        'err_1:foo?bar and foo?bar and item#42?',
      );

      // 2. Sentinel-prefixed values with trailing secret chars must NOT be skipped
      const sentinelCases: Array<[string, string]> = [
        [
          'access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig123/extraSecretPayload',
          'extraSecretPayload',
        ],
        [
          'access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig123:secretSuffix',
          'secretSuffix',
        ],
        ['password=[REDACTED]REAL_SECRET_PASS', 'REAL_SECRET_PASS'],
        ['token=[REDACTED_JWT]REAL_SECRET_TOK', 'REAL_SECRET_TOK'],
        ['clientSecret=[REDACTED]REAL_CLIENT_SECRET', 'REAL_CLIENT_SECRET'],
      ];
      for (const [input, leaked] of sentinelCases) {
        const out = sanitizeErrorMessage(input);
        expect(out).not.toContain(leaked);
        expect(out).toContain('[REDACTED]');
      }
      // Clean standalone sentinels remain untouched
      expect(sanitizeErrorMessage('access_token=[REDACTED_JWT] ok')).toBe(
        'access_token=[REDACTED_JWT] ok',
      );

      // 3. Fractional maxLength in (0, 1) falls back to DEFAULT_MAX_ERROR_MESSAGE_LENGTH
      expect(sanitizeErrorMessage('abcdefgh', 0.5)).toBe('abcdefgh');

      // 4. ApiKey header, 4-segment eyJ token, double-JSON-stringified quotes, and ']' inside unquoted password
      const apiKeyOut = sanitizeErrorMessage('Authorization: ApiKey RAW_API_KEY_98765');
      expect(apiKeyOut).toBe('Authorization: [REDACTED]');
      expect(apiKeyOut).not.toContain('RAW_API_KEY_98765');

      const fourSegJwe = sanitizeErrorMessage(
        'tok=eyJhbGciOiJSU0EifQ.segTwo1234.segThree1234.segFourSecret',
      );
      expect(fourSegJwe).not.toContain('segFourSecret');

      const doubleStr = JSON.stringify({
        body: JSON.stringify({ error: 'Failed: password="MY_REAL_PASSWORD" Bearer "MY_BEARER_TOK"' }),
      });
      const doubleStrOut = sanitizeErrorMessage(doubleStr);
      expect(doubleStrOut).not.toContain('MY_REAL_PASSWORD');
      expect(doubleStrOut).not.toContain('MY_BEARER_TOK');

      const bracketPass = sanitizeErrorMessage('password=my[secret]TAIL_LEAK_PASS ok');
      expect(bracketPass).toBe('password=[REDACTED] ok');
      expect(sanitizeErrorMessage('[token=abc] ok')).toBe('[token=[REDACTED]] ok');

      // 5. 100KB colon/ampersand/hash ReDoS payloads remain strictly < 50 ms
      const iter4Storms: Array<[string, string]> = [
        ['100KB colon-hash storm', `${'a#1:'.repeat(24_000)}?x=1`],
        ['100KB amp-question storm', `${'k=v?1&'.repeat(16_000)}#y`],
        ['100KB triple-escaped quote storm', 'password=\\\\\\"'.repeat(8_000)],
      ];
      for (const [label, payload] of iter4Storms) {
        const start = performance.now();
        const out = sanitizeErrorMessage(payload);
        const elapsedMs = performance.now() - start;
        expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_ERROR_MESSAGE_LENGTH);
        expect({ label, elapsedMs: elapsedMs < 50 }).toEqual({
          label,
          elapsedMs: true,
        });
      }
    });

    it('Iteration 5: redacts triple-escaped JSON-stringified secrets, Authorization headers, and 7/11/15-backslash inner quotes in O(N) time', () => {
      // 1. Nested 3-level JSON.stringify payload (password, access_token, camelCase, Authorization: ApiKey)
      const nested = JSON.stringify({
        outer: JSON.stringify({
          inner: JSON.stringify({
            password: 'LEAK_PASSWORD',
            access_token: 'LEAK_TOKEN',
            userSecret: 'LEAK_CAMEL',
            Authorization: 'ApiKey LEAK_APIKEY',
          }),
        }),
      });
      const nestedOut = sanitizeErrorMessage(nested, 2000);
      for (const secret of [
        'LEAK_PASSWORD',
        'LEAK_TOKEN',
        'LEAK_CAMEL',
        'LEAK_APIKEY',
      ]) {
        expect(nestedOut).not.toContain(secret);
      }
      expect(nestedOut).toContain('[REDACTED]');

      // 2. Direct triple-escaped Authorization header value
      const directAuth = sanitizeErrorMessage(
        'Authorization: \\\\\\"ApiKey LEAK_AUTH_VAL\\\\\\" trailing=ok',
      );
      expect(directAuth).not.toContain('LEAK_AUTH_VAL');
      expect(directAuth).toBe('Authorization: \\\\\\"[REDACTED]\\\\\\" trailing=ok');

      // 3. 7-backslash inner escaped quote inside triple-escaped value must NOT terminate early
      const innerEsc7 = sanitizeErrorMessage(
        'password=\\\\\\"foo\\\\\\\\\\\\\\"SECRET_TAIL\\\\\\" next=keep',
      );
      expect(innerEsc7).not.toContain('SECRET_TAIL');
      expect(innerEsc7).toBe('password=\\\\\\"[REDACTED]\\\\\\" next=keep');

      // 4. 15-backslash inner escaped quote (15 % 8 === 7) also stays inside value
      const innerEsc15 = sanitizeErrorMessage(
        `password=\\\\\\"foo${'\\'.repeat(15)}"SECRET_15\\\\\\" next=keep`,
      );
      expect(innerEsc15).not.toContain('SECRET_15');
      expect(innerEsc15).toBe('password=\\\\\\"[REDACTED]\\\\\\" next=keep');

      // 5. 11-backslash closing quote (11 % 8 === 3: literal backslash before closing quote) closes cleanly
      const closeBs11 = sanitizeErrorMessage(
        `password=\\\\\\"foo${'\\'.repeat(11)}" next=keep`,
      );
      expect(closeBs11).toBe('password=\\\\\\"[REDACTED]\\\\\\" next=keep');

      // 6. Enclosing Level-2 '\"' (1 or 5 backslashes) and Level-1 '"' (0 or 2 backslashes) stop before enclosing quote
      const enclosingL2 = sanitizeErrorMessage(
        'password=\\\\\\"SECRET_UNCLOSED\\" outside=keep',
      );
      expect(enclosingL2).not.toContain('SECRET_UNCLOSED');
      expect(enclosingL2).toBe('password=\\\\\\"[REDACTED]\\" outside=keep');

      const enclosingL1 = sanitizeErrorMessage(
        'password=\\\\\\"SECRET_L1\\\\" outside=keep',
      );
      expect(enclosingL1).not.toContain('SECRET_L1');
      expect(enclosingL1).toBe('password=\\\\\\"[REDACTED]" outside=keep');

      // 7. 100KB triple-escaped backslash storm stays strictly < 50 ms
      const start = performance.now();
      const stormOut = sanitizeErrorMessage(
        `password=\\\\\\"${'\\'.repeat(99_980)}"`,
      );
      const elapsedMs = performance.now() - start;
      expect(stormOut.length).toBeLessThanOrEqual(
        DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
      );
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});
