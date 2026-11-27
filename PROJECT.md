# Project: Native iOS Transaction Container (`@internal/kiosk-host`)

## Architecture

`@internal/kiosk-host` implements the **Kiosk Session Isolation Platform (v3.0)** from `/home/antigravity/PRD_Archv5.md` specifically for **Native iOS** (React Native New Architecture / Bridgeless `RCTHost` + Fabric + TurboModules + Hermes).

### 3-Layer Modular Architecture

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                LAYER 3: REACT NATIVE iOS & JS/TS INTEGRATION                      │
│  ┌────────────────────────────────────┐   ┌─────────────────────────────────────┐ │
│  │ JS/TS (@internal/kiosk-host) [M5]  │   │ ios/KioskReactNative (ObjC++/Sw)[M6]│ │
│  │ - Codegen Specs (NativeKiosk*.ts)  │◄─►│ - RCTKioskAssociate/Config/Session  │ │
│  │ - Public Facades (KioskAssociate/  │   │ - KioskRCTHostAdapter (.h/.mm)      │ │
│  │   Config/Session + errorGuards)    │   │ - KioskHTTPRequestHandler (.mm)     │ │
│  │ - In-Memory Map Shims (AsyncStorage│   │ - KioskNetworkHook / FatalBridge    │ │
│  │   & MMKV v3+v4)                    │   │ - KioskFabricTextInputHook (.h/.mm) │ │
│  │ - Metro Guardrail & Lockfile CI    │   │ - KioskRCTHostManager /             │ │
│  └────────────────────────────────────┘   │   KioskAppDelegate.swift / Podspec  │ │
│                                           └──────────────────┬──────────────────┘ │
└──────────────────────────────────────────────────────────────┼────────────────────┘
                                                               │ delegates to
┌──────────────────────────────────────────────────────────────▼────────────────────┐
│                LAYER 2: NATIVE iOS PLATFORM ADAPTERS (KioskIOS) [M4]              │
│                        (#if os(iOS) && canImport(UIKit))                          │
│  - KeychainTokenStore (SecItem*, AfterFirstUnlockThisDeviceOnly, isolated ns)     │
│  - KioskWKWebViewAuthController (WKWebsiteDataStore.nonPersistent, strict nav)    │
│  - KioskNetworkingSessionProvider (3-way split URLSessions: Control-Plane,        │
│    Internal Ephemeral no-store, Public CDN disk URLCache; all NO_COOKIES)         │
│  - KioskURLProtocol (defense-in-depth, ReplayableBodyClassifier, no global reg)   │
│  - KioskAirshipAdapter (APNs content-available:1, isChannelCaptureEnabled=false)  │
│  - KioskTextInputSanitizer + KioskOSSanitizer (8 UITextInputTraits + iOS 17/18,   │
│    privacy shield, UIPasteboard wipe, AVSpeechSynthesizer/VoiceOver stop)         │
│  - KioskWindow (sendEvent + textDidChange + VoiceOver focus), LoginVC,            │
│    LaneClosedVC (with associate recovery), KioskFilesystemSandboxInspector,       │
│    UserDefaultsCrashRecordStore, KioskShellAssembly                               │
└──────────────────────────────────────────────────────────────┬────────────────────┘
                                                               │ implements protocols
┌──────────────────────────────────────────────────────────────▼────────────────────┐
│           LAYER 1: PURE SWIFT CORE (Zero UIKit — Linux & iOS SwiftPM)             │
│                                                                                   │
│  ┌──────────────────────────────┐     ┌────────────────────────────────────────┐  │
│  │ KioskAuth [M2]               │     │ KioskLifecycle [M3]                    │  │
│  │ - SHA256 (CryptoKit/Swift)   │     │ - KioskStateMachine (Tier1 × Tier2)    │  │
│  │ - PKCEGenerator (RFC 7636)   │     │ - KioskLifecycleController (actor)     │  │
│  │ - OAuthAuthorizationURLBldr  │     │ - TeardownHoldController (90s max)     │  │
│  │ - JWTClaimsParser            │     │ - CrashCircuitBreaker (boot-id safe)   │  │
│  │ - PendingRevocationQueue (1) │     │ - BootSweepCoordinator + KioskHost     │  │
│  │ - SingleFlightTokenManager   │     ├────────────────────────────────────────┤  │
│  │ - AssociateAuthController    │     │ KioskNetworking [M3]                   │  │
│  ├──────────────────────────────┤     │ - DomainAllowlistPolicy (exact host)   │  │
│  │ KioskTimeclock [M2]          │     │ - SessionRequestRegistry (SessionTag)  │  │
│  │ - ShiftSyncCoordinator (2s   │     │ - ReplayableBodyClassifier (1 MiB cap) │  │
│  │   coalesced actor, 5m poll,  │     │ - CustomerNetworkPolicyEngine (3xx/401)│  │
│  │   5s retry, 15m fail-closed) │     ├────────────────────────────────────────┤  │
│  │ - TimeclockHTTPClient        │     │ KioskVerification [M3]                 │  │
│  └──────────────┬───────────────┘     │ - SandboxSnapshotVerifier              │  │
│                 └────────────────────┬┴────────────────────────────────────────┘  │
│                                      ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐ │
│  │ KioskCore [M1] — KioskHostConfig, Models, DI & Cross-Coordinator Protocols,  │ │
│  │   LockedBox, SystemMonotonicClock (systemUptime + continuous), KioskLogger,  │ │
│  │   PrivacyInfo.xcprivacy (35F9.1, CA92.1)                                     │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions (Synthesized from Step 0 Survey)
1. **Genuine Linux + iOS Dual Compilation & Testing:**
   - Pure Swift core modules (`KioskCore`, `KioskAuth`, `KioskTimeclock`, `KioskNetworking`, `KioskLifecycle`, `KioskVerification`) have **zero external SwiftPM dependencies** and **zero UIKit dependencies**; they use `#if canImport(FoundationNetworking)` and `#if canImport(CryptoKit)` (with pure-Swift FIPS 180-4 SHA-256 fallback) so `swift build` and `swift test` genuinely compile and execute on Ubuntu 24.04 Linux AND macOS/iOS.
   - `KioskIOS` files are guarded by `#if os(iOS) && canImport(UIKit)` so `swift build` succeeds cleanly on Linux while compiling full native UIKit/WebKit/Security/AVFoundation code on iOS.
   - All intra-package Swift imports use `#if canImport(KioskCore)` guards so the exact same `.swift` files compile cleanly under both multi-module SwiftPM AND single-module CocoaPods (`KioskHost`).
   - Objective-C++ bridge files (`ios/KioskReactNative/*.{h,mm}`) keep `.h` files pure Objective-C (zero C++/Folly in headers) and are syntax- and ARC-verified on Linux using `clang++ --target=arm64-apple-ios16.0 -x objective-c++ -fobjc-arc -fsyntax-only -I Tests/ObjCStubHeaders`.
   - `KioskHost.podspec` is validated on Linux using Ruby 3.2.3 + `cocoapods-core`.
2. **High-Priority `RCTURLRequestHandler` + Defense-in-Depth `KioskURLProtocol`:**
   - Because `URLSession` transforms `httpBody` into `httpBodyStream` before calling `URLProtocol`, `ios/KioskReactNative/KioskHTTPRequestHandler.mm` (`handlerPriority = 10`) intercepts JS `fetch`/XHR and `<Image>` (`RCTImageLoader`) **before** `URLSession` mutates `httpBody` — preserving exact `isOneShot()` streaming-body semantics — while `RCTSetCustomNSURLSessionConfigurationProvider` + `KioskURLProtocol` (using `ReplayableBodyClassifier` with 1 MiB cap) provides defense-in-depth. Never call global `URLProtocol.registerClass`.
3. **Critical iOS Security & Concurrency Safeguards:**
   - **Airship Channel Capture disabled:** Force `isChannelCaptureEnabled = false` so Airship never writes `ua:<channelId>` to `UIPasteboard` on 6 foregrounds.
   - **Zero Main↔JS Deadlocks:** Synchronous TurboModules read immutable `LockedBox`-protected snapshots (never `DispatchQueue.main.sync`); `RCTKioskSession` captures immutable `boundSessionId` on init so retiring `RCTHost` instances cannot mutate the next customer's session.
   - **Actor Reentrancy Safety:** Monotonic `authGeneration` and `associateSessionGeneration` counters are re-checked after every `await` so in-flight token refreshes or T&A responses can never resurrect state after logout.
   - **Bridgeless `RCTHost` Safe Teardown:** Synchronously mask view, end editing, run `teardownListeners`, cancel tagged HTTP tasks, wipe clipboard/TTS, and call main-thread `[RCTFabricSurface stop]` BEFORE transferring retiring `RCTHost` to non-blocking `RetiringHostReaper`.
   - **Non-Extendable 90s Hold Watchdog:** Repeated `setHoldTeardown(true)` calls are idempotent and preserve `holdStartedMonotonicMs`; watchdog unconditionally fires at `holdStartedMonotonicMs + maxHoldDurationMs`.
   - **Sleep-Inclusive Monotonic Clocks & Privacy Manifest:** `SystemMonotonicClock` supports `ProcessInfo.processInfo.systemUptime` and sleep-inclusive continuous monotonic time (`mach_continuous_time()` / `CLOCK_MONOTONIC_RAW`) for sleep-spanning boundaries (15m offline fail-closed, token TTL), with `PrivacyInfo.xcprivacy` declaring `35F9.1` and `CA92.1`.

---

## Feature Inventory

Every feature from `ORIGINAL_REQUEST.md`, `PRD_Archv5.md` §§1–7, and Survey findings (`F-01`–`F-40`, `FR-1`–`FR-8`, SLOs, Guardrails, Verification) is assigned to milestones below (zero unassigned features):

| # | Feature | Description (Sub-Requirements Covered) | Milestone(s) | Source |
|---|---|---|---|---|
| **FEAT-01** | Disposable Native OAuth 2.0 + PKCE Login & Keychain Storage | `F-01`, `F-02` (`FR-1`): In-process `WKWebView` with `WKWebsiteDataStore.nonPersistent()` (Guided Access safe), `prompt=login`, RFC 7636 `S256` PKCE + CSRF `state`, strict host/redirect-scheme navigation allowlist & popup block, immediate WebView teardown, code exchange via `shellHttpClient`, JWT claims extraction (`AssociateProfile`), Keychain `ThisDeviceOnly` persistence, zero raw tokens in JS. | M1, M2, M4 | PRD §2, §4 FR-1, §5.1; Survey |
| **FEAT-02** | Token Revocation, Offline Pending Queue, `invalid_grant` & Zero-Leak Shift Handoff | `F-03`, `F-04`, `F-05`, `F-06` (`FR-1`): Online `POST /as/revoke_token.oauth2`, max-1 offline `pendingRevocationToken` slot in Keychain, `invalid_grant` forced logout, manual logout (native gesture/badge & `requestAssociateLogout`), deterministic Zero-Leak Shift Handoff wiping Airship binding, tokens/claims, `RCTHost`, clipboard, and TTS. | M2, M3, M4 | PRD §2, §4 FR-1, §6; Survey |
| **FEAT-03** | Airship Push Tickle + 5-Minute T&A Shift Sync & 15-Minute Offline Fail-Closed | `F-07`, `F-08`, `F-09`, `F-10` (`FR-2`): Airship init (`isChannelCaptureEnabled = false`), Named User/Channel bind & unbind + optional `deviceBindEndpointUrl`, initial shift verification on login, single 2s-coalesced `checkShiftStatus()` actor triggered by APNs `content-available: 1` push tickle (payload never trusted directly), `willEnterForeground`, and 5m monotonic timer; 5s 1x network retry; 15m monotonic offline fail-closed (respecting active hold). | M2, M4 | PRD §2, §4 FR-2, §5.2; Survey |
| **FEAT-04** | Graceful Mid-Checkout Drain & `X-Kiosk-Associate-State` Header | `F-11`, `F-12` (`FR-3`): `CLOCKED_OUT` during `READY` logs out immediately; during `ACTIVE` sets `logoutOnReset = true`, starts 5m `maxDrainDurationMs` cap, stamps `X-Kiosk-Associate-State: ACTIVE \| DRAINING` on `allowedInternalDomains` calls, and logs associate out immediately upon customer reset without pre-booting next `RCTHost`. | M3 | PRD §2, §4 FR-3, §5.2; Survey |
| **FEAT-05** | Split HTTP Layer, `SessionTag` Cancellation & Domain Allowlist | `F-13`, `F-14`, `F-15` (`FR-4`, `FR-5`, `FR-6`): Dedicated `shellHttpClient` unaffected by customer teardown; customer networking layer (`RCTURLRequestHandler` + defense-in-depth `KioskURLProtocol`, `NO_COOKIES`) attaching `SessionTag` pre-queue and canceling queued + running tasks on teardown; exact-host allowlist permitting only `allowedInternalDomains` and `allowedPublicAssetDomains` and blocking all other external HTTP/`<Image>` hosts. | M3, M4, M6 | PRD §4 FR-4/5/6, §5.4; Survey |
| **FEAT-06** | Scoped Bearer Injection, Proactive Refresh, `3xx` Auth Strip & Single-Flight `401` Coordinator | `F-16`, `F-17`, `F-18` (`FR-4`): `Authorization: Bearer` injected strictly on `allowedInternalDomains`, 30s monotonic proactive refresh, cross-host `3xx` redirects strip `Authorization` & `X-Kiosk-Associate-State` (and block unallowlisted redirect hosts), single-flight `401` refresh actor (1 PFed `/token` call for N concurrent 401s, 1-retry max, skipping `isOneShot()` streaming bodies, `invalid_grant` forced logout). | M2, M3, M4, M6 | PRD §4 FR-4, §5.4, §7; Survey |
| **FEAT-07** | Internal API `Cache-Control: no-store` & Public CDN Disk `URLCache` Isolation | `F-19` (`FR-6`): Forces `Cache-Control: no-store` and suppresses `URLCache` storage (`willCacheResponse -> nil`) for `allowedInternalDomains`; routes unauthenticated `allowedPublicAssetDomains` `<Image>` responses through isolated disk `URLCache` persisting across customer resets. | M3, M4, M6 | PRD §4 FR-6, §5.4; Survey |
| **FEAT-08** | Metro In-Memory Storage Shims (`AsyncStorage` & `MMKV`) & `react-native-webview` Build Block | `F-20`, `F-21` (`FR-6`, §7): Pure JS per-Hermes-runtime `Map` shims for `@react-native-async-storage/async-storage` (full async + callback + deep `mergeItem` + `useAsyncStorage`) and `react-native-mmkv` (v3 + v4 + hooks) with zero disk I/O; Metro `resolveRequest` guardrail aliasing both packages and throwing a build error on `react-native-webview`. | M5 | PRD §1, §3, §4 FR-6, §7; Survey |
| **FEAT-09** | Pre-Booted Ephemeral `RCTHost`, 0ms Activation, Monotonic Idle Kill Switch (VoiceOver 2.5x) & Non-Blocking Teardown | `F-22`, `F-23`, `F-24`, `F-25`, `F-26` (`FR-5`): Pre-booted Bridgeless `RCTHost` + `RCTFabricSurface` on `<AttractScreen/>` in `READY` (idle timer paused); 0ms `READY -> ACTIVE` via `KioskWindow` touch/key/text/VoiceOver focus + `notifyActivity()`; monotonic 60s idle kill switch (2.5x = 150s when VoiceOver on) firing natively even if JS is deadlocked; `endSession('COMPLETED' \| 'CANCELED' \| 'ERROR')`; deterministic non-blocking teardown sequence (`<= 1.5 s` p95 recovery target). | M3, M4, M6 | PRD §2, §4 FR-5/SLOs, §5.3; Survey |
| **FEAT-10** | Structural iOS Input Hygiene, 3rd-Party Keyboard Blocking, Privacy Masking, Clipboard & TTS Sanitization | `F-27`, `F-28`, `F-29` (`FR-7`): Fabric `RCTTextInputComponentView` + `UITextField`/`UITextView` override enforcing `autocorrectionType = .no`, `spellCheckingType = .no`, `smart* = .no`, `textContentType = nil`, `inputAssistantItem` clear, iOS 17+ `inlinePredictionType = .no`, iOS 18+ `writingToolsBehavior = .none` across updates/recycling; `shouldAllowExtensionPointIdentifier` blocking 3rd-party keyboards; opaque background privacy shield; `UIPasteboard` wipe & TTS/VoiceOver stop on every reset. | M4, M6 | PRD §4 FR-7, §5; Survey |
| **FEAT-11** | Hardware Peripheral Safety Hooks (`setHoldTeardown` 90s Watchdog & `addTeardownListener`) | `F-30`, `F-31` (`FR-8`): Swift `KioskHost` static API (`notifyActivity`, `setHoldTeardown`, `addTeardownListener -> KioskCancellable`) + ObjC bridge; non-extendable 90s monotonic watchdog deferring idle/drain/offline/`invalid_grant`/manual logout during EMV PIN pad prompts; snapshot-safe synchronous teardown listeners flushing EMV/scanner/breadcrumb state. | M3, M6 | PRD §1, §4 FR-8, §6; Survey |
| **FEAT-12** | Crash Interception, Boot-Time Sweep, Reboot-Safe Circuit Breaker & Minimal 2-Screen Native Shell UI | `F-32`, `F-33`, `F-34` (`FR-5`, `FR-8`): JS `ErrorUtils` + unhandled rejection prelude + iOS `RCTSetFatalHandler`/`RCTSetFatalExceptionHandler`; Boot-Time Sweep (orphaned refresh token -> `pendingRevocationToken`, wipe active auth & clipboard); reboot-safe persisted `recentCrashTimestamps` tripping persistent Native `"Lane Closed / Call Associate"` UI at `>= 3` crashes in `30 s` and auto-clearing after `60 s` healthy session; strictly 2 native screens (Login Container + Lane Closed UI with associate recovery). | M3, M4, M5, M6 | PRD §2, §4 FR-8, §5.5; Survey |
| **FEAT-13** | Synchronous Token-Free TurboModules (`KioskAssociate`, `KioskConfig`, `KioskSession`) | `F-35` (§6): Codegen-compliant `NativeKiosk*` specs + exact PRD §6 public TypeScript facades (`AssociateProfile`, `KioskDeviceConfig`, `SessionEndReason`, `KioskAssociateSpec`, `KioskConfigSpec`, `KioskSessionSpec`) + ObjC++ TurboModules using `LockedBox` zero-deadlock reads and `boundSessionId` retiring-runtime fencing. | M5, M6 | PRD §5, §6; Survey |
| **FEAT-14** | `KioskHostConfig`, PII-Free Telemetry (`onHostMetric`), Privacy Manifest & `KioskAppDelegate` Retrofit Entry | `F-36`, `F-39` (§3, §6, §7): Full `KioskHostConfig` with exact defaults & fail-fast `.validate()`, PII-free `onHostMetric` callback & redacted logger, `PrivacyInfo.xcprivacy` (`35F9.1`, `CA92.1`), subclassable `KioskAppDelegate`, `KioskHost.podspec`, `react-native.config.js`, Retrofit Guide & example app delegate. | M1, M4, M6 | PRD §3, §6, §7; Survey |
| **FEAT-15** | CI Lockfile Forbidden-Pod Check & Debug Sandbox/Keychain/Clipboard Snapshot Assert | `F-37`, `F-38` (§7): CLI script validating `Podfile.lock` & `gradle.lockfile` against forbidden native disk/cookie/webview pods/modules; Debug/CI `SandboxSnapshotVerifier` asserting zero residual customer files (excl. public CDN cache & allowlisted shell metadata), Keychain auth keys, cookies, internal `URLCache`, and clipboard items after teardown/logout. | M3, M4, M5 | PRD §7; Survey |
| **FEAT-16** | Automated Verification Scenarios & 1,000-Cycle Soak SLO Validation | `F-40` (§4 SLOs, §7): Dirty Customer Reset Canary, Airship Push/Foreground/5m Poll Drain Test, 10x 401 Concurrency & 302 Cross-Host Redirect Test, and 1,000-Cycle `ACTIVE -> TEARING_DOWN -> READY` soak test (`< 5%` memory drift & bounded recovery latency), plus Linux CI & macOS/iOS CI workflows. | M6, M7 | PRD §4 SLOs, §7; Survey |

---

## Milestones

| # | Name | Scope | Dependencies | Exclusive Write Ownership | Status | Sub-Orch Conv ID |
|---|---|---|---|---|---|---|
| **M1** | Core Foundation, Contracts & Linux Swift Toolchain | Install/verify Swift 6.x + `cocoapods-core` on Linux host; author `Package.swift` (all targets + 1-line module anchors); implement `KioskCore` (`KioskHostConfig` + validation, models, all DI & cross-coordinator protocols, `LockedBox`, `SystemMonotonicClock`, `KioskLogger`, `PrivacyInfo.xcprivacy`) + `KioskCoreTests`. | none | `Package.swift`, `Sources/KioskCore/**`, `Sources/*/*Anchor.swift`, `Tests/KioskCoreTests/**` | IN_PROGRESS | `9c259f568a0ee307bf22e9875e2a9534` (gen3) |
| **M2** | Tier 1 Auth & Airship/T&A Shift Sync | Implement `KioskAuth` (SHA-256 CryptoKit/pure-Swift, RFC 7636 PKCE, `prompt=login` URL builder, JWT claims parser, max-1 `PendingRevocationQueue`, generation-guarded `SingleFlightTokenManager`, `AssociateAuthController`) and `KioskTimeclock` (`TimeclockHTTPClient`, 2s-coalesced `ShiftSyncCoordinator` with push/foreground/5m poll, 5s 1x retry, 15m monotonic fail-closed) + full unit tests. | M1 | `Sources/KioskAuth/**` (excl. Anchor), `Sources/KioskTimeclock/**` (excl. Anchor), `Tests/KioskAuthTests/**`, `Tests/KioskTimeclockTests/**` | PLANNED | — |
| **M3** | Split Networking, Two-Tier Lifecycle, Hardware Safety, Crash Breaker & Snapshot Verifier | Implement `KioskNetworking` (`DomainAllowlistPolicy`, `SessionRequestRegistry`, `ReplayableBodyClassifier`, `CustomerNetworkPolicyEngine`), `KioskLifecycle` (`KioskStateMachine`, `TeardownHoldController` 90s non-extendable watchdog, reboot-safe `CrashCircuitBreaker`, `BootSweepCoordinator`, `KioskLifecycleController`, `KioskHost` static API), and `KioskVerification` (`SandboxSnapshotVerifier`) + full unit tests. | M1 | `Sources/KioskNetworking/**`, `Sources/KioskLifecycle/**`, `Sources/KioskVerification/**` (excl. Anchors), `Tests/KioskNetworkingTests/**`, `Tests/KioskLifecycleTests/**`, `Tests/KioskVerificationTests/**` | PLANNED | — |
| **M4** | Native iOS Platform Adapters & `KioskShellAssembly` | Implement `KioskIOS` (`#if os(iOS) && canImport(UIKit)`): `KeychainTokenStore`, `KioskWKWebViewAuthController`, `KioskURLSessionTransport`, `KioskNetworkingSessionProvider` (3 backing `URLSession`s), `KioskURLProtocol`, `KioskAirshipAdapter` (`isChannelCaptureEnabled = false`), `KioskTextInputSanitizer`, `KioskOSSanitizer`, `KioskWindow`, `KioskLoginViewController`, `KioskLaneClosedViewController`, `UserDefaultsCrashRecordStore`, `KioskFilesystemSandboxInspector`, `KioskShellAssembly` + Linux compile & structural tests. | M1, M2, M3 | `Sources/KioskIOS/**` (excl. Anchor), `Tests/KioskIOSTests/**` | PLANNED | — |
| **M5** | JS/TS `@internal/kiosk-host` Package, Memory Storage Shims, Metro & CI Guardrails | Implement `package.json` (`@internal/kiosk-host` + `codegenConfig`), `tsconfig.json`, Codegen specs (`NativeKioskAssociate/Config/Session`), exact PRD §6 TS facades + `errorGuards.ts`, full in-memory `Map` shims for `AsyncStorage` & `MMKV` (v3+v4), Metro `withKioskHost` guardrail (alias + `react-native-webview` build block), `scripts/check-kiosk-lockfile.mjs`, and `__tests__/**` + fixtures. | none | `package.json`, `package-lock.json`, `tsconfig.json`, `jest.config.*`, `src/**`, `scripts/check-kiosk-lockfile.mjs`, `__tests__/**` | DONE (158/158 Jest + 10/10 ESM, 5/5 Gate PASS) | `08c1a3bf8bc7f7507b7219b5ace40103` (gen3) |
| **M6** | RN Bridgeless ObjC++ Bridge, `KioskAppDelegate`, Podspec, Integration/Soak Suite & Retrofit Docs | Implement `ios/KioskReactNative/**` (`KioskHostBridge.swift`, `KioskAppDelegate.swift`, `KioskRCTHostManager.swift`, `KioskRCTHostAdapter.{h,mm}`, `KioskHTTPRequestHandler.{h,mm}`, `KioskNetworkHook.{h,mm}`, `KioskFatalErrorBridge.{h,mm}`, `KioskFabricTextInputHook.{h,mm}`, `TurboModules/RCTKiosk{Associate,Config,Session}.{h,mm}`), `KioskHost.podspec`, `react-native.config.js`, `Tests/ObjCStubHeaders/**`, `scripts/verify-objc-syntax.sh`, `scripts/verify-podspec.rb`, `Tests/KioskIntegrationTests/**` (4 PRD §7 scenarios + 1,000-cycle soak), `docs/RETROFIT_GUIDE.md`, `examples/**`, `.github/workflows/**`, `README.md`. | M4, M5 | `ios/KioskReactNative/**`, `KioskHost.podspec`, `react-native.config.js`, `Tests/ObjCStubHeaders/**`, `Tests/KioskIntegrationTests/**`, `scripts/verify-objc-syntax.sh`, `scripts/verify-podspec.rb`, `docs/**`, `examples/**`, `.github/workflows/**`, `README.md` | PLANNED | — |
| **E2E** | E2E Testing Track (Parallel Dual Track) | Requirement-driven opaque-box test suite covering `FEAT-01`..`FEAT-16`: publish `TEST_INFRA.md`, build `e2e/` runner (`e2e/run-e2e.sh`, `e2e/swift/Package.swift`, `e2e/js/`, `e2e/ios-structural/`), implement Tiers 1–4 (>=80 T1 + >=80 T2 + >=16 T3 + >=8 T4 = >=184 tests), publish `TEST_READY.md`. | none | `TEST_INFRA.md`, `TEST_READY.md`, `e2e/**` | IN_PROGRESS | `f92bac5e2848b0c9c3e93e1b5be9c058` (gen2) |
| **M7** | Final Milestone: E2E Pass (Tiers 1–4) + Adversarial Hardening (Tier 5) | **Phase 1:** Wait for `TEST_READY.md`, run sequential sub-milestones `Tier 1 -> Tier 2 -> Tier 3 -> Tier 4` until 100% E2E pass. **Phase 2:** Dedicated Tier-5 white-box Challenger-led adversarial hardening loop until Challengers report zero remaining gaps. | M6, E2E (`TEST_READY.md`) | Integration fixes across repo + Tier 5 tests | PLANNED | — |

---

## Interface Contracts

### Dual-Build Swift Import Convention
Every Swift file outside `KioskCore` MUST wrap sibling module imports with `#if canImport(...)` so the codebase compiles identically in multi-module SwiftPM AND single-module CocoaPods (`KioskHost`):
```swift
#if canImport(KioskCore)
import KioskCore
#endif
```
And every file using Foundation URL networking types MUST include:
```swift
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
```

### `KioskCore` Frozen Public Contracts (`M1`)

#### Configuration & Models
```swift
public enum KioskMetricValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
}

public typealias KioskHostMetricHandler = @Sendable (_ name: String, _ attributes: [String: KioskMetricValue]) -> Void

public struct KioskDeviceConfig: Sendable, Equatable, Codable {
    public enum Environment: String, Sendable, Equatable, Codable { case dev, stage, prod }
    public let storeId: String
    public let kioskId: String
    public let terminalId: String
    public let environment: Environment
}

public struct AssociateProfile: Sendable, Equatable, Codable {
    public let associateId: String
    public let displayName: String
    public let roles: [String]
    public let permissions: [String]
    public let storeId: String
}

public enum SessionEndReason: String, Sendable, Equatable, Codable {
    case completed = "COMPLETED"
    case canceled = "CANCELED"
    case error = "ERROR"
}

public enum AssociateStateHeader: String, Sendable, Equatable {
    case active = "ACTIVE"
    case draining = "DRAINING"
}

public enum AssociateSessionState: Sendable, Equatable {
    case bootingShell
    case loggedOut
    case authenticating
    case active(AssociateProfile)
    case draining(AssociateProfile, drainDeadlineMonotonicMs: Int64)
    case loggingOut
    case laneClosed(reason: String)
}

public enum CustomerSessionState: Sendable, Equatable {
    case unmounted
    case booting(sessionId: String)
    case ready(sessionId: String)
    case active(sessionId: String, startedMonotonicMs: Int64)
    case tearingDown(sessionId: String)
}

public enum ShiftStatus: String, Sendable, Equatable, Codable {
    case clockedIn = "CLOCKED_IN"
    case clockedOut = "CLOCKED_OUT"
}

public enum ShiftSyncTrigger: String, Sendable, Equatable {
    case postLogin, airshipPush, foreground, periodicPoll
}

public struct OAuthTokens: Sendable, Equatable, Codable {
    public let accessToken: String
    public let refreshToken: String?
    public let idToken: String?
    public let expiresAtMonotonicMs: Int64
    public let scope: String?
}

public struct CrashRecord: Sendable, Equatable, Codable {
    public let monotonicMs: Int64
    public let bootSessionId: String
    public let reason: String
}

public struct KioskHostConfig: Sendable {
    public struct PFedConfig: Sendable, Equatable {
        public let issuerUrl: URL
        public let authorizationEndpoint: URL
        public let tokenEndpoint: URL
        public let revocationEndpoint: URL          // /as/revoke_token.oauth2
        public let clientId: String
        public let redirectUri: URL
        public let scopes: [String]
        public let additionalAllowedAuthHosts: [String] // Default: []
    }
    public struct TimeclockConfig: Sendable, Equatable {
        public let statusEndpointUrl: URL
        public let deviceBindEndpointUrl: URL?
        public let pollIntervalMs: Int64            // Default: 300_000 (5 min)
        public let offlineLogoutThresholdMs: Int64  // Default: 900_000 (15 min monotonic)
        public let maxDrainDurationMs: Int64        // Default: 300_000 (5 min)
        public let debounceWindowMs: Int64          // Default: 2_000 (2s coalesce)
        public let networkRetryDelayMs: Int64       // Default: 5_000 (5s 1x retry)
    }
    public struct NetworkConfig: Sendable, Equatable {
        public let allowedInternalDomains: Set<String>     // Lowercased exact hostnames; disjoint from public
        public let allowedPublicAssetDomains: Set<String>  // Lowercased exact hostnames; disjoint from internal
        public let proactiveRefreshBufferSec: Int64        // Default: 30
        public let maxRetryBodyBytes: Int                  // Default: 1_048_576 (1 MiB)
    }
    public struct CustomerSessionConfig: Sendable, Equatable {
        public let hardIdleTimeoutMs: Int64            // Default: 60_000
        public let screenReaderMultiplier: Double      // Default: 2.5 (150_000 when VoiceOver on)
        public let maxHoldDurationMs: Int64            // Default: 90_000
        public let crashCircuitBreakerCount: Int       // Default: 3
        public let crashCircuitBreakerWindowMs: Int64  // Default: 30_000
        public let healthyResetDurationMs: Int64       // Default: 60_000
    }

    public let pfed: PFedConfig
    public let timeclock: TimeclockConfig
    public let network: NetworkConfig
    public let customerSession: CustomerSessionConfig
    public let device: KioskDeviceConfig
    public let onHostMetric: KioskHostMetricHandler?

    public func validate() throws
}
```

#### Core DI & Cross-Coordinator Protocols (`KioskCore/Protocols/`)
- `MonotonicClock`: `nowMonotonicMs: Int64`, `bootSessionId: String`, `sleep(milliseconds: Int64) async throws`
- `SecureTokenStore`: `saveTokens`, `loadTokens`, `deleteTokens`, `savePendingRevocationToken`, `loadPendingRevocationToken`, `deletePendingRevocationToken`, `snapshotAuthNamespaceKeys`, `wipeAuthNamespace`
- `HTTPRequest` (`url`, `method`, `headers`, `body`, `isOneShotBody`) / `HTTPResponse` (`statusCode`, `headers`, `body`, `finalURL`) / `HTTPTransport` (`send(_:) async throws -> HTTPResponse`)
- `OAuthWebViewPresenter`: `@MainActor func authenticate(authorizeURL: URL, allowedHosts: Set<String>, redirectScheme: String) async throws -> URL`
- `AirshipBridge`: `var channelId: String? { get async }`, `identifyAssociate(_:) async throws`, `resetAssociate() async throws`, `setSilentPushTickleHandler(_:)`
- `CustomerRuntimeHost`: `@MainActor preboot(sessionId:)`, `mountReadySurface(sessionId:)`, `maskCustomerView()`, `teardownNonBlocking(sessionId:reason:)`, `showLoginScreen(errorMessage:)`, `showLaneClosedScreen(reason:)`
- `OSSanitizer`: `@MainActor installGlobalInputSanitization()`, `dismissKeyboardAndSanitize()`, `clearClipboard()`, `stopSpeechSynthesis()`, `showPrivacyShield()`, `hidePrivacyShield()`, `isScreenReaderActive: Bool`, `observeScreenReaderChanges(_:) -> any KioskCancellable`
- `CrashRecordStore`: `loadCrashRecords()`, `saveCrashRecords(_:)`, `clearCrashRecords()`
- `KioskTelemetrySink`: `emit(name: String, attributes: [String: KioskMetricValue])`
- `KioskCancellable`: `AnyObject, Sendable` with `func cancel()` and `func close()`
- `SandboxInspector`: `captureFilesystemSnapshot(excludedSubpaths:)`, `captureKeychainAuthKeys()`, `captureHTTPCookieCount()`, `captureInternalCachedURLs(internalDomains:)`, `captureClipboardHasContent()`
- Cross-Coordinator Protocols (decoupling `M2` ↔ `M3`): `AccessTokenProvider`, `AssociateAuthControlling`, `ShiftSyncControlling`, `LifecycleShiftDelegate`, `CustomerSessionNetworkController`

### Public Module Entry Points (`M2` / `M3` / `M4` — Opaque-Box Surface)
All Swift library products (`KioskCore`, `KioskAuth`, `KioskTimeclock`, `KioskNetworking`, `KioskLifecycle`, `KioskVerification`, `KioskIOS`) expose these canonical public types (exact method signatures refined in M2/M3 while preserving these public names and behaviors):
- **`KioskAuth` (`M2`):**
  - `SHA256Hasher` (`hash(_ data: Data) -> Data`, `base64URLEncodedHash(of string: String) -> String`)
  - `PKCEGenerator` (`generate() -> PKCEChallenge` with `codeVerifier`, `codeChallenge`, `codeChallengeMethod == "S256"`, `state`)
  - `OAuthAuthorizationURLBuilder` (`buildAuthorizeURL(config:pkce:) -> URL`, `isAllowedNavigationURL(_:config:) -> Bool`, `parseCallback(url:expectedState:config:) throws -> String`)
  - `JWTClaimsParser` (`parseAssociateProfile(idToken:accessToken:defaultStoreId:) throws -> AssociateProfile`)
  - `PendingRevocationQueue` (`enqueue(_ refreshToken: String)`, `flushIfPresent(config:transport:) async -> Bool`) — strictly max-1 slot
  - `SingleFlightTokenManager: AccessTokenProvider` (actor with monotonic `authGeneration` reentrancy guard, 30s proactive refresh, single-flight `401` refresh, `invalid_grant` propagation)
  - `AssociateAuthController: AssociateAuthControlling` (coordinates disposable WebView auth, code exchange, Keychain storage, Airship bind/unbind, `/as/revoke_token.oauth2` & offline pending queue, boot sweep)
- **`KioskTimeclock` (`M2`):**
  - `TimeclockHTTPClient` (`fetchShiftStatus(accessToken:) async throws -> ShiftStatus`, `bindDevice(...)`, `unbindDevice(...)`)
  - `ShiftSyncCoordinator: ShiftSyncControlling` (actor with 2s coalesced `checkShiftStatus()`, APNs push tickle / foreground / 5m monotonic poll, 5s 1x retry, 15m monotonic offline fail-closed)
- **`KioskNetworking` (`M3`):**
  - `DomainAllowlistPolicy` (`classify(url:) -> DomainClassification` `.internalDomain | .publicAssetDomain | .blocked`, `evaluateRedirect(from:to:) -> RedirectDecision`)
  - `SessionRequestRegistry` (`register(sessionId:cancel:) -> UUID`, `unregister(_:)`, `cancelAll(forSessionId:) -> Int`, `isSessionActive(_:) -> Bool`)
  - `ReplayableBodyClassifier` (`classify(body:hasStream:contentLength:maxRetryBodyBytes:) -> BodyReplayability`)
  - `CustomerNetworkPolicyEngine: CustomerSessionNetworkController` (executes customer requests with `NO_COOKIES`, Bearer + `X-Kiosk-Associate-State`, `Cache-Control: no-store` on internal domains, `3xx` cross-host Auth strip & external redirect block, single-flight `401` 1-retry max skipping `isOneShotBody`, and `SessionTag` cancellation)
- **`KioskLifecycle` (`M3`):**
  - `KioskStateMachine` (pure value-type Tier 1 × Tier 2 transition reducer)
  - `TeardownHoldController` (non-extendable monotonic 90s watchdog; `setHold(_:)`, `isHeld`, `holdStartedMonotonicMs`)
  - `CrashCircuitBreaker` (reboot-safe persisted `CrashRecord` store; `recordCrash(reason:) -> Bool`, `isTripped() -> Bool`, `markHealthySessionCompleted()`, `resetManually()`)
  - `BootSweepCoordinator` (`performBootSweep() async -> BootSweepResult`)
  - `KioskLifecycleController: LifecycleShiftDelegate` (actor orchestrating boot sweep, login, pre-boot, 0ms `READY -> ACTIVE`, monotonic idle kill switch with VoiceOver 2.5x, `endSession`, `holdTeardown`, drain 5m cap, synchronous `teardownListeners`, non-blocking teardown, crash strikes, and `LANE_CLOSED` recovery)
  - `KioskHost` (static peripheral API below)
- **`KioskVerification` (`M3`):**
  - `SandboxSnapshotVerifier` (`captureBaseline()`, `verifyCleanAfterCustomerTeardown()`, `verifyCleanAfterAssociateLogout()` -> `IsolationVerificationResult` with detailed diff)

### `KioskLifecycle` Peripheral API (`M3` + ObjC Bridge in `M6`)
```swift
public final class KioskHost: @unchecked Sendable {
    public static let shared: KioskHost
    public static func notifyActivity()
    public static func setHoldTeardown(_ active: Bool)
    @discardableResult
    public static func addTeardownListener(_ listener: @escaping @Sendable () -> Void) -> any KioskCancellable
}
```

### TypeScript Public Contracts & Codegen Specs (`@internal/kiosk-host` — `M5`)
- Public exports (`src/index.ts`): exact PRD §6 interfaces (`KioskHostConfig`, `AssociateProfile`, `KioskDeviceConfig`, `SessionEndReason`, `KioskAssociateSpec`, `KioskConfigSpec`, `KioskSessionSpec`) + singletons `KioskAssociate`, `KioskConfig`, `KioskSession` (with `readonly sessionId` ES getter backed by `NativeKioskSession.getConstants().sessionId` / `getSessionId()`) + `installKioskErrorGuards()`.
- Codegen specs (`src/specs/`): `NativeKioskAssociate.ts`, `NativeKioskConfig.ts`, `NativeKioskSession.ts`.
- Subpath exports (`package.json`):
  - `.` -> public facades, types, `installKioskErrorGuards`
  - `./memory-storage` -> combined export + `createMemoryStorageRuntime()`
  - `./memory-storage/async-storage` -> in-memory `Map`-backed `AsyncStorage` shim
  - `./memory-storage/mmkv` -> in-memory `Map`-backed `MMKV` (v3 + v4) shim
  - `./metro` -> `withKioskHost(metroConfig)` helper

### Canonical `onHostMetric` Event Names (PII-Free)
`kiosk.session.activated`, `kiosk.session.ended`, `kiosk.session.recovery_ms`, `kiosk.session.idle_timeout`, `kiosk.session.hold_watchdog_expired`, `kiosk.associate.login_succeeded`, `kiosk.associate.login_failed`, `kiosk.associate.logout`, `kiosk.timeclock.poll`, `kiosk.timeclock.drain_started`, `kiosk.timeclock.drain_expired`, `kiosk.timeclock.offline_logout`, `kiosk.auth.token_refresh`, `kiosk.auth.token_revoke`, `kiosk.network.host_blocked`, `kiosk.network.redirect_auth_stripped`, `kiosk.crash.recorded`, `kiosk.crash.circuit_breaker_tripped`, `kiosk.crash.circuit_breaker_cleared`, `kiosk.crash.circuit_breaker_manual_reset`.

### E2E Test Runner Interface (`e2e/` — E2E Testing Track)
- Command: `./e2e/run-e2e.sh [--tier 1|2|3|4|all]` (exit code `0` = all selected tier tests pass; non-zero = failure).
- Self-contained SwiftPM consumer package at `e2e/swift/Package.swift` depending on `.package(path: "../..")` (opaque-box public products only) + Node v22 `e2e/js/` tests + `e2e/ios-structural/` contract verification.

---

## Code Layout

```text
/home/antigravity/0x8badf00d/RNTxnContainer/
├── Package.swift                                    # [M1] SwiftPM manifest (targets + products + test targets)
├── KioskHost.podspec                                # [M6] CocoaPods RN New Arch spec
├── react-native.config.js                           # [M6] RN CLI iOS autolinking
├── package.json                                     # [M5] @internal/kiosk-host + codegenConfig
├── tsconfig.json                                    # [M5] Strict TS config
├── PROJECT.md                                       # [Orchestrator] Global architecture & milestone SSOT
├── TEST_INFRA.md                                    # [E2E] Opaque-box E2E architecture & feature matrix
├── TEST_READY.md                                    # [E2E] E2E completion signal & coverage summary
├── Sources/
│   ├── KioskCore/                                   # [M1] Pure Swift Core contracts, clock, LockedBox, PrivacyInfo
│   ├── KioskAuth/                                   # [M2] PKCE, OAuth, JWT claims, RevocationQueue, SingleFlight
│   ├── KioskTimeclock/                              # [M2] T&A HTTP client, 2s-coalesced ShiftSyncCoordinator
│   ├── KioskNetworking/                             # [M3] Domain allowlist, SessionTag registry, 3xx/401 policy engine
│   ├── KioskLifecycle/                              # [M3] Two-tier state machine, 90s hold, crash breaker, KioskHost
│   ├── KioskVerification/                           # [M3] Debug SandboxSnapshotVerifier
│   └── KioskIOS/                                    # [M4] #if os(iOS) && canImport(UIKit) native iOS adapters
├── ios/
│   └── KioskReactNative/                            # [M6] Bridgeless RCTHost, RCTHTTPRequestHandler, Fabric TextInput,
│       ├── KioskHostBridge.swift                    #      ObjC++ TurboModules, KioskAppDelegate
│       ├── KioskAppDelegate.swift
│       ├── KioskRCTHostManager.swift
│       ├── KioskRCTHostAdapter.{h,mm}
│       ├── KioskHTTPRequestHandler.{h,mm}
│       ├── KioskNetworkHook.{h,mm}
│       ├── KioskFatalErrorBridge.{h,mm}
│       ├── KioskFabricTextInputHook.{h,mm}
│       └── TurboModules/RCTKiosk{Associate,Config,Session}.{h,mm}
├── src/                                             # [M5] TypeScript package, TurboModule specs, storage shims, Metro
├── scripts/
│   ├── check-kiosk-lockfile.mjs                     # [M5] CI Podfile.lock & gradle.lockfile forbidden-pod check
│   ├── verify-objc-syntax.sh                        # [M6] Linux clang++ --target=arm64-apple-ios16.0 ObjC++ ARC check
│   └── verify-podspec.rb                            # [M6] Linux Ruby + cocoapods-core KioskHost.podspec validator
├── Tests/
│   ├── KioskCoreTests/                              # [M1]
│   ├── KioskAuthTests/                              # [M2]
│   ├── KioskTimeclockTests/                         # [M2]
│   ├── KioskNetworkingTests/                        # [M3]
│   ├── KioskLifecycleTests/                         # [M3]
│   ├── KioskVerificationTests/                      # [M3]
│   ├── KioskIOSTests/                               # [M4]
│   ├── KioskIntegrationTests/                       # [M6] 4 PRD §7 scenarios + 1,000-cycle soak
│   └── ObjCStubHeaders/                             # [M6] Non-shipping stub headers for Linux clang++ verification
├── __tests__/                                       # [M5] JS/TS unit & guardrail tests + fixtures
├── e2e/                                             # [E2E] Opaque-box requirement-driven E2E suite (Tiers 1–4)
├── docs/                                            # [M6] RETROFIT_GUIDE.md
├── examples/                                        # [M6] PosKioskAppDelegate.swift, metro.config.js
└── .github/workflows/                               # [M6] ci-linux.yml, ci-macos-ios.yml
```
