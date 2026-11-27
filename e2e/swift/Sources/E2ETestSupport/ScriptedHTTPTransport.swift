import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KioskCore

/// Deterministic scripted `HTTPTransport` double supporting FIFO one-shot queues,
/// persistent host/path/method routes, virtual-clock delays, cancellation tracking,
/// and 401/3xx/5xx/`invalid_grant` fault simulation.
public final class ScriptedHTTPTransport: HTTPTransport, @unchecked Sendable {
    public typealias RequestMatcher = @Sendable (HTTPRequest) -> Bool
    public typealias RequestHandler = @Sendable (HTTPRequest) async throws -> HTTPResponse

    public enum ScriptedTransportError: Error, Sendable, Equatable {
        case unhandledRequest(method: String, url: String)
        case networkUnavailable(String)
        case timedOut
        case cancelled
        case simulatedFailure(String)
    }

    public enum DelayMode: Sendable {
        case none
        case realNanoseconds(UInt64)
        case virtualClock(FakeMonotonicClock, milliseconds: Int64)
    }

    private struct ScriptedEntry: Sendable {
        let matcher: RequestMatcher
        let delay: DelayMode
        let handler: RequestHandler
    }

    private enum ResolvedAction: Sendable {
        case execute(delay: DelayMode, handler: RequestHandler)
        case fail(ScriptedTransportError)
    }

    private let lock = NSLock()
    private var queuedEntries: [ScriptedEntry] = []
    private var persistentRoutes: [ScriptedEntry] = []
    private var defaultEntry: (delay: DelayMode, handler: RequestHandler)?

    private var _recordedRequests: [HTTPRequest] = []
    private var _activeCallCount: Int = 0
    private var _maxConcurrentCallCount: Int = 0
    private var _cancelledCallCount: Int = 0

    public init() {}

    // MARK: - HTTPTransport Conformance

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let action = beginCall(for: request)
        defer { endCall() }

        switch action {
        case .fail(let error):
            throw error
        case .execute(let delay, let handler):
            if Task.isCancelled {
                recordCancellation()
                throw CancellationError()
            }

            do {
                switch delay {
                case .none:
                    break
                case .realNanoseconds(let ns):
                    if ns > 0 {
                        try await Task.sleep(nanoseconds: ns)
                    }
                case .virtualClock(let clock, let ms):
                    try await clock.sleep(milliseconds: ms)
                }

                if Task.isCancelled {
                    throw CancellationError()
                }

                return try await handler(request)
            } catch is CancellationError {
                recordCancellation()
                throw CancellationError()
            }
        }
    }

    // MARK: - Scripting API

    public func enqueue(
        matching matcher: @escaping RequestMatcher = { _ in true },
        delay: DelayMode = .none,
        handler: @escaping RequestHandler
    ) {
        lock.withCriticalSection {
            queuedEntries.append(ScriptedEntry(matcher: matcher, delay: delay, handler: handler))
        }
    }

    public func enqueueResponse(
        _ response: HTTPResponse,
        matching matcher: @escaping RequestMatcher = { _ in true },
        delay: DelayMode = .none
    ) {
        enqueue(matching: matcher, delay: delay) { _ in response }
    }

    public func enqueueResponse(
        forPathContaining pathSubstring: String,
        statusCode: Int = 200,
        headers: [String: String] = ["Content-Type": "application/json"],
        body: Data = Data(),
        delay: DelayMode = .none
    ) {
        enqueue(
            matching: { req in req.url.path.contains(pathSubstring) || req.url.absoluteString.contains(pathSubstring) },
            delay: delay
        ) { req in
            Self.response(for: req, statusCode: statusCode, headers: headers, body: body)
        }
    }

    public func enqueueError(
        _ error: any Error,
        matching matcher: @escaping RequestMatcher = { _ in true },
        delay: DelayMode = .none
    ) {
        enqueue(matching: matcher, delay: delay) { _ in
            throw error
        }
    }

    public func registerRoute(
        matching matcher: @escaping RequestMatcher,
        delay: DelayMode = .none,
        handler: @escaping RequestHandler
    ) {
        lock.withCriticalSection {
            persistentRoutes.append(ScriptedEntry(matcher: matcher, delay: delay, handler: handler))
        }
    }

    public func registerRoute(
        host: String? = nil,
        pathContains: String? = nil,
        method: String? = nil,
        delay: DelayMode = .none,
        handler: @escaping RequestHandler
    ) {
        let normalizedHost = host?.lowercased()
        let normalizedMethod = method?.uppercased()
        registerRoute(
            matching: { req in
                if let normalizedHost, req.url.host?.lowercased() != normalizedHost {
                    return false
                }
                if let pathContains,
                   !req.url.path.contains(pathContains) && !req.url.absoluteString.contains(pathContains) {
                    return false
                }
                if let normalizedMethod, req.method.uppercased() != normalizedMethod {
                    return false
                }
                return true
            },
            delay: delay,
            handler: handler
        )
    }

    public func setDefaultHandler(
        delay: DelayMode = .none,
        _ handler: @escaping RequestHandler
    ) {
        lock.withCriticalSection {
            defaultEntry = (delay: delay, handler: handler)
        }
    }

    // MARK: - Static Response & Fault Builders

    public static func response(
        for request: HTTPRequest,
        statusCode: Int = 200,
        headers: [String: String] = ["Content-Type": "application/json"],
        body: Data = Data(),
        finalURL: URL? = nil
    ) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: headers,
            body: body,
            finalURL: finalURL ?? request.url
        )
    }

    public static func jsonResponse(
        for request: HTTPRequest,
        statusCode: Int = 200,
        jsonString: String,
        headers: [String: String] = [:],
        finalURL: URL? = nil
    ) -> HTTPResponse {
        var merged = headers
        if headerValue(named: "Content-Type", in: merged) == nil {
            merged["Content-Type"] = "application/json"
        }
        return response(
            for: request,
            statusCode: statusCode,
            headers: merged,
            body: Data(jsonString.utf8),
            finalURL: finalURL
        )
    }

    public static func unauthorizedResponse(
        for request: HTTPRequest,
        body: String = #"{"error":"invalid_token"}"#
    ) -> HTTPResponse {
        jsonResponse(for: request, statusCode: 401, jsonString: body)
    }

    public static func redirectResponse(
        for request: HTTPRequest,
        statusCode: Int = 302,
        location: URL,
        extraHeaders: [String: String] = [:]
    ) -> HTTPResponse {
        var headers = extraHeaders
        headers["Location"] = location.absoluteString
        return response(
            for: request,
            statusCode: statusCode,
            headers: headers,
            body: Data(),
            finalURL: request.url
        )
    }

    public static func serverErrorResponse(
        for request: HTTPRequest,
        statusCode: Int = 500,
        body: String = #"{"error":"internal_server_error"}"#
    ) -> HTTPResponse {
        jsonResponse(for: request, statusCode: statusCode, jsonString: body)
    }

    public static func invalidGrantResponse(for request: HTTPRequest) -> HTTPResponse {
        jsonResponse(
            for: request,
            statusCode: 400,
            jsonString: #"{"error":"invalid_grant","error_description":"Refresh token revoked or expired"}"#
        )
    }

    public static func headerValue(named name: String, in headers: [String: String]) -> String? {
        let target = name.lowercased()
        for (key, value) in headers {
            if key.lowercased() == target {
                return value
            }
        }
        return nil
    }

    // MARK: - Inspection & Reset Helpers

    public var recordedRequests: [HTTPRequest] {
        lock.withCriticalSection { _recordedRequests }
    }

    public var requestCount: Int {
        lock.withCriticalSection { _recordedRequests.count }
    }

    public var activeCallCount: Int {
        lock.withCriticalSection { _activeCallCount }
    }

    public var maxConcurrentCallCount: Int {
        lock.withCriticalSection { _maxConcurrentCallCount }
    }

    public var cancelledCallCount: Int {
        lock.withCriticalSection { _cancelledCallCount }
    }

    public func requests(forHost host: String) -> [HTTPRequest] {
        let lower = host.lowercased()
        return lock.withCriticalSection {
            _recordedRequests.filter { $0.url.host?.lowercased() == lower }
        }
    }

    public func requests(withPathContaining substring: String) -> [HTTPRequest] {
        lock.withCriticalSection {
            _recordedRequests.filter {
                $0.url.path.contains(substring) || $0.url.absoluteString.contains(substring)
            }
        }
    }

    public func clearRecordedRequests() {
        lock.withCriticalSection {
            _recordedRequests.removeAll()
            _maxConcurrentCallCount = _activeCallCount
            _cancelledCallCount = 0
        }
    }

    public func reset() {
        lock.withCriticalSection {
            queuedEntries.removeAll()
            persistentRoutes.removeAll()
            defaultEntry = nil
            _recordedRequests.removeAll()
            _activeCallCount = 0
            _maxConcurrentCallCount = 0
            _cancelledCallCount = 0
        }
    }

    // MARK: - Private Synchronous Lock Helpers (noasync-safe)

    private func beginCall(for request: HTTPRequest) -> ResolvedAction {
        lock.withCriticalSection {
            _recordedRequests.append(request)
            _activeCallCount += 1
            if _activeCallCount > _maxConcurrentCallCount {
                _maxConcurrentCallCount = _activeCallCount
            }

            if let idx = queuedEntries.firstIndex(where: { $0.matcher(request) }) {
                let entry = queuedEntries.remove(at: idx)
                return .execute(delay: entry.delay, handler: entry.handler)
            }

            if let route = persistentRoutes.first(where: { $0.matcher(request) }) {
                return .execute(delay: route.delay, handler: route.handler)
            }

            if let fallback = defaultEntry {
                return .execute(delay: fallback.delay, handler: fallback.handler)
            }

            return .fail(.unhandledRequest(method: request.method, url: request.url.absoluteString))
        }
    }

    private func endCall() {
        lock.withCriticalSection {
            _activeCallCount = max(0, _activeCallCount - 1)
        }
    }

    private func recordCancellation() {
        lock.withCriticalSection {
            _cancelledCallCount += 1
        }
    }
}
