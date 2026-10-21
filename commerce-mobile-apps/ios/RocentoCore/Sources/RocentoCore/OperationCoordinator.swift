import Foundation

public enum OperationKind: String, Sendable { case initial, refresh, mutation }
public struct OperationLoadingState: Equatable, Sendable {
  public let active: Bool
  public let queued: Int
  public let kind: OperationKind?
  public var busy: Bool { active || queued > 0 }
  public func label(_ locale: String) -> String {
    switch kind {
    case .initial: return locale == "ar" ? "جارٍ التحميل" : "Loading"
    case .refresh: return locale == "ar" ? "جارٍ التحديث" : "Refreshing"
    case .mutation: return locale == "ar" ? "جارٍ حفظ التغييرات" : "Updating"
    case nil: return locale == "ar" ? "في الانتظار" : "Waiting"
    }
  }
}

/// Serializes commerce operations without dropping actions while another request awaits I/O.
/// Callers must not recursively enter the coordinator from an active operation.
@MainActor public final class OperationCoordinator {
  private struct Waiter {
    let id: UUID
    let continuation: CheckedContinuation<Void, Error>
  }
  private var active = false
  private var kind: OperationKind?
  private var waiters: [Waiter] = []
  public var onChange: (() -> Void)?
  public var loading: OperationLoadingState { OperationLoadingState(active: active, queued: waiters.count, kind: kind) }
  public var busy: Bool { loading.busy }
  public var pendingCount: Int { waiters.count }
  public init() {}
  public func invalidatePending() {
    let pending = waiters; waiters = []
    pending.forEach { $0.continuation.resume(throwing: CancellationError()) }
    onChange?()
  }
  public func run<T>(kind: OperationKind = .mutation, _ operation: () async throws -> T) async throws -> T {
    let id = UUID()
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      if active {
        try await withCheckedThrowingContinuation { continuation in
          waiters.append(Waiter(id: id, continuation: continuation)); onChange?()
        }
      } else { active = true; onChange?() }
    } onCancel: {
      Task { @MainActor in
        if let index = self.waiters.firstIndex(where: { $0.id == id }) {
          self.waiters.remove(at: index).continuation.resume(throwing: CancellationError())
          self.onChange?()
        }
      }
    }
    self.kind = kind; onChange?()
    defer {
      self.kind = nil
      if waiters.isEmpty { active = false }
      else { waiters.removeFirst().continuation.resume() }
      onChange?()
    }
    try Task.checkCancellation()
    return try await operation()
  }
}
