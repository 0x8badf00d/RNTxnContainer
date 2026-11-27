import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'check-kiosk-lockfile.mjs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

function runCliSubprocess(args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

interface JsonReport {
  ok: boolean;
  strict: boolean;
  filesChecked: string[];
  violations: Array<{
    file: string;
    format: string;
    line: number;
    entry: string;
    matchedRule: string;
    category: string;
  }>;
  error?: string;
}

describe('CI Lockfile Forbidden-Pod Checker CLI (scripts/check-kiosk-lockfile.mjs)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'kiosk-lockfile-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Podfile.lock fixtures', () => {
    it('passes clean Podfile.lock (ignoring comments & SPEC CHECKSUMS decoys) with exit 0', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.clean.lock'),
        '--json',
      ]);
      expect(res.status).toBe(0);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.ok).toBe(true);
      expect(report.strict).toBe(false);
      expect(report.filesChecked).toEqual([fixture('Podfile.clean.lock')]);
      expect(report.violations).toEqual([]);
    });

    it('rejects forbidden Podfile.lock with exit 1, exact line numbers, and all categories', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.forbidden.lock'),
        '--json',
      ]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.ok).toBe(false);
      expect(report.violations.length).toBeGreaterThanOrEqual(7);

      const rules = new Set(report.violations.map((v) => v.matchedRule));
      expect(rules.has('RNCAsyncStorage')).toBe(true);
      expect(rules.has('react-native-mmkv')).toBe(true);
      expect(rules.has('MMKV')).toBe(true);
      expect(rules.has('MMKVCore')).toBe(true);
      expect(rules.has('op-sqlite')).toBe(true);
      expect(rules.has('RNCCookies')).toBe(true);
      expect(rules.has('RNCWebView')).toBe(true);
      for (const v of report.violations) {
        expect(v.format).toBe('podfile.lock');
        expect(v.line).toBeGreaterThan(0);
      }
    });

    it('catches indented transitive pods and DEPENDENCIES-only pods while deduplicating PODS/DEPENDENCIES overlap', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.transitive-only.lock'),
        '--json',
      ]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      const rules = report.violations.map((v) => v.matchedRule);
      expect(rules).toEqual([
        'MMKVCore',
        'react-native-quick-sqlite',
        'RNCAsyncStorage',
      ]);
      // MMKVCore appeared in both PODS and DEPENDENCIES -> reported exactly once!
      expect(rules.filter((r) => r === 'MMKVCore')).toHaveLength(1);
    });

    it('handles quoted pod names, quoted subspecs, and scoped packages in Podfile.quoted-subspecs.lock', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.quoted-subspecs.lock'),
        '--json',
      ]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.violations.map((v) => v.matchedRule)).toEqual([
        'MMKV',
        'op-sqlite',
        'RNCWebView',
        '@react-native-async-storage/async-storage',
      ]);
    });

    it('allows Podfile.strict-only.lock in default mode (exit 0) and rejects under --strict (exit 1)', () => {
      const normal = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.strict-only.lock'),
        '--json',
      ]);
      expect(normal.status).toBe(0);
      expect((JSON.parse(normal.stdout) as JsonReport).ok).toBe(true);

      const strict = runCliSubprocess([
        '--strict',
        '--podfile-lock',
        fixture('Podfile.strict-only.lock'),
        '--json',
      ]);
      expect(strict.status).toBe(1);
      const report = JSON.parse(strict.stdout) as JsonReport;
      expect(report.strict).toBe(true);
      expect(report.violations.map((v) => v.matchedRule)).toEqual([
        'RealmJS',
        'WatermelonDB',
        'RNFS',
        'react-native-sqlite-storage',
        'react-native-blob-util',
      ]);
    });

    it('exits 2 on malformed Podfile.lock', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.malformed.lock'),
        '--json',
      ]);
      expect(res.status).toBe(2);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/Invalid Podfile\.lock/);
    });
  });

  describe('gradle.lockfile fixtures', () => {
    it('passes clean gradle.lockfile including androidx.sqlite:sqlite (zero false positives) with exit 0', () => {
      const res = runCliSubprocess([
        '--gradle-lockfile',
        fixture('gradle.clean.lockfile'),
        '--json',
      ]);
      expect(res.status).toBe(0);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.ok).toBe(true);
      expect(report.violations).toEqual([]);
    });

    it('rejects forbidden gradle.lockfile with exit 1 and prioritizes exact group:artifact coordinate matches', () => {
      const res = runCliSubprocess([
        '--gradle-lockfile',
        fixture('gradle.forbidden.lockfile'),
        '--json',
      ]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.violations.map((v) => v.matchedRule)).toEqual([
        'com.tencent:mmkv',
        'com.tencent:mmkv-static',
        'com.reactnativecommunity:webview',
        'react-native-async-storage_async-storage',
        'com.opengineering:op-sqlite',
        'com.reactnativecommunity:cookies',
      ]);
    });

    it('allows gradle.strict-only.lockfile in default mode (exit 0) and rejects under --strict (exit 1)', () => {
      const normal = runCliSubprocess([
        '--gradle-lockfile',
        fixture('gradle.strict-only.lockfile'),
      ]);
      expect(normal.status).toBe(0);
      expect(normal.stdout).toMatch(/OK:/);

      const strict = runCliSubprocess([
        '--strict',
        '--gradle-lockfile',
        fixture('gradle.strict-only.lockfile'),
        '--json',
      ]);
      expect(strict.status).toBe(1);
      const report = JSON.parse(strict.stdout) as JsonReport;
      expect(report.violations.map((v) => v.matchedRule)).toEqual([
        'io.realm:realm-android-library',
        'com.nozbe:watermelondb',
        'react-native-fs',
        'react-native-sqlite-storage',
        'rn-fetch-blob',
      ]);
    });

    it('exits 2 on malformed gradle.lockfile', () => {
      const res = runCliSubprocess([
        '--gradle-lockfile',
        fixture('gradle.malformed.lockfile'),
      ]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/Malformed gradle\.lockfile/);
    });
  });

  describe('CLI options, auto-detection, repeatable flags, help & error handling', () => {
    it('auto-detects format via --lockfile by filename AND by content on neutral filenames', () => {
      const neutralPod = path.join(tempDir, 'neutral-ios.txt');
      const neutralGradle = path.join(tempDir, 'neutral-android.txt');
      copyFileSync(fixture('Podfile.forbidden.lock'), neutralPod);
      copyFileSync(fixture('gradle.clean.lockfile'), neutralGradle);

      const res = runCliSubprocess([
        `--lockfile=${neutralPod}`,
        '--lockfile',
        neutralGradle,
        '--json',
      ]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.filesChecked).toEqual([neutralPod, neutralGradle]);
      expect(report.violations.every((v) => v.file === neutralPod)).toBe(true);
    });

    it('supports repeatable mixed flags (--podfile-lock and --gradle-lockfile together)', () => {
      const res = runCliSubprocess([
        '--podfile-lock',
        fixture('Podfile.clean.lock'),
        '--gradle-lockfile',
        fixture('gradle.clean.lockfile'),
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Checked 2 lockfile(s)');
    });

    it('prints help and exits 0 for --help and -h', () => {
      for (const flag of ['--help', '-h']) {
        const res = runCliSubprocess([flag]);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Usage:');
        expect(res.stdout).toContain('--podfile-lock');
      }
    });

    it('exits 2 for usage errors, missing files, directories, and unknown flags', () => {
      expect(runCliSubprocess([]).status).toBe(2);
      expect(runCliSubprocess(['--unknown-flag']).status).toBe(2);
      expect(runCliSubprocess(['positional.lock']).status).toBe(2);
      expect(runCliSubprocess(['--lockfile']).status).toBe(2);
      expect(runCliSubprocess(['--lockfile=']).status).toBe(2);
      expect(runCliSubprocess(['--lockfile', '--strict']).status).toBe(2);
      expect(
        runCliSubprocess(['--podfile-lock', fixture('does-not-exist.lock')])
          .status,
      ).toBe(2);
      expect(runCliSubprocess(['--lockfile', FIXTURES_DIR]).status).toBe(2);
    });
  });

  describe('Iteration 2 malformed-syntax, YAML flow-sequence & parity regressions', () => {
    it('detects forbidden pods in YAML flow sequences, allows PODS: [], and rejects malformed/merge-conflicted Podfile.lock with exit 2', () => {
      const flowForbidden = path.join(tempDir, 'Podfile.flow-forbidden.lock');
      writeFileSync(
        flowForbidden,
        'PODS: [RNCWebView (13.0.0), MMKV (1.3.9)]\nCOCOAPODS: 1.15.2\n',
      );
      const flowRes = runCliSubprocess([
        '--podfile-lock',
        flowForbidden,
        '--json',
      ]);
      expect(flowRes.status).toBe(1);
      const flowReport = JSON.parse(flowRes.stdout) as JsonReport;
      expect(flowReport.violations.map((v) => v.matchedRule)).toEqual([
        'RNCWebView',
        'MMKV',
      ]);

      const flowEmpty = path.join(tempDir, 'Podfile.flow-empty.lock');
      writeFileSync(flowEmpty, 'PODS: []\nDEPENDENCIES: []\nCOCOAPODS: 1.15.2\n');
      expect(runCliSubprocess(['--podfile-lock', flowEmpty]).status).toBe(0);

      const flowCorrupt = path.join(tempDir, 'Podfile.flow-corrupt.lock');
      writeFileSync(flowCorrupt, 'PODS: not-a-list\nCOCOAPODS: 1.15.2\n');
      expect(runCliSubprocess(['--podfile-lock', flowCorrupt]).status).toBe(2);

      const mergeConflict = path.join(tempDir, 'Podfile.conflict.lock');
      writeFileSync(
        mergeConflict,
        [
          'PODS:',
          '  - KioskHost (1.0.0)',
          '<<<<<<< HEAD',
          '  - Airship (18.4.0)',
          '=======',
          '  - Airship (18.5.0)',
          '>>>>>>> main',
          'COCOAPODS: 1.15.2',
        ].join('\n'),
      );
      expect(runCliSubprocess(['--podfile-lock', mergeConflict]).status).toBe(2);

      const nonListLine = path.join(tempDir, 'Podfile.nonlist.lock');
      writeFileSync(
        nonListLine,
        'PODS:\nRNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
      );
      expect(runCliSubprocess(['--podfile-lock', nonListLine]).status).toBe(2);
    });

    it('rejects arbitrary comment-only non-Gradle files with exit 2 and auto-detects leading-whitespace Gradle lockfiles', () => {
      const commentOnly = path.join(tempDir, 'comment-only.lockfile');
      writeFileSync(
        commentOnly,
        '#!/bin/bash\n# just a shell comment, NOT a gradle lockfile!\n',
      );
      expect(runCliSubprocess(['--gradle-lockfile', commentOnly]).status).toBe(2);
      expect(runCliSubprocess(['--lockfile', commentOnly]).status).toBe(2);

      const leadingWsGradle = path.join(tempDir, 'leading-ws.txt');
      writeFileSync(
        leadingWsGradle,
        '  com.tencent:mmkv:1.3.9=compileClasspath\n',
      );
      const wsRes = runCliSubprocess(['--lockfile', leadingWsGradle, '--json']);
      expect(wsRes.status).toBe(1);
      const wsReport = JSON.parse(wsRes.stdout) as JsonReport;
      expect(wsReport.violations[0]?.matchedRule).toBe('com.tencent:mmkv');
    });

    it('enforces @op-engineering/op-sqlite Podfile rule and io.github.react-native-async-storage:async-storage Gradle coordinate rule', () => {
      const podScoped = path.join(tempDir, 'Podfile.op-sqlite.lock');
      writeFileSync(
        podScoped,
        'PODS:\n  - @op-engineering/op-sqlite (7.0.0)\nCOCOAPODS: 1.15.2\n',
      );
      const podRes = runCliSubprocess(['--podfile-lock', podScoped, '--json']);
      expect(podRes.status).toBe(1);
      expect(
        (JSON.parse(podRes.stdout) as JsonReport).violations[0]?.matchedRule,
      ).toBe('@op-engineering/op-sqlite');

      const gradleIoGithub = path.join(tempDir, 'gradle.iogithub.lockfile');
      writeFileSync(
        gradleIoGithub,
        '# This is a Gradle generated file for dependency locking.\nio.github.react-native-async-storage:async-storage:2.1.0=runtimeClasspath\n',
      );
      const gradleRes = runCliSubprocess([
        '--gradle-lockfile',
        gradleIoGithub,
        '--json',
      ]);
      expect(gradleRes.status).toBe(1);
      expect(
        (JSON.parse(gradleRes.stdout) as JsonReport).violations[0]?.matchedRule,
      ).toBe('io.github.react-native-async-storage:async-storage');
    });
  });

  describe('Iteration 3 inline YAML dependency mappings, strictness & comment-escape regressions', () => {
    it('catches forbidden pods in inline YAML flow dependency mappings inside PODS list items (exit 1)', () => {
      const cases: Array<[string, string, string[]]> = [
        [
          'inline-child-webview.lock',
          'PODS:\n  - SafeParent (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'inline-child-multi.lock',
          'PODS:\n  - SafeParent (1.0.0): [MMKV (1.3.9), RNCAsyncStorage (1.24.0)]\nCOCOAPODS: 1.15.2\n',
          ['MMKV', 'RNCAsyncStorage'],
        ],
        [
          'inline-parent-unquoted.lock',
          'PODS:\n  - RNCWebView: [React-Core]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'inline-parent-quoted.lock',
          'PODS:\n  - "RNCWebView": [React-Core]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'inline-parent-quoted-tight.lock',
          'PODS:\n  - "RNCWebView":[React-Core]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
      ];

      for (const [name, content, expectedRules] of cases) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect(res.status).toBe(1);
        const report = JSON.parse(res.stdout) as JsonReport;
        expect(report.violations.map((v) => v.matchedRule)).toEqual(
          expectedRules,
        );
      }
    });

    it('fails closed (exit 2) on YAML anchors, aliases, tags, compact sequences, inline non-sequence mappings, diff3/indented conflicts, mixed flow+block, and pre-header garbage', () => {
      const invalidPodfiles: Array<[string, string]> = [
        [
          'compact-seq.lock',
          'PODS:\n  - - RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'yaml-anchor.lock',
          'PODS:\n  - &w RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        ['yaml-alias.lock', 'PODS:\n  - *w\nCOCOAPODS: 1.15.2\n'],
        [
          'yaml-tag.lock',
          'PODS:\n  - !!str RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'yaml-flow-map.lock',
          'PODS:\n  - {RNCWebView: [React-Core]}\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'yaml-bare-flow-seq.lock',
          'PODS:\n  - [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'inline-scalar-val.lock',
          'PODS:\n  - SafeParent (1.0.0): RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'diff3-conflict.lock',
          'PODS:\n  - SafePod (1.0.0)\nSPEC CHECKSUMS:\n||||||| base\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'indented-conflict.lock',
          'PODS:\n  - SafePod (1.0.0)\nSPEC CHECKSUMS:\n  <<<<<<< HEAD\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'mixed-flow-block.lock',
          'PODS: []\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'pre-header-garbage.lock',
          'corrupt garbage {{{\nPODS:\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
      ];

      for (const [name, content] of invalidPodfiles) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 2 });
      }

      const gradleDiff3 = path.join(tempDir, 'gradle.diff3.lockfile');
      writeFileSync(
        gradleDiff3,
        '# This is a Gradle generated file for dependency locking.\n||||||| base\nempty=annotationProcessor\n',
      );
      expect(
        runCliSubprocess(['--gradle-lockfile', gradleDiff3]).status,
      ).toBe(2);
    });

    it('handles escaped backslashes before closing quotes in inline comments and aligns Gradle header auto-detection', () => {
      const escapedBs = path.join(tempDir, 'Podfile.escaped-bs.lock');
      writeFileSync(
        escapedBs,
        'PODS: ["SafePod\\\\"] # comment\nCOCOAPODS: 1.15.2\n',
      );
      const bsRes = runCliSubprocess(['--podfile-lock', escapedBs, '--json']);
      expect(bsRes.status).toBe(0);
      expect((JSON.parse(bsRes.stdout) as JsonReport).ok).toBe(true);

      const neutralGradleHeader = path.join(tempDir, 'neutral-gradle-hdr.txt');
      writeFileSync(
        neutralGradleHeader,
        '  #  this is a gradle generated file for dependency locking.\n',
      );
      const autoRes = runCliSubprocess([
        '--lockfile',
        neutralGradleHeader,
        '--json',
      ]);
      expect(autoRes.status).toBe(0);
      expect((JSON.parse(autoRes.stdout) as JsonReport).ok).toBe(true);
    });
  });

  describe('Iteration 4 YAML 1.2 column-0 header, scalar-start quote, explicit-key & escape regressions', () => {
    it('enforces column-0 strictness on quoted/tabbed headers (exit 1) and rejects tagged/explicit-key/corrupt top-level lines (exit 2)', () => {
      const forbiddenAfterNonPods: Array<[string, string, string[]]> = [
        [
          'quoted-double-pods.lock',
          'COCOAPODS: 1.15.2\n"PODS":\n  - RNCWebView (13.0.0)\n',
          ['RNCWebView'],
        ],
        [
          'quoted-single-pods.lock',
          "SPEC CHECKSUMS:\n  SafePod: abc123\n'PODS':\n  - MMKV (1.3.9)\nCOCOAPODS: 1.15.2\n",
          ['MMKV'],
        ],
        [
          'quoted-deps.lock',
          'COCOAPODS: 1.15.2\n"DEPENDENCIES":\n  - RNCAsyncStorage\n',
          ['RNCAsyncStorage'],
        ],
        [
          'tabbed-pods.lock',
          'COCOAPODS: 1.15.2\nPODS\t:\n  - RNCWebView (13.0.0)\n',
          ['RNCWebView'],
        ],
      ];

      for (const [name, content, expectedRules] of forbiddenAfterNonPods) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 1 });
        const report = JSON.parse(res.stdout) as JsonReport;
        expect(report.violations.map((v) => v.matchedRule)).toEqual(
          expectedRules,
        );
      }

      const failClosedTopLevel: Array<[string, string]> = [
        [
          'tagged-pods.lock',
          'COCOAPODS: 1.15.2\n!!str PODS:\n  - RNCWebView (13.0.0)\n',
        ],
        [
          'explicit-key-pods.lock',
          'COCOAPODS: 1.15.2\n? PODS\n:\n  - RNCWebView (13.0.0)\n',
        ],
        [
          'corrupt-after-cocoapods.lock',
          'PODS:\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\ncorrupt garbage {{{\n',
        ],
      ];

      for (const [name, content] of failClosedTopLevel) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 2 });
      }
    });

    it('enforces YAML scalar-start quote rules, decodes double-quoted escapes, and rejects explicit keys & digit-first block scalars', () => {
      const forbiddenCases: Array<[string, string, string[]]> = [
        [
          'mid-single-quote-map.lock',
          "PODS:\n  - Bob'sPod (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n",
          ['RNCWebView'],
        ],
        [
          'mid-double-quote-map.lock',
          'PODS:\n  - Safe"Pod (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'mid-backtick-map.lock',
          'PODS:\n  - Safe`Pod (1.0.0): [RNCWebView (13.0.0)]\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'mid-single-flow-seq.lock',
          "PODS: [SafePod' (1.0.0), RNCWebView (13.0.0), OtherPod' (1.0.0)]\nCOCOAPODS: 1.15.2\n",
          ['RNCWebView'],
        ],
        [
          'mid-double-flow-seq.lock',
          'PODS:\n  - SafeParent (1.0.0): [PodA" (1.0.0), MMKV (1.3.9), PodB" (1.0.0)]\nCOCOAPODS: 1.15.2\n',
          ['MMKV'],
        ],
        [
          'unicode-escape-pod.lock',
          'PODS:\n  - "\\u0052NCWebView (13.0.0)"\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
        [
          'slash-escape-pod.lock',
          'PODS:\n  - "RNCWebView\\/Core (13.0.0)"\nCOCOAPODS: 1.15.2\n',
          ['RNCWebView'],
        ],
      ];

      for (const [name, content, expectedRules] of forbiddenCases) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 1 });
        const report = JSON.parse(res.stdout) as JsonReport;
        expect(report.violations.map((v) => v.matchedRule)).toEqual(
          expectedRules,
        );
      }

      // Valid plain scalar with mid-scalar apostrophe + inline comment passes cleanly (exit 0)
      const validApostropheComment = path.join(tempDir, 'valid-apos-comment.lock');
      writeFileSync(
        validApostropheComment,
        "PODS: [SafePod' (1.0.0)] # comment\nCOCOAPODS: 1.15.2\n",
      );
      expect(
        runCliSubprocess(['--podfile-lock', validApostropheComment]).status,
      ).toBe(0);

      // Fail-closed exit 2 cases
      const failClosedCases: Array<[string, string]> = [
        [
          'explicit-key-entry.lock',
          'PODS:\n  - ? RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        ['bare-colon-entry.lock', 'PODS:\n  - :\nCOCOAPODS: 1.15.2\n'],
        [
          'quoted-space-colon-flow.lock',
          'PODS: ["RNCWebView" :React-Core]\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'digit-first-block-scalar.lock',
          'PODS:\n  - |2-\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'folded-digit-block-scalar.lock',
          'PODS:\n  - >2+\n  - SafePod (1.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'invalid-unicode-escape.lock',
          'PODS:\n  - "\\uZZZZ (1.0.0)"\nCOCOAPODS: 1.15.2\n',
        ],
      ];

      for (const [name, content] of failClosedCases) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 2 });
      }
    });
  });

  describe('Iteration 5 paired-backtick mapping, strict quoted scalar & headerMatch ReDoS regressions', () => {
    it('does not let paired backticks hide an inline mapping colon (exit 1)', () => {
      const filePath = path.join(tempDir, 'paired-backtick-map.lock');
      writeFileSync(
        filePath,
        'PODS:\n  - SafePod` (1.0.0): [RNCWebView (13.0.0), OtherPod` (1.0.0)]\nCOCOAPODS: 1.15.2\n',
      );
      const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as JsonReport;
      expect(report.violations.map((v) => v.matchedRule)).toEqual([
        'RNCWebView',
      ]);
    });

    it('fails closed (exit 2) on multi-line, unterminated, or trailing-garbage quoted scalars while allowing valid quoted scalars', () => {
      const failClosedQuotes: Array<[string, string]> = [
        [
          'multiline-double-quote.lock',
          'PODS:\n  - "RNCWebView (13.0.0\n    - 1)"\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'multiline-single-quote.lock',
          "PODS:\n  - 'RNCWebView (13.0.0\n    - 1)'\nCOCOAPODS: 1.15.2\n",
        ],
        [
          'unterminated-double-quote.lock',
          'PODS:\n  - "RNCWebView (13.0.0)\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'trailing-garbage-quote.lock',
          'PODS:\n  - "RNCWebView (13.0.0)" garbage\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'trailing-hash-no-space.lock',
          'PODS:\n  - "RNCWebView (13.0.0)"#comment\nCOCOAPODS: 1.15.2\n',
        ],
        [
          'two-quoted-scalars.lock',
          'PODS:\n  - "RNCWebView (13.0.0)" "other"\nCOCOAPODS: 1.15.2\n',
        ],
      ];

      for (const [name, content] of failClosedQuotes) {
        const filePath = path.join(tempDir, name);
        writeFileSync(filePath, content);
        const res = runCliSubprocess(['--podfile-lock', filePath, '--json']);
        expect({ name, status: res.status }).toEqual({ name, status: 2 });
      }

      // Valid single-quoted scalar whose decoded pod name starts with '"' must NOT fail on '(' slice
      const validInnerQuote = path.join(tempDir, 'valid-inner-quote.lock');
      writeFileSync(
        validInnerQuote,
        'PODS:\n  - \'"SafePod (1.0.0)\'\nCOCOAPODS: 1.15.2\n',
      );
      expect(
        runCliSubprocess(['--podfile-lock', validInnerQuote]).status,
      ).toBe(0);
    });

    it('rejects 50KB space-padded column-0 header ReDoS payload in linear time (exit 2)', () => {
      const redosPath = path.join(tempDir, 'header-redos.lock');
      writeFileSync(redosPath, `A${' '.repeat(50_000)}!\n`);
      const start = performance.now();
      const res = runCliSubprocess(['--podfile-lock', redosPath, '--json']);
      const elapsedMs = performance.now() - start;
      expect(res.status).toBe(2);
      expect(elapsedMs).toBeLessThan(2000);
    });
  });
});
