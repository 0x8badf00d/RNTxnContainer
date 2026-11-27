import withKioskHostDefault, {
  KIOSK_BLOCKED_MODULES,
  KIOSK_STORAGE_ALIASES,
  createKioskResolveRequest,
  resolveKioskModulePolicy,
  withKioskHost,
} from '../src/metro/withKioskHost.js';
import type {
  MetroDefaultResolutionContext,
  MetroResolution,
  MetroResolveRequest,
} from '../src/metro/withKioskHost.js';

function makeContext(
  delegate: jest.Mock<
    MetroResolution,
    [MetroDefaultResolutionContext, string, string | null]
  >,
  originModulePath = '/app/src/CheckoutScreen.tsx',
): MetroDefaultResolutionContext {
  return {
    originModulePath,
    resolveRequest: delegate,
  };
}

describe('Metro Build Guardrail (withKioskHost & createKioskResolveRequest)', () => {
  it('exports frozen policy maps and identical default/named withKioskHost', () => {
    expect(withKioskHostDefault).toBe(withKioskHost);
    expect(Object.isFrozen(KIOSK_STORAGE_ALIASES)).toBe(true);
    expect(Object.isFrozen(KIOSK_BLOCKED_MODULES)).toBe(true);
    expect(KIOSK_STORAGE_ALIASES).toEqual({
      '@react-native-async-storage/async-storage':
        '@internal/kiosk-host/memory-storage/async-storage',
      'react-native-mmkv': '@internal/kiosk-host/memory-storage/mmkv',
    });
    expect(KIOSK_BLOCKED_MODULES).toEqual(['react-native-webview']);
  });

  it('handles missing/empty/frozen baseConfig and preserves sibling config & resolver fields without mutation', () => {
    const emptyWrapped = withKioskHost();
    expect(typeof emptyWrapped.resolver.resolveRequest).toBe('function');

    const emptyObjWrapped = withKioskHost({});
    expect(typeof emptyObjWrapped.resolver.resolveRequest).toBe('function');

    const baseResolver = Object.freeze({
      sourceExts: ['ts', 'tsx', 'js'],
      unstable_enablePackageExports: true,
    });
    const baseConfig = Object.freeze({
      projectRoot: '/app',
      watchFolders: ['/packages/shared'],
      resolver: baseResolver,
    });

    const wrapped = withKioskHost(baseConfig);
    expect(wrapped).not.toBe(baseConfig);
    expect(wrapped.resolver).not.toBe(baseResolver);
    expect(wrapped.projectRoot).toBe('/app');
    expect(wrapped.watchFolders).toEqual(['/packages/shared']);
    expect(wrapped.resolver.sourceExts).toEqual(['ts', 'tsx', 'js']);
    expect(wrapped.resolver.unstable_enablePackageExports).toBe(true);
    expect(typeof wrapped.resolver.resolveRequest).toBe('function');
  });

  it.each<[string, string]>([
    [
      '@react-native-async-storage/async-storage',
      '@internal/kiosk-host/memory-storage/async-storage',
    ],
    [
      '@react-native-async-storage/async-storage/lib/commonjs/AsyncStorage',
      '@internal/kiosk-host/memory-storage/async-storage',
    ],
    [
      '@react-native-async-storage/async-storage/',
      '@internal/kiosk-host/memory-storage/async-storage',
    ],
    [
      '@react-native-async-storage\\async-storage\\lib\\index.js',
      '@internal/kiosk-host/memory-storage/async-storage',
    ],
    [
      '../../node_modules/@react-native-async-storage/async-storage/index.js',
      '@internal/kiosk-host/memory-storage/async-storage',
    ],
    ['react-native-mmkv', '@internal/kiosk-host/memory-storage/mmkv'],
    [
      'react-native-mmkv/lib/commonjs/MMKV',
      '@internal/kiosk-host/memory-storage/mmkv',
    ],
    ['react-native-mmkv/', '@internal/kiosk-host/memory-storage/mmkv'],
    [
      'react-native-mmkv\\lib\\commonjs\\MMKV',
      '@internal/kiosk-host/memory-storage/mmkv',
    ],
    [
      './node_modules/react-native-mmkv/index.js',
      '@internal/kiosk-host/memory-storage/mmkv',
    ],
    [
      'react-native-mmkv?platform=ios#frag',
      '@internal/kiosk-host/memory-storage/mmkv',
    ],
  ])('aliases "%s" -> "%s"', (inputSpecifier, expectedTarget) => {
    const delegate = jest.fn<
      MetroResolution,
      [MetroDefaultResolutionContext, string, string | null]
    >(() => ({ type: 'sourceFile', filePath: `/resolved/${expectedTarget}.js` }));

    const config = withKioskHost();
    const ctx = makeContext(delegate);
    const res = config.resolver.resolveRequest(ctx, inputSpecifier, 'ios');

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith(ctx, expectedTarget, 'ios');
    expect(res).toEqual({
      type: 'sourceFile',
      filePath: `/resolved/${expectedTarget}.js`,
    });
  });

  it.each<string>([
    'react-native-mmkv-devtools',
    '@react-native-async-storage/async-storage-next',
    'react-native-webview-bridge',
    'react-native-webview-mock',
    './components/react-native-webview-banner',
    './react-native-webview',
    'react',
    '@internal/kiosk-host',
  ])('passes through non-matching module "%s" untouched (zero partial-prefix false positives)', (moduleName) => {
    expect(resolveKioskModulePolicy(moduleName)).toEqual({
      action: 'passthrough',
    });

    const delegate = jest.fn<
      MetroResolution,
      [MetroDefaultResolutionContext, string, string | null]
    >(() => ({ type: 'sourceFile', filePath: `/app/src/safe.js` }));

    const config = withKioskHost();
    const ctx = makeContext(delegate);
    config.resolver.resolveRequest(ctx, moduleName, null);

    expect(delegate).toHaveBeenCalledWith(ctx, moduleName, null);
  });

  it.each<string>([
    'react-native-webview',
    'react-native-webview/lib/WebView',
    'react-native-webview/',
    'react-native-webview\\lib\\WebView',
    'node_modules/react-native-webview',
    '../../node_modules/safe/../react-native-webview',
    '../../node_modules/.pnpm/react-native-webview@13.12.2/node_modules/react-native-webview/index.js',
    'react-native-webview?x=1',
    'react-native-webview#section',
    'safe/../react-native-webview',
  ])('throws hard build error on blocked module variant "%s" BEFORE invoking downstream resolvers', (blockedSpecifier) => {
    const prevResolver = jest.fn();
    const ctxDelegate = jest.fn();
    const config = withKioskHost({
      resolver: { resolveRequest: prevResolver },
    });
    const ctx = makeContext(ctxDelegate, '/app/src/PaymentScreen.tsx');

    expect(() =>
      config.resolver.resolveRequest(ctx, blockedSpecifier, 'ios'),
    ).toThrow(/\[kiosk-host\].*react-native-webview.*PaymentScreen\.tsx/);

    expect(prevResolver).not.toHaveBeenCalled();
    expect(ctxDelegate).not.toHaveBeenCalled();
  });

  it('catches indirect custom-resolver aliases pointing to node_modules/react-native-webview via post-resolution filePath check', () => {
    const prevResolver: MetroResolveRequest = jest.fn(() => ({
      type: 'sourceFile',
      filePath: '/app/node_modules/react-native-webview/lib/index.js',
    }));

    const config = withKioskHost({
      resolver: { resolveRequest: prevResolver },
    });
    const ctx = makeContext(jest.fn(), '/app/src/PromoModal.tsx');

    expect(() => config.resolver.resolveRequest(ctx, 'my-custom-webview', 'ios')).toThrow(
      /\[kiosk-host\].*react-native-webview/,
    );
    expect(prevResolver).toHaveBeenCalledWith(ctx, 'my-custom-webview', 'ios');
  });

  it('chains previousResolveRequest return values & thrown errors, and preserves null platform', () => {
    const customReturn: MetroResolution = { type: 'empty' };
    const prevResolver = jest.fn(() => customReturn);

    const config = withKioskHost({
      resolver: { resolveRequest: prevResolver },
    });
    const ctx = makeContext(jest.fn());

    expect(config.resolver.resolveRequest(ctx, 'react-native-mmkv', null)).toBe(
      customReturn,
    );
    expect(prevResolver).toHaveBeenCalledWith(
      ctx,
      '@internal/kiosk-host/memory-storage/mmkv',
      null,
    );

    const upstreamErr = new Error('Custom resolver failed');
    const throwingConfig = withKioskHost({
      resolver: {
        resolveRequest: () => {
          throw upstreamErr;
        },
      },
    });
    expect(() =>
      throwingConfig.resolver.resolveRequest(ctx, 'lodash', 'ios'),
    ).toThrow(upstreamErr);
  });

  it('is idempotent when double-wrapped and guards against self-referential and cyclic recursion', () => {
    const prevResolver = jest.fn<
      MetroResolution,
      [MetroDefaultResolutionContext, string, string | null]
    >(() => ({ type: 'sourceFile', filePath: '/app/ok.js' }));

    const wrappedOnce = withKioskHost({
      resolver: { resolveRequest: prevResolver },
    });
    const wrappedTwice = withKioskHost(wrappedOnce);

    // Returns fresh config objects while reusing the single branded kiosk resolver
    expect(wrappedTwice).not.toBe(wrappedOnce);
    expect(wrappedTwice.resolver.resolveRequest).toBe(
      wrappedOnce.resolver.resolveRequest,
    );

    const ctx = makeContext(jest.fn());
    wrappedTwice.resolver.resolveRequest(ctx, 'react-native-mmkv', 'ios');
    expect(prevResolver).toHaveBeenCalledTimes(1);

    // Guard 2: Self-referential context.resolveRequest === kioskResolveRequest
    const standalone = createKioskResolveRequest();
    const selfCtx: MetroDefaultResolutionContext = {
      originModulePath: '/app/src/index.ts',
      resolveRequest: standalone,
    };
    expect(() => standalone(selfCtx, 'some-module', 'ios')).toThrow(
      /recursion detected/,
    );

    // Guard 3: Cyclic previousResolveRequest re-entering kiosk resolver with same key
    const fallbackCtxResolver = jest.fn<
      MetroResolution,
      [MetroDefaultResolutionContext, string, string | null]
    >(() => ({ type: 'sourceFile', filePath: '/app/broken-cycle.js' }));

    let kioskFn!: MetroResolveRequest;
    const cyclicPrev: MetroResolveRequest = (c, m, p) => kioskFn(c, m, p);
    kioskFn = createKioskResolveRequest(cyclicPrev);

    const cyclicCtx: MetroDefaultResolutionContext = {
      originModulePath: '/app/src/index.ts',
      resolveRequest: fallbackCtxResolver,
    };
    const res = kioskFn(cyclicCtx, 'cyclic-mod', 'ios');
    expect(res).toEqual({
      type: 'sourceFile',
      filePath: '/app/broken-cycle.js',
    });
    expect(fallbackCtxResolver).toHaveBeenCalledTimes(1);
  });

  it('preserves strict Metro 0.88 CustomResolutionContext & interface config typing without contravariance errors', () => {
    interface CustomMetroContext {
      readonly originModulePath: string;
      readonly allowHaste: boolean;
      readonly extraNodeModules: Record<string, string>;
      readonly resolveRequest: (
        context: CustomMetroContext,
        moduleName: string,
        platform: string | null,
      ) => MetroResolution;
    }

    interface CustomMetroConfig {
      readonly projectRoot: string;
      readonly resolver: {
        readonly sourceExts: readonly string[];
        readonly resolveRequest?: (
          context: CustomMetroContext,
          moduleName: string,
          platform: string | null,
        ) => MetroResolution;
      };
    }

    const customResolver = jest.fn<
      MetroResolution,
      [CustomMetroContext, string, string | null]
    >((ctx, mod) => ({
      type: 'sourceFile',
      filePath: `${ctx.extraNodeModules[mod] ?? mod}.js`,
    }));

    const base: CustomMetroConfig = {
      projectRoot: '/kiosk-app',
      resolver: {
        sourceExts: ['ts', 'tsx'],
        resolveRequest: customResolver,
      },
    };

    const wrapped = withKioskHost(base);
    expect(wrapped.projectRoot).toBe('/kiosk-app');
    expect(wrapped.resolver.sourceExts).toEqual(['ts', 'tsx']);

    const richCtx: CustomMetroContext = {
      originModulePath: '/kiosk-app/App.tsx',
      allowHaste: true,
      extraNodeModules: {
        '@internal/kiosk-host/memory-storage/mmkv': '/kiosk-app/shims/mmkv',
      },
      resolveRequest: customResolver,
    };

    const resolved = wrapped.resolver.resolveRequest(
      richCtx,
      'react-native-mmkv',
      'ios',
    );
    expect(resolved).toEqual({
      type: 'sourceFile',
      filePath: '/kiosk-app/shims/mmkv.js',
    });
  });

  describe('Iteration 2 security, case-insensitivity, recursion & post-resolution regressions', () => {
    it('redirects indirect custom aliases and sibling node_modules relative imports resolving into disk-backed storage', () => {
      const shimPathMmkv =
        '/app/node_modules/@internal/kiosk-host/dist/cjs/memory-storage/mmkvShim.js';
      const shimPathAsync =
        '/app/node_modules/@internal/kiosk-host/dist/cjs/memory-storage/asyncStorageShim.js';

      const prevResolver = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >((_ctx, mod) => {
        if (mod === '@internal/kiosk-host/memory-storage/mmkv') {
          return { type: 'sourceFile', filePath: shimPathMmkv };
        }
        if (mod === '@internal/kiosk-host/memory-storage/async-storage') {
          return { type: 'sourceFile', filePath: shimPathAsync };
        }
        if (mod === 'my-mmkv-alias') {
          return {
            type: 'sourceFile',
            filePath: '/app/node_modules/react-native-mmkv/index.js',
          };
        }
        if (mod === '../react-native-mmkv') {
          return {
            type: 'sourceFile',
            filePath: '/app/node_modules/react-native-mmkv/lib/commonjs/index.js',
          };
        }
        if (mod === 'my-async-storage') {
          return {
            type: 'sourceFile',
            filePath:
              '/app/node_modules/@react-native-async-storage/async-storage/lib/commonjs/index.js',
          };
        }
        if (mod === 'my-mmkv-win') {
          return {
            type: 'sourceFile',
            filePath: 'C:\\app\\node_modules\\react-native-mmkv\\index.js',
          };
        }
        if (mod === 'indirect-dot-mmkv') {
          return {
            type: 'sourceFile',
            filePath: '/app/node_modules/safe/../react-native-mmkv/index.js',
          };
        }
        return { type: 'empty' };
      });

      const config = withKioskHost({
        resolver: { resolveRequest: prevResolver },
      });

      const ctx = makeContext(jest.fn(), '/app/src/Checkout.tsx');
      expect(config.resolver.resolveRequest(ctx, 'my-mmkv-alias', 'ios')).toEqual({
        type: 'sourceFile',
        filePath: shimPathMmkv,
      });
      expect(
        config.resolver.resolveRequest(ctx, 'my-async-storage', 'ios'),
      ).toEqual({
        type: 'sourceFile',
        filePath: shimPathAsync,
      });
      expect(config.resolver.resolveRequest(ctx, 'my-mmkv-win', 'ios')).toEqual({
        type: 'sourceFile',
        filePath: shimPathMmkv,
      });
      expect(
        config.resolver.resolveRequest(ctx, 'indirect-dot-mmkv', 'ios'),
      ).toEqual({
        type: 'sourceFile',
        filePath: shimPathMmkv,
      });

      const siblingCtx = makeContext(
        jest.fn(),
        '/app/node_modules/vendor-sdk/index.js',
      );
      expect(
        config.resolver.resolveRequest(siblingCtx, '../react-native-mmkv', 'ios'),
      ).toEqual({
        type: 'sourceFile',
        filePath: shimPathMmkv,
      });
    });

    it('falls back to context.resolveRequest if previousResolveRequest insists on disk-backed storage, and throws if both still return disk-backed storage', () => {
      const stubbornPrev: MetroResolveRequest = jest.fn(() => ({
        type: 'sourceFile',
        filePath: '/app/node_modules/react-native-mmkv/index.js',
      }));
      const config = withKioskHost({
        resolver: { resolveRequest: stubbornPrev },
      });

      // Fallback context resolver returns the in-memory shim -> succeeds cleanly
      const goodCtxDelegate = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >(() => ({
        type: 'sourceFile',
        filePath: '/app/shims/mmkv.js',
      }));
      const goodCtx = makeContext(goodCtxDelegate);
      expect(config.resolver.resolveRequest(goodCtx, 'my-mmkv', 'ios')).toEqual({
        type: 'sourceFile',
        filePath: '/app/shims/mmkv.js',
      });
      expect(goodCtxDelegate).toHaveBeenCalledWith(
        goodCtx,
        '@internal/kiosk-host/memory-storage/mmkv',
        'ios',
      );

      // Both previousResolveRequest AND context.resolveRequest return disk-backed MMKV -> hard build error!
      const badCtxDelegate = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >(() => ({
        type: 'sourceFile',
        filePath: '/app/node_modules/react-native-mmkv/index.js',
      }));
      const badCtx = makeContext(badCtxDelegate);
      expect(() =>
        config.resolver.resolveRequest(badCtx, 'my-mmkv', 'ios'),
      ).toThrow(/\[kiosk-host\].*Refused to bundle disk-backed storage module/);
    });

    it('enforces post-resolution block and alias policy on assetFiles and virtual resolutions', () => {
      const assetBlockedConfig = withKioskHost({
        resolver: {
          resolveRequest: () => ({
            type: 'assetFiles',
            filePaths: [
              '/repo/assets/ok.png',
              '/repo/node_modules/react-native-webview/assets/icon.png',
            ],
          }),
        },
      });
      expect(() =>
        assetBlockedConfig.resolver.resolveRequest(
          makeContext(jest.fn()),
          'custom-asset',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);

      const virtualBlockedConfig = withKioskHost({
        resolver: {
          resolveRequest: () => ({
            type: 'virtual',
            virtualPath: '/repo/node_modules/react-native-webview/index.js',
            source: 'module.exports = {};',
          }),
        },
      });
      expect(() =>
        virtualBlockedConfig.resolver.resolveRequest(
          makeContext(jest.fn()),
          'custom-virtual',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);

      const virtualAliasedConfig = withKioskHost({
        resolver: {
          resolveRequest: (_ctx, mod) =>
            mod === '@internal/kiosk-host/memory-storage/mmkv'
              ? { type: 'sourceFile', filePath: '/repo/shims/mmkv.js' }
              : {
                  type: 'virtual',
                  virtualPath: '/repo/node_modules/react-native-mmkv/index.js',
                  source: 'module.exports = {};',
                },
        },
      });
      expect(
        virtualAliasedConfig.resolver.resolveRequest(
          makeContext(jest.fn()),
          'custom-virtual-mmkv',
          'ios',
        ),
      ).toEqual({
        type: 'sourceFile',
        filePath: '/repo/shims/mmkv.js',
      });
    });

    it('matches blocked and aliased packages case-insensitively (macOS APFS & Windows NTFS)', () => {
      const blockedCases = [
        'React-Native-WebView',
        'REACT-NATIVE-WEBVIEW/lib/WebView.ios.js',
        '../../NODE_MODULES/react-native-webview',
        '../../node_modules/React-Native-WebView/index.js',
        '/Users/dev/app/node_modules/React-Native-WebView/lib/index.js',
        'C:\\repo\\NODE_MODULES\\react-native-webview\\index.js',
      ];
      for (const spec of blockedCases) {
        expect(resolveKioskModulePolicy(spec)).toEqual({
          action: 'block',
          blockedPackage: 'react-native-webview',
        });
      }

      expect(resolveKioskModulePolicy('React-Native-MMKV')).toEqual({
        action: 'alias',
        matchedPackage: 'react-native-mmkv',
        targetModuleName: '@internal/kiosk-host/memory-storage/mmkv',
      });
      expect(
        resolveKioskModulePolicy('@React-Native-Async-Storage/Async-Storage'),
      ).toEqual({
        action: 'alias',
        matchedPackage: '@react-native-async-storage/async-storage',
        targetModuleName: '@internal/kiosk-host/memory-storage/async-storage',
      });
      expect(
        resolveKioskModulePolicy('../../NODE_MODULES/react-native-mmkv'),
      ).toEqual({
        action: 'alias',
        matchedPackage: 'react-native-mmkv',
        targetModuleName: '@internal/kiosk-host/memory-storage/mmkv',
      });

      // Mixed-case post-resolution sourceFile also blocked
      const mixedCaseConfig = withKioskHost({
        resolver: {
          resolveRequest: () => ({
            type: 'sourceFile',
            filePath:
              '/Users/dev/app/NODE_MODULES/React-Native-WebView/lib/index.js',
          }),
        },
      });
      expect(() =>
        mixedCaseConfig.resolver.resolveRequest(
          makeContext(jest.fn()),
          'alias-webview',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);
    });

    it('prevents infinite recursion on double re-entry within the same stack frame', () => {
      let kioskFn!: MetroResolveRequest;
      let prevCalls = 0;
      const fallbackDelegate = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >(() => ({ type: 'empty' }));

      const doubleReentrantPrev: MetroResolveRequest = (c, m, p) => {
        prevCalls += 1;
        if (prevCalls > 10) {
          throw new Error('INFINITE_RECURSION_ABORT');
        }
        kioskFn(c, m, p);
        return kioskFn(c, m, p);
      };

      kioskFn = createKioskResolveRequest(doubleReentrantPrev);
      const ctx = makeContext(fallbackDelegate);
      expect(kioskFn(ctx, 'double-reentry-mod', 'ios')).toEqual({
        type: 'empty',
      });
      expect(prevCalls).toBe(1);
      expect(fallbackDelegate).toHaveBeenCalledTimes(2);
    });

    it('does not false-positive when dot-segments traverse out of a matched package while still catching traversals into it', () => {
      expect(resolveKioskModulePolicy('react-native-mmkv/../lodash')).toEqual({
        action: 'passthrough',
      });
      expect(
        resolveKioskModulePolicy(
          '@react-native-async-storage/async-storage/../other-pkg',
        ),
      ).toEqual({
        action: 'passthrough',
      });
      expect(resolveKioskModulePolicy('react-native-webview/../lodash')).toEqual(
        {
          action: 'passthrough',
        },
      );

      // Traversing inside or back into react-native-webview MUST still block
      expect(
        resolveKioskModulePolicy('react-native-webview/sub/../lib/WebView'),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(resolveKioskModulePolicy('safe/../react-native-webview')).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
    });
  });

  describe('Iteration 3 indirect cyclic wrapper, Step-2 re-entry & Windows drive-letter regressions', () => {
    it('throws deterministic [kiosk-host] recursion error (never RangeError) on indirect cyclic context.resolveRequest wrappers', () => {
      // 1. prev === null with indirect wrapper ctxWrap -> kioskFn
      let kioskNoPrev!: MetroResolveRequest;
      const ctxWrapNoPrev: MetroResolveRequest = (c, m, p) =>
        kioskNoPrev(c, m, p);
      kioskNoPrev = createKioskResolveRequest(null);

      expect(() =>
        kioskNoPrev(
          {
            originModulePath: '/app/src/A.ts',
            resolveRequest: ctxWrapNoPrev,
          },
          'foo',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\] Metro resolveRequest recursion detected/);

      // 2. Mutual cycle: prev -> kiosk -> ctxWrap -> kiosk
      let kioskMutual!: MetroResolveRequest;
      let prevCalls = 0;
      const prevCycle: MetroResolveRequest = (c, m, p) => {
        prevCalls += 1;
        return kioskMutual(c, m, p);
      };
      const ctxWrapMutual: MetroResolveRequest = (c, m, p) =>
        kioskMutual(c, m, p);
      kioskMutual = createKioskResolveRequest(prevCycle);

      expect(() =>
        kioskMutual(
          {
            originModulePath: '/app/src/A.ts',
            resolveRequest: ctxWrapMutual,
          },
          'foo',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\] Metro resolveRequest recursion detected/);
      expect(prevCalls).toBe(1);
    });

    it('throws deterministic [kiosk-host] recursion error on Step-2 post-resolution alias fallback re-entry', () => {
      let kioskStep2!: MetroResolveRequest;
      const stubbornPrev: MetroResolveRequest = () => ({
        type: 'sourceFile',
        filePath: '/app/node_modules/react-native-mmkv/index.js',
      });
      const ctxReenter: MetroResolveRequest = (c, _m, p) =>
        kioskStep2(c, 'my-indirect-mmkv', p);
      kioskStep2 = createKioskResolveRequest(stubbornPrev);

      expect(() =>
        kioskStep2(
          {
            originModulePath: '/app/src/A.ts',
            resolveRequest: ctxReenter,
          },
          'my-indirect-mmkv',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\] Metro resolveRequest recursion detected/);
    });

    it('preserves sequential triple re-entry from previousResolveRequest into non-cyclic context.resolveRequest', () => {
      let kioskFn!: MetroResolveRequest;
      let prevCalls = 0;
      const ctxDelegate = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >(() => ({ type: 'empty' }));

      const tripleReentrantPrev: MetroResolveRequest = (c, m, p) => {
        prevCalls += 1;
        kioskFn(c, m, p);
        kioskFn(c, m, p);
        return kioskFn(c, m, p);
      };

      kioskFn = createKioskResolveRequest(tripleReentrantPrev);
      const ctx = makeContext(ctxDelegate);
      expect(kioskFn(ctx, 'triple-mod', 'ios')).toEqual({ type: 'empty' });
      expect(prevCalls).toBe(1);
      expect(ctxDelegate).toHaveBeenCalledTimes(3);
    });

    it('treats Windows drive-letter absolute paths with .. traversal outside node_modules as passthrough while still blocking node_modules', () => {
      expect(
        resolveKioskModulePolicy('C:\\..\\react-native-webview\\banner.tsx'),
      ).toEqual({
        action: 'passthrough',
      });
      expect(
        resolveKioskModulePolicy('d:/../react-native-mmkv/local.ts'),
      ).toEqual({
        action: 'passthrough',
      });
      expect(
        resolveKioskModulePolicy(
          'C:\\app\\node_modules\\react-native-webview\\index.js',
        ),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(
        resolveKioskModulePolicy(
          'C:\\app\\node_modules\\react-native-mmkv\\index.js',
        ),
      ).toEqual({
        action: 'alias',
        matchedPackage: 'react-native-mmkv',
        targetModuleName: '@internal/kiosk-host/memory-storage/mmkv',
      });
    });
  });

  describe('Iteration 4 Windows extended-length & OS workspace #/? path regressions', () => {
    it('strips Windows extended-length prefixes (\\\\?\\ and \\\\?\\UNC\\) before policy matching', () => {
      expect(
        resolveKioskModulePolicy(
          '\\\\?\\C:\\app\\node_modules\\react-native-webview\\index.js',
        ),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(
        resolveKioskModulePolicy(
          '\\\\?\\UNC\\srv\\share\\node_modules\\react-native-webview\\index.js',
        ),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(
        resolveKioskModulePolicy(
          '\\\\?\\C:\\app\\node_modules\\react-native-mmkv\\index.js',
        ),
      ).toEqual({
        action: 'alias',
        matchedPackage: 'react-native-mmkv',
        targetModuleName: '@internal/kiosk-host/memory-storage/mmkv',
      });
      expect(
        resolveKioskModulePolicy(
          '//?/UNC/srv/share/node_modules/@react-native-async-storage/async-storage/index.js',
        ),
      ).toEqual({
        action: 'alias',
        matchedPackage: '@react-native-async-storage/async-storage',
        targetModuleName: '@internal/kiosk-host/memory-storage/async-storage',
      });
    });

    it('enforces post-resolution blocking and shimming on OS workspace paths containing # or ?', () => {
      const hashWebViewConfig = withKioskHost();
      expect(() =>
        hashWebViewConfig.resolver.resolveRequest(
          makeContext(() => ({
            type: 'sourceFile',
            filePath:
              '/builds/job#42/node_modules/react-native-webview/index.js',
          })),
          './indirect-webview',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);

      const queryWebViewConfig = withKioskHost();
      expect(() =>
        queryWebViewConfig.resolver.resolveRequest(
          makeContext(() => ({
            type: 'sourceFile',
            filePath:
              '/builds/job?1/node_modules/react-native-webview/index.js',
          })),
          './indirect-webview',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);

      const virtualHashConfig = withKioskHost();
      expect(() =>
        virtualHashConfig.resolver.resolveRequest(
          makeContext(() => ({
            type: 'virtual',
            virtualPath:
              '/builds/job#42/node_modules/react-native-webview/v.js',
            source: 'module.exports = {};',
          })),
          './virtual-webview',
          'ios',
        ),
      ).toThrow(/\[kiosk-host\].*react-native-webview/);

      const hashMmkvDelegate = jest.fn<
        MetroResolution,
        [MetroDefaultResolutionContext, string, string | null]
      >((_ctx, mod) =>
        mod === '@internal/kiosk-host/memory-storage/mmkv'
          ? {
              type: 'sourceFile',
              filePath: '/builds/job#42/shims/mmkv.js',
            }
          : {
              type: 'sourceFile',
              filePath: '/builds/job#42/node_modules/react-native-mmkv/index.js',
            },
      );
      const hashMmkvConfig = withKioskHost();
      expect(
        hashMmkvConfig.resolver.resolveRequest(
          makeContext(hashMmkvDelegate),
          './indirect-mmkv',
          'ios',
        ),
      ).toEqual({
        type: 'sourceFile',
        filePath: '/builds/job#42/shims/mmkv.js',
      });

      // Pre-resolution query/hash stripping remains intact
      expect(resolveKioskModulePolicy('react-native-webview?inline')).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
    });

    it('Iteration 5: strips mixed-slash Windows extended-length prefixes (\\\\?/ and //?\\ UNC/drive) before policy matching', () => {
      expect(
        resolveKioskModulePolicy(
          '\\\\?/C:/app/node_modules/react-native-webview/index.js',
        ),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(
        resolveKioskModulePolicy(
          '//?\\C:\\app\\node_modules\\react-native-mmkv\\index.js',
        ),
      ).toEqual({
        action: 'alias',
        matchedPackage: 'react-native-mmkv',
        targetModuleName: '@internal/kiosk-host/memory-storage/mmkv',
      });
      expect(
        resolveKioskModulePolicy(
          '\\\\?/UNC/srv/share/node_modules/react-native-webview/index.js',
        ),
      ).toEqual({
        action: 'block',
        blockedPackage: 'react-native-webview',
      });
      expect(
        resolveKioskModulePolicy(
          '//?\\UNC\\srv\\share\\node_modules\\@react-native-async-storage\\async-storage\\index.js',
        ),
      ).toEqual({
        action: 'alias',
        matchedPackage: '@react-native-async-storage/async-storage',
        targetModuleName: '@internal/kiosk-host/memory-storage/async-storage',
      });
    });
  });
});
