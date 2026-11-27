import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KioskCore

// MARK: - 1. TestCancellable

public final class TestCancellable: KioskCancellable, @unchecked Sendable {
    private let lock = NSLock()
    private var _isCancelled: Bool = false
    private var _cancelCallCount: Int = 0
    private var _closeCallCount: Int = 0
    private var onCancelHandler: (@Sendable () -> Void)?

    public init(onCancel: (@Sendable () -> Void)? = nil) {
        self.onCancelHandler = onCancel
    }

    public var isCancelled: Bool {
        lock.withCriticalSection { _isCancelled }
    }

    public var cancelCallCount: Int {
        lock.withCriticalSection { _cancelCallCount }
    }

    public var closeCallCount: Int {
        lock.withCriticalSection { _closeCallCount }
    }

    public func cancel() {
        let handler: (@Sendable () -> Void)? = lock.withCriticalSection {
            _cancelCallCount += 1
            if _isCancelled {
                return nil
            }
            _isCancelled = true
            let callback = onCancelHandler
            onCancelHandler = nil
            return callback
        }
        handler?()
    }

    public func close() {
        let handler: (@Sendable () -> Void)? = lock.withCriticalSection {
            _closeCallCount += 1
            if _isCancelled {
                return nil
            }
            _isCancelled = true
            let callback = onCancelHandler
            onCancelHandler = nil
            return callback
        }
        handler?()
    }
}

// MARK: - 2. FakeOAuthWebViewPresenter

public final class FakeOAuthWebViewPresenter: OAuthWebViewPresenter, @unchecked Sendable {
    public struct Invocation: Sendable, Equatable {
        public let authorizeURL: URL
        public let allowedHosts: Set<String>
        public let redirectScheme: String

        public init(authorizeURL: URL, allowedHosts: Set<String>, redirectScheme: String) {
            self.authorizeURL = authorizeURL
            self.allowedHosts = allowedHosts
            self.redirectScheme = redirectScheme
        }
    }

    public typealias AuthHandler = @Sendable (URL, Set<String>, String) async throws -> URL

    public enum FakeAuthError: Error, Sendable, Equatable {
        case noResponseScripted
        case userCancelled
        case disallowedNavigation(String)
    }

    private let lock = NSLock()
    private var _invocations: [Invocation] = []
    private var queuedHandlers: [AuthHandler] = []
    private var defaultHandler: AuthHandler?

    public init() {}

    @MainActor
    public func authenticate(
        authorizeURL: URL,
        allowedHosts: Set<String>,
        redirectScheme: String
    ) async throws -> URL {
        let handler = recordAndDequeueHandler(
            authorizeURL: authorizeURL,
            allowedHosts: allowedHosts,
            redirectScheme: redirectScheme
        )
        guard let handler else {
            throw FakeAuthError.noResponseScripted
        }
        return try await handler(authorizeURL, allowedHosts, redirectScheme)
    }

    public func scriptSuccess(authorizationCode: String = "e2e-auth-code-001") {
        let code = authorizationCode
        enqueueHandler { authorizeURL, _, _ in
            guard let components = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false),
                  let queryItems = components.queryItems,
                  let redirectRaw = queryItems.first(where: { $0.name == "redirect_uri" })?.value,
                  var callbackComponents = URLComponents(string: redirectRaw) else {
                throw FakeAuthError.disallowedNavigation("Missing or invalid redirect_uri in authorizeURL")
            }
            var items = callbackComponents.queryItems ?? []
            items.append(URLQueryItem(name: "code", value: code))
            if let state = queryItems.first(where: { $0.name == "state" })?.value {
                items.append(URLQueryItem(name: "state", value: state))
            }
            callbackComponents.queryItems = items
            guard let callbackURL = callbackComponents.url else {
                throw FakeAuthError.disallowedNavigation("Unable to compose callback URL from redirect_uri")
            }
            return callbackURL
        }
    }

    public func scriptCallbackURL(_ url: URL) {
        enqueueHandler { _, _, _ in url }
    }

    public func scriptError(_ error: any Error) {
        enqueueHandler { _, _, _ in throw error }
    }

    public func setHandler(_ handler: @escaping AuthHandler) {
        lock.withCriticalSection {
            defaultHandler = handler
        }
    }

    public var invocations: [Invocation] {
        lock.withCriticalSection { _invocations }
    }

    public var invocationCount: Int {
        lock.withCriticalSection { _invocations.count }
    }

    public func reset() {
        lock.withCriticalSection {
            _invocations.removeAll()
            queuedHandlers.removeAll()
            defaultHandler = nil
        }
    }

    private func enqueueHandler(_ handler: @escaping AuthHandler) {
        lock.withCriticalSection {
            queuedHandlers.append(handler)
        }
    }

    private func recordAndDequeueHandler(
        authorizeURL: URL,
        allowedHosts: Set<String>,
        redirectScheme: String
    ) -> AuthHandler? {
        lock.withCriticalSection {
            _invocations.append(
                Invocation(
                    authorizeURL: authorizeURL,
                    allowedHosts: allowedHosts,
                    redirectScheme: redirectScheme
                )
            )
            if !queuedHandlers.isEmpty {
                return queuedHandlers.removeFirst()
            }
            return defaultHandler
        }
    }
}

// MARK: - 3. FakeAirshipBridge

public final class FakeAirshipBridge: AirshipBridge, @unchecked Sendable {
    private let lock = NSLock()
    private var _channelId: String?
    private var _identifiedAssociateIds: [String] = []
    private var _currentAssociateId: String?
    private var _resetAssociateCallCount: Int = 0
    private var _silentPushTickleCount: Int = 0
    private var silentPushTickleHandler: (@Sendable () -> Void)?
    private var identifyError: (any Error)?
    private var resetError: (any Error)?

    public init(channelId: String? = "e2e-airship-channel-001") {
        self._channelId = channelId
    }

    /// Synchronous getter satisfies both synchronous reads and `var channelId: String? { get async }`.
    public var channelId: String? {
        lock.withCriticalSection { _channelId }
    }

    public func setChannelId(_ id: String?) {
        lock.withCriticalSection {
            _channelId = id
        }
    }

    public func identifyAssociate(_ associateId: String) async throws {
        if let err = recordIdentify(associateId) {
            throw err
        }
    }

    public func resetAssociate() async throws {
        if let err = recordReset() {
            throw err
        }
    }

    public func setSilentPushTickleHandler(_ handler: (@Sendable () -> Void)?) {
        lock.withCriticalSection {
            silentPushTickleHandler = handler
        }
    }

    public func simulateSilentPushTickle() {
        let handler: (@Sendable () -> Void)? = lock.withCriticalSection {
            _silentPushTickleCount += 1
            return silentPushTickleHandler
        }
        handler?()
    }

    public var identifiedAssociateIds: [String] {
        lock.withCriticalSection { _identifiedAssociateIds }
    }

    public var currentAssociateId: String? {
        lock.withCriticalSection { _currentAssociateId }
    }

    public var resetAssociateCallCount: Int {
        lock.withCriticalSection { _resetAssociateCallCount }
    }

    public var silentPushTickleCount: Int {
        lock.withCriticalSection { _silentPushTickleCount }
    }

    public var hasSilentPushTickleHandler: Bool {
        lock.withCriticalSection { silentPushTickleHandler != nil }
    }

    public func setIdentifyError(_ error: (any Error)?) {
        lock.withCriticalSection {
            identifyError = error
        }
    }

    public func setResetError(_ error: (any Error)?) {
        lock.withCriticalSection {
            resetError = error
        }
    }

    public func reset() {
        lock.withCriticalSection {
            _identifiedAssociateIds.removeAll()
            _currentAssociateId = nil
            _resetAssociateCallCount = 0
            _silentPushTickleCount = 0
            silentPushTickleHandler = nil
            identifyError = nil
            resetError = nil
        }
    }

    private func recordIdentify(_ associateId: String) -> (any Error)? {
        lock.withCriticalSection {
            if let err = identifyError {
                return err
            }
            _identifiedAssociateIds.append(associateId)
            _currentAssociateId = associateId
            return nil
        }
    }

    private func recordReset() -> (any Error)? {
        lock.withCriticalSection {
            _resetAssociateCallCount += 1
            if let err = resetError {
                return err
            }
            _currentAssociateId = nil
            return nil
        }
    }
}

// MARK: - 4. FakeCustomerRuntimeHost

public final class FakeCustomerRuntimeHost: CustomerRuntimeHost, @unchecked Sendable {
    public enum Event: Sendable, Equatable {
        case preboot(sessionId: String)
        case mountReadySurface(sessionId: String)
        case maskCustomerView
        case teardownNonBlocking(sessionId: String, reason: String)
        case showLoginScreen(errorMessage: String?)
        case showLaneClosedScreen(reason: String)
    }

    private struct PrebootPlan: Sendable {
        let delay: ScriptedHTTPTransport.DelayMode
        let error: (any Error)?
        let handler: (@Sendable (String) async throws -> Void)?
        let eventCallback: (@Sendable (String) -> Void)?
    }

    private let lock = NSLock()
    private var _events: [Event] = []
    private var _prebootedSessionIds: [String] = []
    private var _mountedSessionIds: [String] = []
    private var _tornDownSessions: [(sessionId: String, reason: String)] = []
    private var _maskCount: Int = 0
    private var _lastLoginErrorMessage: String?
    private var _lastLaneClosedReason: String?
    private var _activeSessionId: String?

    private var onEventCallback: (@Sendable (String) -> Void)?
    private var prebootDelay: ScriptedHTTPTransport.DelayMode = .none
    private var queuedPrebootErrors: [any Error] = []
    private var prebootHandler: (@Sendable (String) async throws -> Void)?
    private var teardownHook: (@Sendable (_ sessionId: String, _ reason: String) -> Void)?

    public init(onEvent: (@Sendable (String) -> Void)? = nil) {
        self.onEventCallback = onEvent
    }

    @MainActor
    public func preboot(sessionId: String) async throws {
        let plan = beginPreboot(sessionId: sessionId)
        plan.eventCallback?("runtime.preboot:\(sessionId)")

        switch plan.delay {
        case .none:
            break
        case .realNanoseconds(let ns):
            if ns > 0 {
                try await Task.sleep(nanoseconds: ns)
            }
        case .virtualClock(let clock, let ms):
            try await clock.sleep(milliseconds: ms)
        }

        if let err = plan.error {
            throw err
        }
        if let handler = plan.handler {
            try await handler(sessionId)
        }
    }

    @MainActor
    public func mountReadySurface(sessionId: String) {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.mountReadySurface(sessionId: sessionId))
            _mountedSessionIds.append(sessionId)
            _activeSessionId = sessionId
            return onEventCallback
        }
        cb?("runtime.mountReadySurface:\(sessionId)")
    }

    @MainActor
    public func maskCustomerView() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.maskCustomerView)
            _maskCount += 1
            return onEventCallback
        }
        cb?("runtime.maskCustomerView")
    }

    @MainActor
    public func teardownNonBlocking(sessionId: String, reason: String) {
        let (cb, hook): ((@Sendable (String) -> Void)?, (@Sendable (String, String) -> Void)?) =
            lock.withCriticalSection {
                _events.append(.teardownNonBlocking(sessionId: sessionId, reason: reason))
                _tornDownSessions.append((sessionId: sessionId, reason: reason))
                if _activeSessionId == sessionId {
                    _activeSessionId = nil
                }
                return (onEventCallback, teardownHook)
            }
        cb?("runtime.teardownNonBlocking:\(sessionId):\(reason)")
        hook?(sessionId, reason)
    }

    @MainActor
    public func showLoginScreen(errorMessage: String?) {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.showLoginScreen(errorMessage: errorMessage))
            _lastLoginErrorMessage = errorMessage
            _activeSessionId = nil
            return onEventCallback
        }
        cb?("runtime.showLoginScreen")
    }

    @MainActor
    public func showLaneClosedScreen(reason: String) {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.showLaneClosedScreen(reason: reason))
            _lastLaneClosedReason = reason
            _activeSessionId = nil
            return onEventCallback
        }
        cb?("runtime.showLaneClosedScreen:\(reason)")
    }

    // MARK: - Configuration & Inspection

    public func setOnEvent(_ callback: (@Sendable (String) -> Void)?) {
        lock.withCriticalSection {
            onEventCallback = callback
        }
    }

    public func setPrebootDelay(_ delay: ScriptedHTTPTransport.DelayMode) {
        lock.withCriticalSection {
            prebootDelay = delay
        }
    }

    public func enqueuePrebootError(_ error: any Error) {
        lock.withCriticalSection {
            queuedPrebootErrors.append(error)
        }
    }

    public func setPrebootHandler(_ handler: (@Sendable (String) async throws -> Void)?) {
        lock.withCriticalSection {
            prebootHandler = handler
        }
    }

    public func setTeardownHook(_ hook: (@Sendable (_ sessionId: String, _ reason: String) -> Void)?) {
        lock.withCriticalSection {
            teardownHook = hook
        }
    }

    public var events: [Event] {
        lock.withCriticalSection { _events }
    }

    public var prebootedSessionIds: [String] {
        lock.withCriticalSection { _prebootedSessionIds }
    }

    public var mountedSessionIds: [String] {
        lock.withCriticalSection { _mountedSessionIds }
    }

    public var tornDownSessions: [(sessionId: String, reason: String)] {
        lock.withCriticalSection { _tornDownSessions }
    }

    public var maskCount: Int {
        lock.withCriticalSection { _maskCount }
    }

    public var lastLoginErrorMessage: String? {
        lock.withCriticalSection { _lastLoginErrorMessage }
    }

    public var lastLaneClosedReason: String? {
        lock.withCriticalSection { _lastLaneClosedReason }
    }

    public var activeSessionId: String? {
        lock.withCriticalSection { _activeSessionId }
    }

    public func reset() {
        lock.withCriticalSection {
            _events.removeAll()
            _prebootedSessionIds.removeAll()
            _mountedSessionIds.removeAll()
            _tornDownSessions.removeAll()
            _maskCount = 0
            _lastLoginErrorMessage = nil
            _lastLaneClosedReason = nil
            _activeSessionId = nil
            prebootDelay = .none
            queuedPrebootErrors.removeAll()
            prebootHandler = nil
            teardownHook = nil
        }
    }

    private func beginPreboot(sessionId: String) -> PrebootPlan {
        lock.withCriticalSection {
            _events.append(.preboot(sessionId: sessionId))
            _prebootedSessionIds.append(sessionId)
            let err = queuedPrebootErrors.isEmpty ? nil : queuedPrebootErrors.removeFirst()
            return PrebootPlan(
                delay: prebootDelay,
                error: err,
                handler: prebootHandler,
                eventCallback: onEventCallback
            )
        }
    }
}

// MARK: - 5. FakeOSSanitizer

public final class FakeOSSanitizer: OSSanitizer, @unchecked Sendable {
    public enum Event: Sendable, Equatable {
        case installGlobalInputSanitization
        case dismissKeyboardAndSanitize
        case clearClipboard
        case stopSpeechSynthesis
        case showPrivacyShield
        case hidePrivacyShield
    }

    private let lock = NSLock()
    private var _events: [Event] = []
    private var _installGlobalInputSanitizationCount: Int = 0
    private var _dismissKeyboardAndSanitizeCount: Int = 0
    private var _clearClipboardCount: Int = 0
    private var _stopSpeechSynthesisCount: Int = 0
    private var _showPrivacyShieldCount: Int = 0
    private var _hidePrivacyShieldCount: Int = 0
    private var _isPrivacyShieldVisible: Bool = false
    private var _isScreenReaderActive: Bool
    private var nextObserverId: UInt64 = 1
    private var screenReaderObservers: [UInt64: @Sendable (Bool) -> Void] = [:]
    private var onEventCallback: (@Sendable (String) -> Void)?
    private var onClearClipboardCallback: (@Sendable () -> Void)?

    public init(
        isScreenReaderActive: Bool = false,
        onEvent: (@Sendable (String) -> Void)? = nil,
        onClearClipboard: (@Sendable () -> Void)? = nil
    ) {
        self._isScreenReaderActive = isScreenReaderActive
        self.onEventCallback = onEvent
        self.onClearClipboardCallback = onClearClipboard
    }

    @MainActor
    public func installGlobalInputSanitization() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.installGlobalInputSanitization)
            _installGlobalInputSanitizationCount += 1
            return onEventCallback
        }
        cb?("sanitizer.installGlobalInputSanitization")
    }

    @MainActor
    public func dismissKeyboardAndSanitize() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.dismissKeyboardAndSanitize)
            _dismissKeyboardAndSanitizeCount += 1
            return onEventCallback
        }
        cb?("sanitizer.dismissKeyboardAndSanitize")
    }

    @MainActor
    public func clearClipboard() {
        let (cb, clearCb): ((@Sendable (String) -> Void)?, (@Sendable () -> Void)?) =
            lock.withCriticalSection {
                _events.append(.clearClipboard)
                _clearClipboardCount += 1
                return (onEventCallback, onClearClipboardCallback)
            }
        cb?("sanitizer.clearClipboard")
        clearCb?()
    }

    @MainActor
    public func stopSpeechSynthesis() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.stopSpeechSynthesis)
            _stopSpeechSynthesisCount += 1
            return onEventCallback
        }
        cb?("sanitizer.stopSpeechSynthesis")
    }

    @MainActor
    public func showPrivacyShield() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.showPrivacyShield)
            _showPrivacyShieldCount += 1
            _isPrivacyShieldVisible = true
            return onEventCallback
        }
        cb?("sanitizer.showPrivacyShield")
    }

    @MainActor
    public func hidePrivacyShield() {
        let cb: (@Sendable (String) -> Void)? = lock.withCriticalSection {
            _events.append(.hidePrivacyShield)
            _hidePrivacyShieldCount += 1
            _isPrivacyShieldVisible = false
            return onEventCallback
        }
        cb?("sanitizer.hidePrivacyShield")
    }

    @MainActor
    public var isScreenReaderActive: Bool {
        lock.withCriticalSection { _isScreenReaderActive }
    }

    @MainActor
    public func observeScreenReaderChanges(
        _ handler: @escaping @Sendable (Bool) -> Void
    ) -> any KioskCancellable {
        let observerId: UInt64 = lock.withCriticalSection {
            let id = nextObserverId
            nextObserverId &+= 1
            screenReaderObservers[id] = handler
            return id
        }
        return TestCancellable { [weak self] in
            self?.removeScreenReaderObserver(id: observerId)
        }
    }

    public func setScreenReaderActive(_ active: Bool) {
        let observers: [@Sendable (Bool) -> Void] = lock.withCriticalSection {
            _isScreenReaderActive = active
            return screenReaderObservers
                .sorted { $0.key < $1.key }
                .map(\.value)
        }
        for observer in observers {
            observer(active)
        }
    }

    public var currentScreenReaderActive: Bool {
        lock.withCriticalSection { _isScreenReaderActive }
    }

    public var events: [Event] {
        lock.withCriticalSection { _events }
    }

    public var installGlobalInputSanitizationCount: Int {
        lock.withCriticalSection { _installGlobalInputSanitizationCount }
    }

    public var dismissKeyboardAndSanitizeCount: Int {
        lock.withCriticalSection { _dismissKeyboardAndSanitizeCount }
    }

    public var clearClipboardCount: Int {
        lock.withCriticalSection { _clearClipboardCount }
    }

    public var stopSpeechSynthesisCount: Int {
        lock.withCriticalSection { _stopSpeechSynthesisCount }
    }

    public var showPrivacyShieldCount: Int {
        lock.withCriticalSection { _showPrivacyShieldCount }
    }

    public var hidePrivacyShieldCount: Int {
        lock.withCriticalSection { _hidePrivacyShieldCount }
    }

    public var isPrivacyShieldVisible: Bool {
        lock.withCriticalSection { _isPrivacyShieldVisible }
    }

    public var activeScreenReaderObserverCount: Int {
        lock.withCriticalSection { screenReaderObservers.count }
    }

    public func reset() {
        lock.withCriticalSection {
            _events.removeAll()
            _installGlobalInputSanitizationCount = 0
            _dismissKeyboardAndSanitizeCount = 0
            _clearClipboardCount = 0
            _stopSpeechSynthesisCount = 0
            _showPrivacyShieldCount = 0
            _hidePrivacyShieldCount = 0
            _isPrivacyShieldVisible = false
            _isScreenReaderActive = false
            screenReaderObservers.removeAll()
        }
    }

    private func removeScreenReaderObserver(id: UInt64) {
        lock.withCriticalSection {
            _ = screenReaderObservers.removeValue(forKey: id)
        }
    }
}

// MARK: - 6. InMemoryCrashRecordStore

public final class InMemoryCrashRecordStore: CrashRecordStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [CrashRecord]
    private var _loadCallCount: Int = 0
    private var _saveCallCount: Int = 0
    private var _clearCallCount: Int = 0

    public init(initialRecords: [CrashRecord] = []) {
        self.records = initialRecords
    }

    public func loadCrashRecords() -> [CrashRecord] {
        lock.withCriticalSection {
            _loadCallCount += 1
            return records
        }
    }

    public func saveCrashRecords(_ records: [CrashRecord]) {
        lock.withCriticalSection {
            self.records = records
            _saveCallCount += 1
        }
    }

    public func clearCrashRecords() {
        lock.withCriticalSection {
            self.records.removeAll()
            _clearCallCount += 1
        }
    }

    public var storedRecords: [CrashRecord] {
        lock.withCriticalSection { records }
    }

    public var loadCallCount: Int {
        lock.withCriticalSection { _loadCallCount }
    }

    public var saveCallCount: Int {
        lock.withCriticalSection { _saveCallCount }
    }

    public var clearCallCount: Int {
        lock.withCriticalSection { _clearCallCount }
    }

    public func reset() {
        lock.withCriticalSection {
            records.removeAll()
            _loadCallCount = 0
            _saveCallCount = 0
            _clearCallCount = 0
        }
    }
}

// MARK: - 7. RecordingTelemetrySink

public final class RecordingTelemetrySink: KioskTelemetrySink, @unchecked Sendable {
    public struct RecordedMetric: Sendable, Equatable {
        public let name: String
        public let attributes: [String: KioskMetricValue]

        public init(name: String, attributes: [String: KioskMetricValue]) {
            self.name = name
            self.attributes = attributes
        }
    }

    public static let defaultForbiddenPIIKeys: Set<String> = [
        "access_token",
        "refresh_token",
        "id_token",
        "token",
        "authorization",
        "bearer",
        "password",
        "secret",
        "ssn",
        "pan",
        "card_number",
        "cvv",
        "pin",
        "email",
        "phone",
        "customer_name",
        "display_name",
        "displayname",
        "cart",
        "query",
    ]

    private let lock = NSLock()
    private var _events: [RecordedMetric] = []

    public init() {}

    public func emit(name: String, attributes: [String: KioskMetricValue]) {
        lock.withCriticalSection {
            _events.append(RecordedMetric(name: name, attributes: attributes))
        }
    }

    public func makeMetricHandler() -> KioskHostMetricHandler {
        { [weak self] name, attributes in
            self?.emit(name: name, attributes: attributes)
        }
    }

    public func findPIIViolations(
        forbiddenSubstrings: [String] = [],
        forbiddenKeyNames: Set<String> = defaultForbiddenPIIKeys
    ) -> [String] {
        let snapshot = events
        let loweredKeys = Set(forbiddenKeyNames.map { $0.lowercased() })
        let nonEmptySubstrings = forbiddenSubstrings.filter { !$0.isEmpty }
        let sensitiveQueryTokens = ["code=", "token=", "access_token=", "refresh_token=", "id_token=", "client_secret="]
        var violations: [String] = []

        for metric in snapshot {
            for (key, value) in metric.attributes {
                let lowerKey = key.lowercased()
                if loweredKeys.contains(lowerKey) {
                    violations.append("Forbidden PII key '\(key)' on metric '\(metric.name)'")
                }

                if case .string(let strVal) = value {
                    let lowerVal = strVal.lowercased()
                    if lowerVal.contains("bearer ") {
                        violations.append("Bearer token material detected in '\(metric.name).\(key)'")
                    }
                    if strVal.contains("eyJ") && strVal.split(separator: ".").count >= 3 {
                        violations.append("Raw JWT material detected in '\(metric.name).\(key)'")
                    }
                    if lowerVal.contains("?") {
                        for param in sensitiveQueryTokens where lowerVal.contains(param) {
                            violations.append("Sensitive query parameter '\(param)' detected in '\(metric.name).\(key)'")
                        }
                    }
                    for forbidden in nonEmptySubstrings where strVal.contains(forbidden) {
                        violations.append("Forbidden substring detected in '\(metric.name).\(key)'")
                    }
                }
            }
        }
        return violations
    }

    public var events: [RecordedMetric] {
        lock.withCriticalSection { _events }
    }

    public func events(named name: String) -> [RecordedMetric] {
        lock.withCriticalSection {
            _events.filter { $0.name == name }
        }
    }

    public func containsEvent(named name: String) -> Bool {
        lock.withCriticalSection {
            _events.contains { $0.name == name }
        }
    }

    public var isPIIFree: Bool {
        findPIIViolations().isEmpty
    }

    public func reset() {
        lock.withCriticalSection {
            _events.removeAll()
        }
    }
}

// MARK: - 8. FakeSandboxInspector

public final class FakeSandboxInspector: SandboxInspector, @unchecked Sendable {
    private let lock = NSLock()
    private var filesystemPaths: Set<String>
    private var keychainAuthKeys: Set<String>
    private var httpCookieCount: Int
    private var cachedURLs: Set<String>
    private var clipboardHasContent: Bool
    private let linkedTokenStore: InMemoryTokenStore?

    public init(
        filesystemPaths: Set<String> = [],
        keychainAuthKeys: Set<String> = [],
        httpCookieCount: Int = 0,
        cachedURLs: Set<String> = [],
        clipboardHasContent: Bool = false,
        linkedTokenStore: InMemoryTokenStore? = nil
    ) {
        self.filesystemPaths = filesystemPaths
        self.keychainAuthKeys = keychainAuthKeys
        self.httpCookieCount = httpCookieCount
        self.cachedURLs = cachedURLs
        self.clipboardHasContent = clipboardHasContent
        self.linkedTokenStore = linkedTokenStore
    }

    public func captureFilesystemSnapshot(excludedSubpaths: Set<String>) -> Set<String> {
        let normalizedExclusions = excludedSubpaths.map { Self.normalizeSubpath($0) }.filter { !$0.isEmpty }
        return lock.withCriticalSection {
            Set(
                filesystemPaths.filter { rawPath in
                    let normalized = Self.normalizeSubpath(rawPath)
                    for excluded in normalizedExclusions {
                        if normalized == excluded || normalized.hasPrefix("\(excluded)/") {
                            return false
                        }
                    }
                    return true
                }
            )
        }
    }

    public func captureKeychainAuthKeys() -> Set<String> {
        let baseKeys = lock.withCriticalSection { keychainAuthKeys }
        if let store = linkedTokenStore {
            return baseKeys.union(store.snapshotAuthNamespaceKeys())
        }
        return baseKeys
    }

    public func captureHTTPCookieCount() -> Int {
        lock.withCriticalSection { httpCookieCount }
    }

    public func captureInternalCachedURLs(internalDomains: Set<String>) -> Set<String> {
        let loweredDomains = Set(internalDomains.map { $0.lowercased() })
        return lock.withCriticalSection {
            Set(
                cachedURLs.filter { urlString in
                    guard let host = URL(string: urlString)?.host?.lowercased() else {
                        return false
                    }
                    return loweredDomains.contains(host)
                }
            )
        }
    }

    public func captureClipboardHasContent() -> Bool {
        lock.withCriticalSection { clipboardHasContent }
    }

    // MARK: - Dirty-Canary Mutators

    public func addFile(_ path: String) {
        lock.withCriticalSection { _ = filesystemPaths.insert(path) }
    }

    public func removeFile(_ path: String) {
        lock.withCriticalSection { _ = filesystemPaths.remove(path) }
    }

    public func setFiles(_ paths: Set<String>) {
        lock.withCriticalSection { filesystemPaths = paths }
    }

    public func addKeychainAuthKey(_ key: String) {
        lock.withCriticalSection { _ = keychainAuthKeys.insert(key) }
    }

    public func removeKeychainAuthKey(_ key: String) {
        lock.withCriticalSection { _ = keychainAuthKeys.remove(key) }
    }

    public func setKeychainAuthKeys(_ keys: Set<String>) {
        lock.withCriticalSection { keychainAuthKeys = keys }
    }

    public func setHTTPCookieCount(_ count: Int) {
        lock.withCriticalSection { httpCookieCount = count }
    }

    public func addCachedURL(_ urlString: String) {
        lock.withCriticalSection { _ = cachedURLs.insert(urlString) }
    }

    public func removeCachedURL(_ urlString: String) {
        lock.withCriticalSection { _ = cachedURLs.remove(urlString) }
    }

    public func setCachedURLs(_ urls: Set<String>) {
        lock.withCriticalSection { cachedURLs = urls }
    }

    public func setClipboardHasContent(_ hasContent: Bool) {
        lock.withCriticalSection { clipboardHasContent = hasContent }
    }

    public func reset() {
        lock.withCriticalSection {
            filesystemPaths.removeAll()
            keychainAuthKeys.removeAll()
            httpCookieCount = 0
            cachedURLs.removeAll()
            clipboardHasContent = false
        }
    }

    private static func normalizeSubpath(_ raw: String) -> String {
        var result = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while result.hasPrefix("/") {
            result.removeFirst()
        }
        while result.hasSuffix("/") {
            result.removeLast()
        }
        return result
    }
}
