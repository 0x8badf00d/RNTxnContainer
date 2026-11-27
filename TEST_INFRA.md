# E2E Test Infrastructure (`TEST_INFRA.md`)

> **Track:** E2E Testing Track (Parallel Dual Track — Requirement-Driven, Opaque-Box)
> **Target System:** Native iOS Transaction Container (`@internal/kiosk-host`, Kiosk Session Isolation Platform v3.0)
> **Authoritative Spec Sources:** `.agents/teamwork/ORIGINAL_REQUEST.md`, `/home/antigravity/PRD_Archv5.md`, `PROJECT.md`

---

## 1. Architecture & Opaque-Box Test Philosophy

The E2E test suite under `e2e/` is strictly **requirement-driven** and **opaque-box**:
- Every test derives directly from `ORIGINAL_REQUEST.md`, `PRD_Archv5.md` §§1–7 (`FR-1`..`FR-8`, SLOs, Guardrails, Verification Scenarios), and the frozen public contracts in `PROJECT.md § Interface Contracts`.
- Tests **never** depend on internal/private module symbols or implementation milestone boundaries.
- **Progressive Testability:** Tier 1 isolates foundational behaviors of each feature without depending on higher-order features; Tier 2 tests exact boundary/corner/negative inputs; Tier 3 validates pairwise cross-feature interactions; Tier 4 executes full real-world POS kiosk workloads.
- **Honest Failure Guarantee:** Every test genuinely exercises the target public entry point or structural deliverable and fails loudly with non-zero exit code when the underlying behavior is missing or violates a PRD invariant.

---

## 2. Three-Suite Execution Topology

Because `@internal/kiosk-host` spans Pure Swift Native Shell libraries, a React Native JS/TS package + Metro/CI guardrails, and Native iOS UIKit/ObjC++/CocoaPods artifacts (verified on Ubuntu Linux CI + macOS/iOS CI), the E2E suite is organized into **three orthogonal opaque-box runners** orchestrated by one unified CLI (`e2e/run-e2e.sh`):

| Suite | Directory | Runtime / Tooling | Opaque-Box Surface Under Test |
|---|---|---|---|
| **Swift Behavioral E2E** (`swift`) | `e2e/swift/` | SwiftPM (`e2e/swift/Package.swift` consuming `.package(path: "../..")` public products only) + `XCTest` | Public APIs of `KioskCore`, `KioskAuth`, `KioskTimeclock`, `KioskNetworking`, `KioskLifecycle`, `KioskVerification` driven through injected `KioskCore` DI protocol doubles (`E2ETestSupport`). |
| **JS / Metro / CLI E2E** (`js`) | `e2e/js/tier{1,2,3,4}/` | Node.js v22 built-in `node --test` (`.test.mjs`) | Public exports of `@internal/kiosk-host` (`.`, `./memory-storage`, `./memory-storage/async-storage`, `./memory-storage/mmkv`, `./metro`) and CLI `scripts/check-kiosk-lockfile.mjs` run as a real child process. |
| **Native iOS Structural & Security Contract E2E** (`structural`) | `e2e/ios-structural/tier{1,2,3,4}/` | Node.js v22 `node --test` + Ruby `cocoapods-core` + `clang++ --target=arm64-apple-ios16.0 -x objective-c++ -fobjc-arc -fsyntax-only` | Native iOS deliverables: `KioskHost.podspec`, `react-native.config.js`, `PrivacyInfo.xcprivacy` (`35F9.1`, `CA92.1`), `Sources/KioskIOS/**`, `ios/KioskReactNative/**` (mandatory iOS security APIs present, forbidden APIs absent, ObjC++ ARC syntax validity), `docs/RETROFIT_GUIDE.md`, `examples/**`, `.github/workflows/**`. |

---

## 3. Directory Layout

```text
e2e/
├── run-e2e.sh                          # Unified E2E runner (--tier, --suite, --list)
├── lib/                                # Shared opaque-box Node helpers & catalog parser
│   ├── assertions.mjs                  # Structured assertion & process-execution helpers
│   ├── ios-inspector.mjs               # Opaque-box file/plist/ObjC++/podspec contract helpers
│   └── test-catalog.mjs                # Deterministic test ID & tier/feature catalog verifier
├── fixtures/                           # Static opaque-box test fixtures
│   ├── lockfiles/                      # Clean & poisoned Podfile.lock and gradle.lockfile fixtures
│   ├── metro/                          # Sample consuming-app Metro configs & mock resolver inputs
│   ├── oauth/                          # Sample JWTs, OAuth token/error payloads (non-secret test fixtures)
│   └── timeclock/                      # Sample T&A CLOCKED_IN / CLOCKED_OUT / malformed payloads
├── swift/
│   ├── Package.swift                   # Consumer SwiftPM package -> .package(path: "../..")
│   ├── Sources/
│   │   └── E2ETestSupport/             # Public KioskCore DI protocol doubles & test harness builders
│   └── Tests/
│       ├── E2ETier1Tests/              # Tier 1 isolated happy-path Swift E2E tests (57 tests)
│       ├── E2ETier2Tests/              # Tier 2 BVA / corner / negative Swift E2E tests (57 tests)
│       ├── E2ETier3Tests/              # Tier 3 pairwise cross-feature Swift E2E tests (14 tests)
│       └── E2ETier4Tests/              # Tier 4 real-world POS kiosk Swift E2E scenarios (8 tests)
├── js/
│   ├── tier1/                          # Tier 1 JS/Metro/Lockfile CLI tests (14 tests)
│   ├── tier2/                          # Tier 2 JS/Metro/Lockfile BVA & negative tests (14 tests)
│   ├── tier3/                          # Tier 3 JS cross-feature interaction tests (3 tests)
│   └── tier4/                          # Tier 4 Consuming RN app retrofit E2E scenario (1 test)
└── ios-structural/
    ├── tier1/                          # Tier 1 Native iOS contract & security API tests (25 tests)
    ├── tier2/                          # Tier 2 Native iOS forbidden-API & negative contract tests (25 tests)
    ├── tier3/                          # Tier 3 Cross-layer iOS contract & ARC integration tests (3 tests)
    └── tier4/                          # Tier 4 Full Native iOS deliverable & toolchain audit (1 test)
```

---

## 4. Runner Interface (`./e2e/run-e2e.sh`)

```bash
# List all registered tests with per-tier, per-suite, and per-feature counts
./e2e/run-e2e.sh --list

# Run individual tiers (used sequentially by Final Milestone Phase 1: Tier 1 -> 2 -> 3 -> 4)
./e2e/run-e2e.sh --tier 1
./e2e/run-e2e.sh --tier 2
./e2e/run-e2e.sh --tier 3
./e2e/run-e2e.sh --tier 4

# Run entire E2E suite (Tiers 1–4 across Swift, JS, and iOS Structural)
./e2e/run-e2e.sh --tier all

# Optionally scope to a single suite
./e2e/run-e2e.sh --tier 1 --suite swift
./e2e/run-e2e.sh --tier 1 --suite js
./e2e/run-e2e.sh --tier 1 --suite structural
```

**Exit Code Contract:**
- `--list`: exits `0` iff the test catalog parses cleanly and satisfies all mandatory coverage minimums (`>= 80` T1 with `>= 5`/feature, `>= 80` T2 with `>= 5`/feature, `>= 16` T3, `>= 8` T4, total `>= 184`).
- Execution mode (`--tier 1|2|3|4|all`): exits `0` **if and only if** every executed suite builds and passes 100% of its tests with zero skipped-as-pass failures. Any compilation failure, missing deliverable, or test assertion failure exits non-zero.

---

## 5. Mandatory Coverage Thresholds & Complete Feature Matrix (`N = 16`)

| Tier | Description | Minimum Required | Planned Target |
|---|---|---|---|
| **Tier 1** | Isolated Feature Coverage (Happy Path, `>= 5` per feature) | `>= 80` | **96** (`6` × 16 features) |
| **Tier 2** | Boundary, Corner & Negative-Input BVA (`>= 5` per feature) | `>= 80` | **96** (`6` × 16 features) |
| **Tier 3** | Cross-Feature Pairwise Combinations | `>= 16` | **20** |
| **Tier 4** | Real-World POS Kiosk End-to-End Scenarios | `>= 8` | **10** |
| **Total** | **All Tiers Combined** | **`>= 184`** | **222** |

### Per-Feature Mapping (`FEAT-01`..`FEAT-16`)

| Feature ID | PRD Source | Tier 1 Target | Tier 2 Target | Tier 3 Coverage | Tier 4 Coverage | Primary Suites |
|---|---|---|---|---|---|---|
| **FEAT-01** | FR-1, §2, §5.1 | 6 | 6 | T3-01, T3-20 | T4-01, T4-08, T4-10 | Swift + Structural |
| **FEAT-02** | FR-1, §2, §6 | 6 | 6 | T3-02, T3-06, T3-11 | T4-02, T4-05, T4-08 | Swift |
| **FEAT-03** | FR-2, §2, §5.2 | 6 | 6 | T3-01, T3-02, T3-03, T3-14, T3-20 | T4-02, T4-05 | Swift + Structural |
| **FEAT-04** | FR-3, §2, §5.2 | 6 | 6 | T3-03, T3-04, T3-07 | T4-02, T4-06 | Swift |
| **FEAT-05** | FR-4/5/6, §5.4 | 6 | 6 | T3-05, T3-19 | T4-01, T4-03, T4-10 | Swift + Structural |
| **FEAT-06** | FR-4, §5.4, §7 | 6 | 6 | T3-06, T3-07, T3-08 | T4-03 | Swift |
| **FEAT-07** | FR-6, §5.4 | 6 | 6 | T3-08, T3-19 | T4-01, T4-03 | Swift + Structural |
| **FEAT-08** | FR-6, §1, §3, §7 | 6 | 6 | T3-15, T3-16 | T4-09 | JS |
| **FEAT-09** | FR-5, §2, §4 SLO, §5.3 | 6 | 6 | T3-05, T3-09, T3-10, T3-13, T3-18 | T4-01, T4-04, T4-06, T4-07 | Swift + Structural |
| **FEAT-10** | FR-7, §5 | 6 | 6 | T3-18 | T4-10 | Structural |
| **FEAT-11** | FR-8, §1, §6 | 6 | 6 | T3-04, T3-09, T3-10, T3-14 | T4-04, T4-06 | Swift + Structural |
| **FEAT-12** | FR-5, FR-8, §2, §5.5 | 6 | 6 | T3-10, T3-11, T3-12, T3-17 | T4-07 | Swift + JS + Structural |
| **FEAT-13** | §5, §6 | 6 | 6 | T3-15, T3-17, T3-19 | T4-09, T4-10 | JS + Structural |
| **FEAT-14** | §3, §6, §7 | 6 | 6 | T3-13, T3-20 | T4-04, T4-10 | Swift + Structural |
| **FEAT-15** | §7 | 6 | 6 | T3-12, T3-16 | T4-01, T4-08, T4-09 | Swift + JS |
| **FEAT-16** | §4 SLO, §7 | 6 | 6 | Cross-cutting | T4-01..T4-04, T4-10 | Swift + Structural |

---

## 6. Test ID Naming & Traceability Convention

Every E2E test case uses a deterministic, machine-parseable ID so `e2e/lib/test-catalog.mjs` and `./e2e/run-e2e.sh --list` can audit exact coverage without hand-counting:
- **Tier 1:** `T1_FEAT<01..16>_<01..06>_<DescriptiveSlug>` (e.g., `test_T1_FEAT01_01_PKCEGeneratesValidS256ChallengeAndState`, `T1_FEAT08_01: AsyncStorage setItem/getItem/removeItem in-memory`)
- **Tier 2:** `T2_FEAT<01..16>_<01..06>_<DescriptiveSlug>` (e.g., `test_T2_FEAT09_01_IdleTimerDoesNotFireAt59999msAndFiresAt60000ms`)
- **Tier 3:** `T3_PAIR<01..20>_FEAT<XX>_FEAT<YY>_<DescriptiveSlug>`
- **Tier 4:** `T4_SCEN<01..10>_<DescriptiveSlug>`

---

## 7. Real-World Tier 4 Scenario Catalog (10 Workloads)

1. **`T4_SCEN01`** — *PRD §7.1 Dirty Customer Reset Canary + Debug Sandbox/Keychain/Clipboard Snapshot Assert* (Swift)
2. **`T4_SCEN02`** — *PRD §7.2 Airship Silent Push + Foreground + 5m Poll Mid-Checkout Drain & Zero-Leak Logout* (Swift)
3. **`T4_SCEN03`** — *PRD §7.3 10x Parallel `401` Single-Flight Refresh, `isOneShot` Skip & `302` Cross-Host Redirect Auth Strip* (Swift)
4. **`T4_SCEN04`** — *PRD §7.4 1,000-Cycle Customer Session Soak Test (`< 5%` Memory Drift & `<= 1.5 s` p95 Recovery Latency)* (Swift)
5. **`T4_SCEN05`** — *15-Minute Monotonic Offline Fail-Closed (NTP-Jump Immune) + Offline Pending Revocation Queue & Reconnect Flush* (Swift)
6. **`T4_SCEN06`** — *VoiceOver 2.5x Extended Timeout + EMV PIN Pad `setHoldTeardown` + Non-Extendable 90s Hard Watchdog* (Swift)
7. **`T4_SCEN07`** — *JS Deadlock Recovery + Reboot-Safe 3-Strike Crash Circuit Breaker (`LANE_CLOSED`) + Associate Recovery & 60s Healthy Auto-Clear* (Swift)
8. **`T4_SCEN08`** — *Multi-Associate Shift Handoff Isolation Under Continuous POS Load* (Swift)
9. **`T4_SCEN09`** — *Consuming RN App Full JS/Metro/Lockfile Retrofit End-to-End Workload* (JS)
10. **`T4_SCEN10`** — *Complete Native iOS Deliverable, Podspec, Privacy Manifest & ObjC++ ARC Toolchain Audit* (iOS Structural)

---

## 8. Environment Requirements & Parallel Build Behavior

- **Linux Host Tooling:** Bash, Node.js v22+ (`node --test`), Swift 6.x (`swift test`, `swiftc -parse`), Ruby 3.2+ with `cocoapods-core` (for `KioskHost.podspec`), `clang++` (for ObjC++ ARC syntax checks).
- **Parallel Dual-Track Expectation:** While Implementation Milestones `M1`–`M6` are in progress, executing `./e2e/run-e2e.sh --tier <N>` is expected to fail on unimplemented targets. E2E track verification verifies catalog completeness, syntax/static soundness (`bash -n`, `node --check`, `swiftc -parse`), strict adherence to `PROJECT.md § Interface Contracts`, non-vacuity/mutation sensitivity, and honest non-zero failure against broken/missing implementation. Full green E2E pass across Tiers 1–4 is gated in Final Milestone `M7` Phase 1.
