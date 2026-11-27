import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const initialExitCode = process.exitCode;

import {
  CliUsageError,
  LockfileParseError,
  MANDATORY_GRADLE_RULES,
  MANDATORY_PODFILE_RULES,
  STRICT_GRADLE_RULES,
  STRICT_PODFILE_RULES,
  checkGradleLockfileContent,
  checkLockfiles,
  checkPodfileLockContent,
  detectLockfileFormat,
  parseCliArgs,
  runCli,
} from '../scripts/check-kiosk-lockfile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

test('importing scripts/check-kiosk-lockfile.mjs has zero CLI side effects', () => {
  assert.equal(process.exitCode, initialExitCode);
  assert.ok(Object.isFrozen(MANDATORY_PODFILE_RULES));
  assert.ok(Object.isFrozen(STRICT_PODFILE_RULES));
  assert.ok(Object.isFrozen(MANDATORY_GRADLE_RULES));
  assert.ok(Object.isFrozen(STRICT_GRADLE_RULES));
});

test('checkPodfileLockContent handles UTF-8 BOM, CRLF, case-insensitive rules, comments, and DEPENDENCIES deduplication', () => {
  const bomCrlfContent = [
    '\uFEFF# comment mentioning RNCWebView',
    'PODS:',
    '  - KioskHost (1.0.0)',
    '  - mmkv/Core (1.3.9) # inline comment',
    '  - ParentPod (1.0.0):',
    '    - rncasyncstorage (= 2.1.0)',
    '',
    'DEPENDENCIES:',
    '  - MMKV/Core',
    '  - RNCCookies',
    '',
    'SPEC CHECKSUMS:',
    '  op-sqlite: 0000000000000000',
    '',
    'COCOAPODS: 1.15.2',
  ].join('\r\n');

  const res = checkPodfileLockContent(bomCrlfContent, {
    file: 'ios/Podfile.lock',
  });
  assert.equal(res.ok, false);
  assert.equal(res.format, 'podfile.lock');
  assert.deepEqual(
    res.violations.map((v) => ({
      rule: v.matchedRule,
      category: v.category,
      line: v.line,
    })),
    [
      { rule: 'MMKV', category: 'storage', line: 4 },
      { rule: 'RNCAsyncStorage', category: 'storage', line: 6 },
      { rule: 'RNCCookies', category: 'cookies', line: 10 },
    ],
  );
});

test('checkPodfileLockContent throws LockfileParseError when PODS/COCOAPODS header is missing', () => {
  assert.throws(
    () => checkPodfileLockContent('random text\nwithout headers', { file: 'bad.lock' }),
    (err) => err instanceof LockfileParseError,
  );
});

test('checkGradleLockfileContent handles BOM, CRLF, case-insensitive matching, ignores androidx.sqlite:sqlite, and throws on malformed lines', () => {
  const validGradle = [
    '\uFEFF# This is a Gradle generated file for dependency locking.',
    'androidx.sqlite:sqlite:2.4.0=runtimeClasspath',
    'COM.TENCENT:MMKV:1.3.9=runtimeClasspath',
    'empty=annotationProcessor',
  ].join('\r\n');

  const res = checkGradleLockfileContent(validGradle, {
    file: 'android/gradle.lockfile',
  });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].matchedRule, 'com.tencent:mmkv');
  assert.equal(res.violations[0].line, 3);

  assert.throws(
    () => checkGradleLockfileContent('   \n\n  ', { file: 'empty.lockfile' }),
    (err) => err instanceof LockfileParseError,
  );

  assert.throws(
    () => checkGradleLockfileContent('not-valid-gradle-line', { file: 'bad.lockfile' }),
    (err) => err instanceof LockfileParseError,
  );
});

test('detectLockfileFormat detects by filename and by content, throwing LockfileParseError on unknown input', () => {
  assert.equal(detectLockfileFormat('ios/Podfile.lock', ''), 'podfile.lock');
  assert.equal(detectLockfileFormat('android/gradle.lockfile', ''), 'gradle.lockfile');
  assert.equal(detectLockfileFormat('custom.txt', 'PODS:\n  - A (1.0)\n'), 'podfile.lock');
  assert.equal(
    detectLockfileFormat('custom.txt', 'com.example:lib:1.0.0=runtimeClasspath\n'),
    'gradle.lockfile',
  );
  assert.throws(
    () => detectLockfileFormat('unknown.txt', 'hello world'),
    (err) => err instanceof LockfileParseError,
  );
});

test('parseCliArgs, checkLockfiles, and runCli execute cleanly programmatically with custom IO writers', () => {
  assert.throws(() => parseCliArgs([]), (err) => err instanceof CliUsageError);

  const parsed = parseCliArgs([
    '--podfile-lock',
    path.join(FIXTURES_DIR, 'Podfile.clean.lock'),
    '--gradle-lockfile=' + path.join(FIXTURES_DIR, 'gradle.clean.lockfile'),
    '--strict',
    '--json',
  ]);
  assert.equal(parsed.strict, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.targets.length, 2);

  const report = checkLockfiles(parsed.targets, { strict: true });
  assert.equal(report.ok, true);
  assert.equal(report.filesChecked.length, 2);

  let out = '';
  let err = '';
  const code = runCli(
    ['--podfile-lock', path.join(FIXTURES_DIR, 'Podfile.forbidden.lock'), '--json'],
    {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(err, '');
  const json = JSON.parse(out);
  assert.equal(json.ok, false);
  assert.ok(json.violations.length >= 7);
});

test('Iteration 2 regressions: Podfile flow sequences/merge conflicts, strict Gradle comments, whitespace detection, checkLockfiles target validation & rule parity', () => {
  // YAML flow sequence with forbidden pods caught; empty flow sequence allowed; nested/corrupt throws LockfileParseError
  const flowRes = checkPodfileLockContent(
    'PODS: [RNCWebView (13.0.0), MMKV (1.3.9)]\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(flowRes.ok, false);
  assert.deepEqual(
    flowRes.violations.map((v) => v.matchedRule),
    ['RNCWebView', 'MMKV'],
  );

  const emptyFlow = checkPodfileLockContent('PODS: []\nCOCOAPODS: 1.15.2\n');
  assert.equal(emptyFlow.ok, true);

  assert.throws(
    () =>
      checkPodfileLockContent(
        'PODS: [{KioskHost (1.0.0): [MMKV (1.3.9)]}]\nCOCOAPODS: 1.15.2\n',
      ),
    (err) => err instanceof LockfileParseError,
  );
  assert.throws(
    () =>
      checkPodfileLockContent(
        'PODS:\n  - KioskHost (1.0.0)\n<<<<<<< HEAD\n  - Airship (1.0)\n=======\n>>>>>>> main\n',
      ),
    (err) => err instanceof LockfileParseError,
  );
  assert.throws(
    () => checkPodfileLockContent('PODS:\nRNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n'),
    (err) => err instanceof LockfileParseError,
  );

  // Arbitrary comment-only file rejected by checkGradleLockfileContent
  assert.throws(
    () =>
      checkGradleLockfileContent('#!/bin/bash\n# just a comment\n', {
        file: 'comment-only.lockfile',
      }),
    (err) => err instanceof LockfileParseError,
  );

  // Canonical Gradle header comment alone is still valid
  const canonicalHeaderOnly = checkGradleLockfileContent(
    '# This is a Gradle generated file for dependency locking.\n',
  );
  assert.equal(canonicalHeaderOnly.ok, true);

  // Leading-whitespace Gradle coordinate auto-detects cleanly
  assert.equal(
    detectLockfileFormat(
      'leading-ws.txt',
      '  com.tencent:mmkv:1.3.9=compileClasspath\n',
    ),
    'gradle.lockfile',
  );

  // checkLockfiles validates invalid targets with CliUsageError (not unhandled TypeError)
  for (const badTarget of [null, undefined, {}, { path: '' }, '   ']) {
    assert.throws(
      () => checkLockfiles([badTarget]),
      (err) => err instanceof CliUsageError,
    );
  }

  // Rule parity: @op-engineering/op-sqlite & io.github.react-native-async-storage:async-storage
  const podOp = checkPodfileLockContent(
    'PODS:\n  - @op-engineering/op-sqlite/Core (7.0.0)\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(podOp.ok, false);
  assert.equal(podOp.violations[0].matchedRule, '@op-engineering/op-sqlite');

  const gradleIo = checkGradleLockfileContent(
    'io.github.react-native-async-storage:async-storage:2.1.0=runtimeClasspath\n',
  );
  assert.equal(gradleIo.ok, false);
  assert.equal(
    gradleIo.violations[0].matchedRule,
    'io.github.react-native-async-storage:async-storage',
  );
});

test('Iteration 3 regressions: inline YAML dependency mappings, unsupported constructs, escaped-backslash comments, diff3/mixed/pre-header rejection & Gradle header auto-detect', () => {
  // Inline YAML flow dependency mappings catch forbidden parents & children
  const inlineChild = checkPodfileLockContent(
    'PODS:\n  - SafeParent (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(inlineChild.ok, false);
  assert.deepEqual(
    inlineChild.violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );

  const inlineParent = checkPodfileLockContent(
    'PODS:\n  - "RNCWebView": [React-Core]\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(inlineParent.ok, false);
  assert.deepEqual(
    inlineParent.violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );

  // Unsupported YAML constructs, diff3/indented conflict markers, mixed flow+block, and pre-header garbage fail closed
  const malformedInputs = [
    'PODS:\n  - - RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - &w RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - !!str RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - {RNCWebView: [React-Core]}\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - SafeParent (1.0.0): RNCWebView\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - SafePod (1.0.0)\nSPEC CHECKSUMS:\n||||||| base\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - SafePod (1.0.0)\nSPEC CHECKSUMS:\n  <<<<<<< HEAD\nCOCOAPODS: 1.15.2\n',
    'PODS: []\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
    'corrupt garbage {{{\nPODS:\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
  ];
  for (const input of malformedInputs) {
    assert.throws(
      () => checkPodfileLockContent(input),
      (err) => err instanceof LockfileParseError,
    );
  }

  // Escaped backslash before closing quote with inline comment passes cleanly
  const escBs = checkPodfileLockContent(
    'PODS: ["SafePod\\\\"] # comment\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(escBs.ok, true);

  // Aligned Gradle header detection (case-insensitive & flexible whitespace)
  assert.equal(
    detectLockfileFormat(
      'neutral.txt',
      '  #  This is a Gradle generated file for dependency locking.\n',
    ),
    'gradle.lockfile',
  );
});

test('Iteration 4 regressions: column-0 header strictness, YAML scalar-start quotes, explicit keys, digit-first block scalars & double-quoted escapes', () => {
  // Quoted & tabbed headers after COCOAPODS catch forbidden pods
  assert.deepEqual(
    checkPodfileLockContent(
      'COCOAPODS: 1.15.2\n"PODS":\n  - RNCWebView (13.0.0)\n',
    ).violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );
  assert.deepEqual(
    checkPodfileLockContent(
      'COCOAPODS: 1.15.2\nPODS\t:\n  - MMKV (1.3.9)\n',
    ).violations.map((v) => v.matchedRule),
    ['MMKV'],
  );

  // Mid-scalar quotes/backticks do not swallow inline mappings or flow items
  assert.deepEqual(
    checkPodfileLockContent(
      "PODS:\n  - Bob'sPod (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n",
    ).violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );
  assert.deepEqual(
    checkPodfileLockContent(
      "PODS: [SafePod' (1.0.0), RNCWebView (13.0.0), OtherPod' (1.0.0)]\nCOCOAPODS: 1.15.2\n",
    ).violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );
  assert.equal(
    checkPodfileLockContent(
      "PODS: [SafePod' (1.0.0)] # comment\nCOCOAPODS: 1.15.2\n",
    ).ok,
    true,
  );

  // YAML double-quoted escapes decoded cleanly
  const decodedRes = checkPodfileLockContent(
    'PODS:\n  - "\\u0052NCWebView (13.0.0)"\n  - "RNCWebView\\/Core (13.0.0)"\nCOCOAPODS: 1.15.2\n',
  );
  assert.deepEqual(
    decodedRes.violations.map((v) => ({
      rule: v.matchedRule,
      entry: v.entry,
    })),
    [
      { rule: 'RNCWebView', entry: 'RNCWebView (13.0.0)' },
      { rule: 'RNCWebView', entry: 'RNCWebView/Core (13.0.0)' },
    ],
  );

  // Unrecognized column-0 lines, explicit keys, bare colon, flow-mapping space-colon, digit-first block scalars fail closed
  const failClosed = [
    'COCOAPODS: 1.15.2\n!!str PODS:\n  - RNCWebView (13.0.0)\n',
    'COCOAPODS: 1.15.2\ncorrupt garbage {{{\n',
    'PODS:\n  - ? RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - :\nCOCOAPODS: 1.15.2\n',
    'PODS: ["RNCWebView" :React-Core]\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - |2-\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - "\\uZZZZ (1.0.0)"\nCOCOAPODS: 1.15.2\n',
  ];
  for (const input of failClosed) {
    assert.throws(
      () => checkPodfileLockContent(input),
      (err) => err instanceof LockfileParseError,
    );
  }
});

test('Iteration 5 regressions: paired backtick mapping colon, strict quoted scalar validation & O(N) headerMatch', () => {
  // Paired backticks must NOT hide ': ' in inline mappings
  const btRes = checkPodfileLockContent(
    'PODS:\n  - SafePod` (1.0.0): [RNCWebView (13.0.0), OtherPod` (1.0.0)]\nCOCOAPODS: 1.15.2\n',
  );
  assert.equal(btRes.ok, false);
  assert.deepEqual(
    btRes.violations.map((v) => v.matchedRule),
    ['RNCWebView'],
  );

  // Multi-line, unterminated, and trailing-garbage quoted scalars fail closed with LockfileParseError
  const malformedQuotes = [
    'PODS:\n  - "RNCWebView (13.0.0\n    - 1)"\nCOCOAPODS: 1.15.2\n',
    "PODS:\n  - 'RNCWebView (13.0.0\n    - 1)'\nCOCOAPODS: 1.15.2\n",
    'PODS:\n  - "RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - "RNCWebView (13.0.0)" garbage\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - "RNCWebView (13.0.0)"#comment\nCOCOAPODS: 1.15.2\n',
    'PODS:\n  - "RNCWebView (13.0.0)" "other"\nCOCOAPODS: 1.15.2\n',
  ];
  for (const input of malformedQuotes) {
    assert.throws(
      () => checkPodfileLockContent(input),
      (err) => err instanceof LockfileParseError,
    );
  }

  // Valid single-quoted scalar starting with literal '"' before '(' does not re-trigger quote parsing
  assert.equal(
    checkPodfileLockContent(
      'PODS:\n  - \'"SafePod (1.0.0)\'\nCOCOAPODS: 1.15.2\n',
    ).ok,
    true,
  );

  // 50KB space-padded column-0 line throws LockfileParseError in O(N) time (< 25 ms)
  const payload = `A${' '.repeat(50_000)}!\n`;
  const start = performance.now();
  assert.throws(
    () => checkPodfileLockContent(payload),
    (err) => err instanceof LockfileParseError,
  );
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 25, `Expected < 25 ms, got ${elapsedMs.toFixed(2)} ms`);
});
