import path from 'node:path';

/**
 * Factory creating an isolated mock Metro `resolveRequest` function and call log.
 */
export function createMockMetroResolver(opts = {}) {
  const calls = [];
  const overrides = opts.overrides ?? {};

  function resolveRequest(context, moduleName, platform) {
    calls.push({ context, moduleName, platform });

    if (Object.prototype.hasOwnProperty.call(overrides, moduleName)) {
      return overrides[moduleName];
    }
    if (moduleName.startsWith('/')) {
      return { type: 'sourceFile', filePath: moduleName };
    }
    if (moduleName.startsWith('.')) {
      const originDir = path.posix.dirname(
        context?.originModulePath ?? '/virtual-app/src/App.tsx',
      );
      const filePath = path.posix.resolve(originDir, moduleName);
      return { type: 'sourceFile', filePath };
    }
    return {
      type: 'sourceFile',
      filePath: `/virtual-app/node_modules/${moduleName}/index.js`,
    };
  }

  function reset() {
    calls.length = 0;
  }

  return { resolveRequest, calls, reset };
}

/**
 * Factory creating an isolated Metro resolution context with its own fallback
 * `context.resolveRequest` for testing Metro chaining when base config omits
 * `config.resolver.resolveRequest`.
 */
export function createMockMetroContext(opts = {}) {
  const {
    originModulePath = '/virtual-app/src/screens/CheckoutScreen.tsx',
    nodeModulesPaths = ['/virtual-app/node_modules'],
    extraNodeModules = {},
    resolveRequest: customResolveRequest,
    resolverOpts,
    ...rest
  } = opts;

  const fallback = createMockMetroResolver(resolverOpts);
  const context = {
    originModulePath,
    nodeModulesPaths: [...nodeModulesPaths],
    extraNodeModules: { ...extraNodeModules },
    resolveRequest: customResolveRequest ?? fallback.resolveRequest,
    ...rest,
  };

  return {
    context,
    contextCalls: fallback.calls,
    resetContextCalls: fallback.reset,
  };
}

/**
 * Factory creating a realistic consuming-app React Native Metro config and
 * an isolated upstream resolver spy.
 */
export function createSampleMetroConfig(opts = {}) {
  const upstream = createMockMetroResolver(opts.resolverOpts);
  const includeUpstreamResolver = opts.includeUpstreamResolver !== false;

  const config = {
    projectRoot: opts.projectRoot ?? '/virtual-app',
    watchFolders: opts.watchFolders ? [...opts.watchFolders] : ['/virtual-app'],
    transformer: {
      getTransformOptions: async () => ({
        transform: {
          experimentalImportSupport: false,
          inlineRequires: true,
        },
      }),
    },
    resolver: {
      sourceExts: [
        'ios.ts',
        'ios.tsx',
        'ts',
        'tsx',
        'ios.js',
        'js',
        'jsx',
        'json',
        'mjs',
        'cjs',
      ],
      assetExts: [
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'svg',
        'ttf',
        'otf',
      ],
      ...(includeUpstreamResolver ? { resolveRequest: upstream.resolveRequest } : {}),
    },
  };

  return {
    config,
    upstreamCalls: upstream.calls,
    resetUpstreamCalls: upstream.reset,
  };
}

export const SAMPLE_METRO_MODULES = Object.freeze({
  asyncStorage: Object.freeze([
    '@react-native-async-storage/async-storage',
    '@react-native-async-storage/async-storage/lib/module/index',
  ]),
  mmkv: Object.freeze([
    'react-native-mmkv',
    'react-native-mmkv/lib/module/index',
  ]),
  forbiddenWebView: Object.freeze([
    'react-native-webview',
    'react-native-webview/lib/WebView',
  ]),
  passthrough: Object.freeze([
    'react',
    'react-native',
    'zustand',
    'axios',
    '@internal/pos-cart',
  ]),
});
