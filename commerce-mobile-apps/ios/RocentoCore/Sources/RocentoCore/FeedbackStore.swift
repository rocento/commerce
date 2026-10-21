import Foundation

public enum FailureKind: String, Sendable { case validation, authentication, permission, conflict, rateLimit, server, connection, unknown }
public struct AppFailure: Equatable, Sendable {
  public let kind: FailureKind
  public let message: String
  public let status: Int?
  public static func map(_ error: Error, locale: String = "en") -> AppFailure? {
    if error is CancellationError || (error as? URLError)?.code == .cancelled { return nil }
    let fallback = locale == "ar" ? "تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى." : "Unable to connect. Check your connection and retry."
    if let error = error as? CommerceFailure {
      let kind: FailureKind
      switch error.status {
      case 400, 422: kind = .validation
      case 401: kind = .authentication
      case 403: kind = .permission
      case 409: kind = .conflict
      case 429: kind = .rateLimit
      case 500...599: kind = .server
      default: kind = .unknown
      }
      return AppFailure(kind: kind, message: error.message.isEmpty ? fallback : error.message, status: error.status)
    }
    return AppFailure(kind: error is URLError ? .connection : .unknown, message: fallback, status: nil)
  }
}

/// Presentation feedback only. Never stores exceptions, credentials or retry closures.
@MainActor public final class FeedbackStore {
  public private(set) var failure: AppFailure?
  public private(set) var notice: String?
  public var onChange: (() -> Void)?
  public init() {}
  public func setError(_ message: String?) {
    failure = message.flatMap { $0.isEmpty ? nil : AppFailure(kind: .unknown, message: $0, status: nil) }; onChange?()
  }
  public func setNotice(_ message: String?) { notice = message.flatMap { $0.isEmpty ? nil : $0 }; onChange?() }
  public func clear() { failure = nil; notice = nil; onChange?() }
  /// Explicit caller actions only; errors never automatically retry a write.
  @discardableResult public func perform(using queue: OperationCoordinator, kind: OperationKind = .mutation, locale: String = "en", onUnauthorized: () -> Void = {}, operation: () async throws -> Void) async -> Bool {
    do {
      return try await queue.run(kind: kind) {
        clear()
        do { try await operation(); return true }
        catch {
          guard let mapped = AppFailure.map(error, locale: locale) else { throw error }
          let completedNotice = notice
          if mapped.kind == .authentication { onUnauthorized(); notice = completedNotice }
          failure = mapped; onChange?(); return false
        }
      }
    } catch {
      // The queue throws only cancellation before entering an operation.
      if let mapped = AppFailure.map(error, locale: locale) { failure = mapped; onChange?() }
      return false
    }
  }
}
