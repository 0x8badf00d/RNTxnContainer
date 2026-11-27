import Foundation
import KioskCore

/// Thread-safe in-memory `SecureTokenStore` double enforcing PRD FR-1's
/// strictly single-slot offline pending revocation queue and exposing
/// call counters and dirty-key injection for isolation verification tests.
public final class InMemoryTokenStore: SecureTokenStore, @unchecked Sendable {
    public static let activeTokensKey = "kiosk.auth.oauth_tokens"
    public static let pendingRevocationKey = "kiosk.auth.pending_revocation_token"

    private let lock = NSLock()
    private var tokens: OAuthTokens?
    private var pendingRevocationToken: String?
    private var extraNamespaceKeys: Set<String> = []
    private var _pendingRevocationHistory: [String] = []

    private var _saveTokensCallCount: Int = 0
    private var _loadTokensCallCount: Int = 0
    private var _deleteTokensCallCount: Int = 0
    private var _savePendingRevocationCallCount: Int = 0
    private var _loadPendingRevocationCallCount: Int = 0
    private var _deletePendingRevocationCallCount: Int = 0
    private var _wipeAuthNamespaceCallCount: Int = 0

    public init(
        initialTokens: OAuthTokens? = nil,
        initialPendingRevocationToken: String? = nil
    ) {
        self.tokens = initialTokens
        self.pendingRevocationToken = initialPendingRevocationToken
    }

    // MARK: - SecureTokenStore Conformance (sync & non-throwing for Swift 6 compatibility)

    public func saveTokens(_ tokens: OAuthTokens) {
        lock.withCriticalSection {
            self.tokens = tokens
            _saveTokensCallCount += 1
        }
    }

    public func loadTokens() -> OAuthTokens? {
        lock.withCriticalSection {
            _loadTokensCallCount += 1
            return tokens
        }
    }

    public func deleteTokens() {
        lock.withCriticalSection {
            // Preserves pendingRevocationToken for offline revocation & boot-sweep semantics.
            tokens = nil
            _deleteTokensCallCount += 1
        }
    }

    public func savePendingRevocationToken(_ token: String) {
        lock.withCriticalSection {
            // Strictly max-1 slot: overwrites any previous pending revocation token.
            pendingRevocationToken = token
            _pendingRevocationHistory.append(token)
            _savePendingRevocationCallCount += 1
        }
    }

    public func loadPendingRevocationToken() -> String? {
        lock.withCriticalSection {
            _loadPendingRevocationCallCount += 1
            return pendingRevocationToken
        }
    }

    public func deletePendingRevocationToken() {
        lock.withCriticalSection {
            pendingRevocationToken = nil
            _deletePendingRevocationCallCount += 1
        }
    }

    public func snapshotAuthNamespaceKeys() -> Set<String> {
        lock.withCriticalSection {
            var keys = extraNamespaceKeys
            if tokens != nil {
                keys.insert(Self.activeTokensKey)
            }
            if pendingRevocationToken != nil {
                keys.insert(Self.pendingRevocationKey)
            }
            return keys
        }
    }

    public func wipeAuthNamespace() {
        lock.withCriticalSection {
            tokens = nil
            pendingRevocationToken = nil
            extraNamespaceKeys.removeAll()
            _wipeAuthNamespaceCallCount += 1
        }
    }

    // MARK: - Non-Counting Test Inspection & Seeding Helpers

    public var currentTokens: OAuthTokens? {
        lock.withCriticalSection { tokens }
    }

    public var currentPendingRevocationToken: String? {
        lock.withCriticalSection { pendingRevocationToken }
    }

    public var pendingRevocationHistory: [String] {
        lock.withCriticalSection { _pendingRevocationHistory }
    }

    public var saveTokensCallCount: Int {
        lock.withCriticalSection { _saveTokensCallCount }
    }

    public var loadTokensCallCount: Int {
        lock.withCriticalSection { _loadTokensCallCount }
    }

    public var deleteTokensCallCount: Int {
        lock.withCriticalSection { _deleteTokensCallCount }
    }

    public var savePendingRevocationCallCount: Int {
        lock.withCriticalSection { _savePendingRevocationCallCount }
    }

    public var loadPendingRevocationCallCount: Int {
        lock.withCriticalSection { _loadPendingRevocationCallCount }
    }

    public var deletePendingRevocationCallCount: Int {
        lock.withCriticalSection { _deletePendingRevocationCallCount }
    }

    public var wipeAuthNamespaceCallCount: Int {
        lock.withCriticalSection { _wipeAuthNamespaceCallCount }
    }

    public func injectDirtyNamespaceKey(_ key: String) {
        lock.withCriticalSection {
            _ = extraNamespaceKeys.insert(key)
        }
    }

    public func removeDirtyNamespaceKey(_ key: String) {
        lock.withCriticalSection {
            _ = extraNamespaceKeys.remove(key)
        }
    }

    public func reset() {
        lock.withCriticalSection {
            tokens = nil
            pendingRevocationToken = nil
            extraNamespaceKeys.removeAll()
            _pendingRevocationHistory.removeAll()
            _saveTokensCallCount = 0
            _loadTokensCallCount = 0
            _deleteTokensCallCount = 0
            _savePendingRevocationCallCount = 0
            _loadPendingRevocationCallCount = 0
            _deletePendingRevocationCallCount = 0
            _wipeAuthNamespaceCallCount = 0
        }
    }
}
