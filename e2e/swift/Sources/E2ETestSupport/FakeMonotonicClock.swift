import Foundation
import KioskCore

internal extension NSLock {
    /// Synchronous critical section helper for Swift 6 + Linux portability.
    /// Never call directly from an `async` function body (delegate to a private
    /// synchronous helper method to satisfy Swift 6 `noasync` lock safety).
    @inline(__always)
    func withCriticalSection<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

/// Deterministic virtual monotonic clock conforming to `KioskCore.MonotonicClock`.
///
/// Guarantees exact-once continuation resumption strictly outside `NSLock`,
/// saturating `Int64` time arithmetic, zero leaked waiter entries under
/// concurrent cancellation, and simulated device reboots.
public final class FakeMonotonicClock: MonotonicClock, @unchecked Sendable {
    private enum WaiterState {
        case registering
        case pending(deadlineMs: Int64, continuation: CheckedContinuation<Void, Error>)
        case cancelledBeforeRegistration
    }

    private enum RegistrationOutcome {
        case registered
        case resumeCancelled
    }

    private let lock = NSLock()
    private var currentMonotonicMs: Int64
    private var currentBootSessionId: String
    private var rebootCounter: Int = 1
    private var nextWaiterId: UInt64 = 1
    private var waiters: [UInt64: WaiterState] = [:]
    private var sleepHistoryMs: [Int64] = []

    public init(
        initialMonotonicMs: Int64 = 1_000_000,
        bootSessionId: String = "e2e-boot-session-1"
    ) {
        self.currentMonotonicMs = initialMonotonicMs
        self.currentBootSessionId = bootSessionId
    }

    // MARK: - MonotonicClock Conformance

    public var nowMonotonicMs: Int64 {
        lock.withCriticalSection { currentMonotonicMs }
    }

    public var bootSessionId: String {
        lock.withCriticalSection { currentBootSessionId }
    }

    public func sleep(milliseconds: Int64) async throws {
        try Task.checkCancellation()

        if milliseconds <= 0 {
            recordZeroDurationSleep(milliseconds)
            return
        }

        let waiterId = reserveWaiter(durationMs: milliseconds)

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let outcome = registerContinuation(
                    waiterId: waiterId,
                    milliseconds: milliseconds,
                    continuation: continuation
                )
                if case .resumeCancelled = outcome {
                    continuation.resume(throwing: CancellationError())
                }
            }
        } onCancel: {
            if let cancelledContinuation = cancelWaiter(waiterId: waiterId) {
                cancelledContinuation.resume(throwing: CancellationError())
            }
        }
    }

    // MARK: - Deterministic Time Control

    public func advance(byMs delta: Int64) {
        precondition(delta >= 0, "FakeMonotonicClock.advance(byMs:) requires delta >= 0")

        let readyContinuations: [CheckedContinuation<Void, Error>] = lock.withCriticalSection {
            currentMonotonicMs = Self.saturatingAdd(currentMonotonicMs, delta)

            var due: [(deadline: Int64, id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
            for (id, state) in waiters {
                if case .pending(let deadlineMs, let continuation) = state,
                   deadlineMs <= currentMonotonicMs {
                    due.append((deadlineMs, id, continuation))
                }
            }

            due.sort { lhs, rhs in
                if lhs.deadline != rhs.deadline {
                    return lhs.deadline < rhs.deadline
                }
                return lhs.id < rhs.id
            }

            for item in due {
                waiters.removeValue(forKey: item.id)
            }
            return due.map(\.continuation)
        }

        for continuation in readyContinuations {
            continuation.resume(returning: ())
        }
    }

    public func advanceAndYield(byMs delta: Int64, yields: Int = 8) async {
        advance(byMs: delta)
        let iterations = max(0, yields)
        for _ in 0..<iterations {
            await Task.yield()
        }
    }

    public func simulateReboot(
        newBootSessionId: String? = nil,
        resetUptimeTo uptimeMs: Int64 = 1_000,
        cancelPendingWaiters: Bool = false
    ) {
        let cancelledContinuations: [CheckedContinuation<Void, Error>] = lock.withCriticalSection {
            rebootCounter += 1
            currentBootSessionId = newBootSessionId ?? "e2e-boot-session-\(rebootCounter)"
            currentMonotonicMs = uptimeMs

            guard cancelPendingWaiters else {
                return []
            }
            return drainPendingContinuationsLocked()
        }

        for continuation in cancelledContinuations {
            continuation.resume(throwing: CancellationError())
        }
    }

    public func cancelAllWaiters() {
        let cancelledContinuations: [CheckedContinuation<Void, Error>] = lock.withCriticalSection {
            drainPendingContinuationsLocked()
        }

        for continuation in cancelledContinuations {
            continuation.resume(throwing: CancellationError())
        }
    }

    // MARK: - Test Inspection Helpers

    public var pendingWaiterCount: Int {
        lock.withCriticalSection {
            waiters.values.reduce(into: 0) { count, state in
                if case .pending = state {
                    count += 1
                }
            }
        }
    }

    public var nextWaiterDeadlineMs: Int64? {
        lock.withCriticalSection {
            var earliest: Int64?
            for state in waiters.values {
                if case .pending(let deadlineMs, _) = state {
                    if let current = earliest {
                        earliest = min(current, deadlineMs)
                    } else {
                        earliest = deadlineMs
                    }
                }
            }
            return earliest
        }
    }

    public var recordedSleepDurationsMs: [Int64] {
        lock.withCriticalSection { sleepHistoryMs }
    }

    @discardableResult
    public func waitForPendingWaiters(atLeast count: Int, maxYields: Int = 200) async -> Bool {
        if pendingWaiterCount >= count {
            return true
        }
        let iterations = max(1, maxYields)
        for attempt in 1...iterations {
            await Task.yield()
            if pendingWaiterCount >= count {
                return true
            }
            if attempt % 20 == 0 {
                try? await Task.sleep(nanoseconds: 1_000_000)
                if pendingWaiterCount >= count {
                    return true
                }
            }
        }
        return pendingWaiterCount >= count
    }

    // MARK: - Private Synchronous Lock Helpers (noasync-safe)

    private func recordZeroDurationSleep(_ milliseconds: Int64) {
        lock.withCriticalSection {
            sleepHistoryMs.append(milliseconds)
        }
    }

    private func reserveWaiter(durationMs: Int64) -> UInt64 {
        lock.withCriticalSection {
            sleepHistoryMs.append(durationMs)
            let id = nextWaiterId
            nextWaiterId &+= 1
            waiters[id] = .registering
            return id
        }
    }

    private func registerContinuation(
        waiterId: UInt64,
        milliseconds: Int64,
        continuation: CheckedContinuation<Void, Error>
    ) -> RegistrationOutcome {
        lock.withCriticalSection {
            guard let state = waiters[waiterId] else {
                return .resumeCancelled
            }
            switch state {
            case .cancelledBeforeRegistration:
                waiters.removeValue(forKey: waiterId)
                return .resumeCancelled
            case .registering:
                if Task.isCancelled {
                    waiters.removeValue(forKey: waiterId)
                    return .resumeCancelled
                }
                let deadline = Self.saturatingAdd(currentMonotonicMs, milliseconds)
                waiters[waiterId] = .pending(deadlineMs: deadline, continuation: continuation)
                return .registered
            case .pending:
                return .registered
            }
        }
    }

    private func cancelWaiter(waiterId: UInt64) -> CheckedContinuation<Void, Error>? {
        lock.withCriticalSection {
            guard let state = waiters[waiterId] else {
                return nil
            }
            switch state {
            case .registering:
                waiters[waiterId] = .cancelledBeforeRegistration
                return nil
            case .pending(_, let continuation):
                waiters.removeValue(forKey: waiterId)
                return continuation
            case .cancelledBeforeRegistration:
                return nil
            }
        }
    }

    private func drainPendingContinuationsLocked() -> [CheckedContinuation<Void, Error>] {
        var collected: [(id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
        var keysToRemove: [UInt64] = []

        for (id, state) in waiters {
            switch state {
            case .pending(_, let continuation):
                collected.append((id, continuation))
                keysToRemove.append(id)
            case .registering:
                waiters[id] = .cancelledBeforeRegistration
            case .cancelledBeforeRegistration:
                break
            }
        }

        for id in keysToRemove {
            waiters.removeValue(forKey: id)
        }
        collected.sort { $0.id < $1.id }
        return collected.map(\.continuation)
    }

    private static func saturatingAdd(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        if overflow {
            return rhs >= 0 ? Int64.max : Int64.min
        }
        return sum
    }
}
